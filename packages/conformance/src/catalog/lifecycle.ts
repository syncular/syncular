/**
 * Cursor expiry / pruning horizon (SPEC.md §4.6; Appendix B.8) and the
 * schema floor (§1.6, §2.4).
 */
import { unitId } from '@syncular/core';
import { check, checkEqual } from '../checks';
import { FIXTURE_SCHEMA_V2, task } from '../fixture';
import {
  rawDelete,
  rawPushCommit,
  rawPull,
  rawUpsert,
  responseLive,
  responseSection,
} from '../raw';
import { DEFAULT_NOW_MS, type Scenario, ScenarioSkip } from '../scenario';
import {
  expectConverged,
  seedTasks,
  syncIdle,
  syncOk,
  unitCursor,
} from './util';

const P1 = { project_id: ['p1'] } as const;
const U1 = { project_id: 'p1' } as const;

export const lifecycleScenarios: readonly Scenario[] = [
  {
    // §1.1 FFI hosts: a header question the host never answers fails the
    // request after the fixed 30 s bound with the retryable
    // sync.auth_required instead of hanging; a late answer is ignored and
    // the next request asks again. The pinned client clock runs the bound.
    name: 'auth/native-header-wait-is-bounded',
    specRefs: ['§1.1'],
    async run(ctx) {
      const asked = Promise.withResolvers<void>();
      let late: ((headers: Record<string, string>) => void) | undefined;
      let questions = 0;
      let answering = false;
      const a = await ctx.newClient({
        actorId: 'auth',
        clientId: 'auth-bound',
        allowed: P1,
        nowMs: DEFAULT_NOW_MS,
        auth: {
          headers: () => {
            questions += 1;
            if (answering)
              return Promise.resolve({ authorization: 'Bearer ok' });
            asked.resolve();
            return new Promise((resolve) => {
              late = resolve;
            });
          },
          accepts: () => true,
        },
      });
      if (a.api.setClock === undefined)
        throw new ScenarioSkip('the client host has no bounded header wait');
      await a.api.subscribe(U1);
      const pending = a.api.sync();
      await asked.promise;
      await a.api.setClock(DEFAULT_NOW_MS + 30_001);
      const timedOut = await pending;
      checkEqual(
        timedOut.ok ? 'ok' : [timedOut.errorCode, timedOut.details?.causeKind],
        ['sync.auth_required', 'header_source'],
        'an unanswered question fails after the bound',
      );
      // The late answer is ignored; the next request asks again.
      late?.({ authorization: 'Bearer late' });
      answering = true;
      await syncIdle(a);
      check(questions >= 2, 'the next request asks the source again');
    },
  },
  {
    // §1.1: the transport asks the header source before each request; a 401
    // asks again with the refused headers and resends once; a source that
    // renews to a refused token gives exactly two requests and then the
    // retryable sync.auth_required, and the next attempt asks fresh.
    name: 'auth/header-source-renews-once-after-401',
    specRefs: ['§1.1', '§10.2'],
    async run(ctx) {
      let valid = 'one';
      let renewal = 'one';
      const asked: (string | null)[] = [];
      const presented: string[] = [];
      const contexts: {
        clientId: string;
        round: number | null;
        target: string;
      }[] = [];
      const a = await ctx.newClient({
        actorId: 'auth',
        clientId: 'auth-renewal',
        allowed: P1,
        // The header-source bound reads the pinned client clock (§1.1).
        nowMs: DEFAULT_NOW_MS,
        auth: {
          headers: async (rejected, context) => {
            asked.push(rejected?.authorization ?? null);
            contexts.push(context);
            return {
              authorization: `Bearer ${rejected === undefined ? 'one' : renewal}`,
            };
          },
          accepts: (headers) => {
            presented.push(headers.authorization ?? '');
            return headers.authorization === `Bearer ${valid}`;
          },
        },
      });
      await a.api.subscribe(U1);
      await syncIdle(a);
      check(asked.length > 0, 'every request asks the source');
      check(
        contexts.every(
          (context) =>
            context.clientId === 'auth-renewal' &&
            context.target === 'sync' &&
            context.round !== null,
        ),
        'each question names the replica, its round and the sync target',
      );
      checkEqual(
        asked.filter((value) => value !== null),
        [],
        'an accepted bearer is never renewed',
      );

      // The token expires: the first request is refused, the renewal passes.
      valid = 'two';
      renewal = 'two';
      asked.length = 0;
      presented.length = 0;
      await seedTasks(ctx, [task('t1', 'p1', 'after renewal')]);
      await syncIdle(a);
      checkEqual(
        presented.slice(0, 2),
        ['Bearer one', 'Bearer two'],
        'the refused request is resent once with the renewed bearer',
      );
      checkEqual(
        asked.slice(0, 2),
        [null, 'Bearer one'],
        'the renewal question carries the refused headers',
      );
      checkEqual(
        (await a.api.readRows('tasks')).map((row) => row.rowId),
        ['t1'],
        'the renewed round applies',
      );

      // A source that renews to a refused token: two requests, then the error.
      valid = 'three';
      asked.length = 0;
      presented.length = 0;
      const refused = await a.api.sync();
      checkEqual(
        refused.ok ? 'ok' : refused.errorCode,
        'sync.auth_required',
        'the second refusal surfaces',
      );
      checkEqual(
        presented,
        ['Bearer one', 'Bearer two'],
        'exactly two requests, no loop',
      );
      checkEqual(asked, [null, 'Bearer one'], 'one renewal per attempt');

      // The next attempt asks the source fresh.
      renewal = 'three';
      asked.length = 0;
      await syncIdle(a);
      checkEqual(
        asked.slice(0, 2),
        [null, 'Bearer one'],
        'the next attempt asks again',
      );
    },
  },
  {
    name: 'security/authority-snapshot-preflight-base-intent-and-scope-loss',
    specRefs: ['§5.11', '§7.5'],
    requires: ['scope-authorization'],
    async run(ctx) {
      const a = await ctx.newClient({
        actorId: 'authority',
        clientId: 'authority',
        allowed: P1,
        authorityReads: [
          {
            table: 'tasks',
            columns: ['id', 'project_id', 'title'],
            scopes: P1,
          },
        ],
      });
      checkEqual(
        (await a.api.authoritySnapshot()).tables[0]?.coverage,
        'missing',
        'unregistered coverage is explicit',
      );
      await seedTasks(ctx, [task('t1', 'p1', 'accepted')]);
      await a.api.subscribe(U1);
      checkEqual(
        (await a.api.authoritySnapshot()).tables[0]?.coverage,
        'pending',
        'registration is incomplete',
      );
      await syncIdle(a);
      await a.api.setTransportEnabled(false);
      await a.api.mutate([
        {
          op: 'patch',
          table: 'tasks',
          values: { id: 't1', title: 'unaccepted' },
        },
        { op: 'upsert', table: 'tasks', values: task('local', 'p1', 'local') },
      ]);
      await a.api.beginSecurityPreflight();
      const revision = await a.api.localRevision!();
      const snapshot = await a.api.authoritySnapshot();
      checkEqual(
        snapshot.revision,
        revision,
        'read revision is the committed revision',
      );
      check(
        snapshot.complete,
        'completed accepted coverage survives preflight',
      );
      checkEqual(
        snapshot.tables[0]?.rows,
        [
          {
            values: { id: 't1', project_id: 'p1', title: 'accepted' },
            version: 1,
            hasLocalIntent: true,
          },
        ],
        'base is distinct from edit and local creation',
      );
      checkEqual(
        snapshot.tables[0]?.localIntentRowIds,
        ['local', 't1'],
        'only intent identifiers are exposed',
      );
      checkEqual(
        await a.api.localRevision!(),
        revision,
        'snapshot writes nothing',
      );
      let code = '';
      try {
        await a.api.mutate([{ op: 'delete', table: 'tasks', rowId: 't1' }]);
      } catch (e) {
        code = (e as { code: string }).code;
      }
      checkEqual(
        code,
        'client.security_preflight_required',
        'writes remain closed',
      );
      await a.api.activateSecurity();
      await a.api.setTransportEnabled(true);
      await ctx.server.setAllowedScopes('authority', {});
      await syncIdle(a);
      await a.api.setTransportEnabled(false);
      await a.api.beginSecurityPreflight();
      const revoked = await a.api.authoritySnapshot();
      check(!revoked.complete, 'scope loss invalidates completeness');
      checkEqual(
        revoked.tables[0]?.rows,
        [],
        'revoked base and intent disappear',
      );
    },
  },
  {
    name: 'security/authority-snapshot-static-policy-and-empty-preflight',
    specRefs: ['§5.11'],
    async run(ctx) {
      const a = await ctx.newClient({
        actorId: 'preflight',
        clientId: 'preflight',
        allowed: P1,
        securityPreflight: true,
        transportEnabled: false,
        authorityReads: [
          { table: 'tasks', columns: ['id', 'project_id'], scopes: P1 },
        ],
      });
      const snapshot = await a.api.authoritySnapshot();
      check(!snapshot.complete, 'empty replica has no coverage proof');
      checkEqual(snapshot.tables[0]?.rows, [], 'empty evidence is explicit');
      checkEqual(
        a.sentRequests.length,
        0,
        'snapshot does not invoke transport',
      );
      for (const columns of [
        ['id', 'project_id', 'missing'],
        ['id', 'project_id', 'id FROM tasks; DELETE FROM tasks'],
        ['id', 'project_id', '_sync_version'],
      ]) {
        let code = '';
        try {
          await ctx.newClient({
            actorId: 'forbidden',
            clientId: 'forbidden',
            securityPreflight: true,
            transportEnabled: false,
            authorityReads: [{ table: 'tasks', columns, scopes: P1 }],
          });
        } catch (e) {
          code = (e as { code: string }).code;
        }
        checkEqual(
          code,
          'client.authority_read_forbidden',
          'only static schema-approved plain columns pass',
        );
      }
    },
  },
  {
    name: 'lifecycle/pruning-during-pull-resets-and-rebootstraps',
    specRefs: ['§4.6', '§4.7'],
    requires: ['concurrent-storage-faults'],
    async run(ctx) {
      await seedTasks(ctx, [task('t1', 'p1', 'before')]);
      const client = await ctx.newClient({
        actorId: 'reader',
        clientId: 'reader',
        allowed: P1,
      });
      await client.api.subscribe(U1);
      await syncIdle(client);
      await seedTasks(ctx, [task('t2', 'p1', 'pruned')]);
      await ctx.server.pruneDuringNextCommitRead!();
      const reset = await syncOk(client);
      checkEqual(
        reset.commitsApplied,
        0,
        'an incomplete window applies no commits',
      );
      checkEqual(
        await unitCursor(client, U1),
        -1,
        'reset discards the expired cursor',
      );
      checkEqual(
        reset.resets,
        [unitId(U1)],
        'the round reports required bootstrap recovery',
      );
      await syncIdle(client);
      await expectConverged(ctx, 'tasks', [client], {
        variable: 'project_id',
        values: ['p1'],
      });
      checkEqual(
        (await client.api.readRows('tasks')).length,
        2,
        'bootstrap recovers the pruned row',
      );
    },
  },
  {
    name: 'cursor/horizon-reset-rebootstrap-and-boundary',
    specRefs: ['§4.6', '§4.7', '§5.6', 'B.8'],
    async run(ctx) {
      // A client converges, then goes absent while the log moves on.
      const a = await ctx.newClient({
        actorId: 'actor-a',
        clientId: 'client-a',
        allowed: P1,
      });
      await seedTasks(ctx, [task('t1', 'p1', 'old'), task('t2', 'p1', 'old')]);
      await a.api.subscribe(U1);
      await syncIdle(a);

      await ctx.server.setAllowedScopes('seed-actor', {
        project_id: ['*'],
        projectId: ['*'],
        org_id: ['*'],
      });
      await ctx.rawSync('seed-actor', [
        rawPushCommit('prune-1', [rawDelete('tasks', 't1')]),
      ]);
      await ctx.rawSync('seed-actor', [
        rawPushCommit('prune-2', [
          rawUpsert(ctx.schema, 'tasks', task('t2', 'p1', 'new')),
        ]),
      ]);
      await ctx.rawSync('seed-actor', [
        rawPushCommit('prune-3', [
          rawUpsert(ctx.schema, 'tasks', task('t3', 'p1', 'new')),
        ]),
      ]);
      const maxSeq = await ctx.server.getMaxCommitSeq();

      // Aggressive host policy prunes the whole log (floors zeroed).
      await ctx.server.advanceClock(60 * 60 * 1000);
      const horizon = await ctx.server.prune({
        activeWindowMs: 0,
        ageForceMs: 0,
        minRetainedCommits: 0,
      });
      checkEqual(horizon, maxSeq, 'the horizon advanced past the log');

      // The returning client resets, discards its cursor, re-bootstraps —
      // and the fresh bootstrap's first-page clear removes the locally
      // stale t1 (§5.6): reset is staleness, revoked is the only purge.
      const first = await syncOk(a);
      check(first.resets.includes(unitId(U1)), 'reset delivered (§4.6)');
      await syncIdle(a);
      // Versions compare too: the re-bootstrap's segment row records
      // carry the rows' server_version (§5.2/§5.6).
      await expectConverged(ctx, 'tasks', [a], {
        variable: 'project_id',
        values: ['p1'],
      });
      checkEqual(
        (await a.api.readRows('tasks')).map((row) => row.rowId),
        ['t2', 't3'],
        'stale t1 did not survive the re-bootstrap',
      );

      // Boundary condition: cursor EXACTLY at the horizon still pulls
      // incrementally — no reset, no re-bootstrap.
      await ctx.server.setAllowedScopes('bd-actor', P1);
      await ctx.rawSync('seed-actor', [
        rawPushCommit('post-horizon', [
          rawUpsert(ctx.schema, 'tasks', task('t4', 'p1', 'boundary')),
        ]),
      ]);
      const boundary = await ctx.rawSync(
        'bd-actor',
        [...rawPull([{ scopes: U1, cursor: horizon }])],
        { clientId: 'bd-client' },
      );
      check(boundary.ok, 'boundary pull succeeded');
      if (!boundary.ok) return;
      const section = responseSection(boundary.message, U1);
      checkEqual(
        section.start.status,
        'active',
        'cursor = horizon is servable',
      );
      checkEqual(
        responseLive(boundary.message).commits.length,
        1,
        'the post-horizon commit arrived incrementally',
      );

      // Retention floor: the newest-1000 floor blocks further advance even
      // under the same aggressive age policy (§4.6).
      const before = await ctx.server.getHorizonSeq();
      await ctx.server.advanceClock(60 * 60 * 1000);
      const after = await ctx.server.prune({
        activeWindowMs: 0,
        ageForceMs: 0,
        minRetainedCommits: 1000,
      });
      checkEqual(
        after,
        before,
        'the min-retained floor held the horizon in place',
      );
    },
  },

  {
    name: 'schema/floor-response-processes-nothing',
    specRefs: ['§1.6', '§2.4', '§9'],
    server: { schema: FIXTURE_SCHEMA_V2 },
    async run(ctx) {
      // Client at schema 1, server serving only schema 2.
      const a = await ctx.newClient({
        actorId: 'actor-a',
        clientId: 'client-a',
        allowed: P1,
      });
      await a.api.subscribe(U1);
      const m1 = await a.api.mutate([
        { op: 'upsert', table: 'tasks', values: task('t1', 'p1', 'held') },
      ]);

      const report = await syncOk(a);
      checkEqual(
        report.schemaFloor?.requiredSchemaVersion,
        2,
        'the floor names the required version',
      );
      checkEqual(report.applied.length, 0, 'no push result was produced');
      checkEqual(
        await ctx.server.getMaxCommitSeq(),
        0,
        'the push half was NOT attempted — the floor response processes nothing (§1.6)',
      );
      checkEqual(
        await a.api.pendingCommitIds(),
        [m1],
        'the outbox is preserved for replay after the upgrade',
      );
      checkEqual(await unitCursor(a, U1), -1, 'no subscription was answered');

      // The client is stopped until an upgrade: further syncs are inert.
      const second = await syncOk(a);
      checkEqual(second.pushed, 0, 'syncing stopped client-side');
      check(
        (await a.api.schemaFloor()) !== undefined,
        'the upgrade requirement is surfaced to the app',
      );
    },
  },
];
