/**
 * Cursor expiry / pruning horizon (SPEC.md §4.6; Appendix B.8) and the
 * schema floor (§1.6, §2.4).
 */
import { check, checkEqual } from '../checks';
import { FIXTURE_SCHEMA_V2, task } from '../fixture';
import {
  rawDelete,
  rawPullHeader,
  rawPushCommit,
  rawSubscription,
  rawUpsert,
  responseSection,
} from '../raw';
import type { Scenario } from '../scenario';
import { expectConverged, seedTasks, syncIdle, syncOk } from './util';

const P1 = { project_id: ['p1'] } as const;

export const lifecycleScenarios: readonly Scenario[] = [
  {
    name: 'subscription/identity-is-immutable-and-idempotent',
    specRefs: ['§4.1', '§7.5'],
    async run(ctx) {
      const a = await ctx.newClient({
        actorId: 'actor-a',
        clientId: 'client-a',
        allowed: { project_id: ['p1', 'p2'], org_id: ['o1'] },
      });
      await a.api.subscribe({
        id: 'stable-subscription',
        table: 'tasks',
        scopes: { project_id: ['p2', 'p1'] },
        params: '{"view":"v1"}',
      });
      await syncIdle(a);
      const complete = await a.api.subscriptionState('stable-subscription');
      check(
        complete !== undefined && complete.cursor >= 0,
        'the original subscription completed',
      );

      // Canonically identical values are one intent even if the host repeats
      // or reorders them. Progress must not reset on a React remount/restart.
      await a.api.subscribe({
        id: 'stable-subscription',
        table: 'tasks',
        scopes: { project_id: ['p1', 'p2', 'p1'] },
        params: '{"view":"v1"}',
      });
      checkEqual(
        await a.api.subscriptionState('stable-subscription'),
        complete,
        'an identical re-declaration retains exact progress',
      );

      const mismatches = [
        {
          id: 'stable-subscription',
          table: 'tasks',
          scopes: { project_id: ['p1'] },
          params: '{"view":"v1"}',
        },
        {
          id: 'stable-subscription',
          table: 'tasks',
          scopes: { project_id: ['p2', 'p1'] },
          params: '{"view":"v2"}',
        },
        {
          id: 'stable-subscription',
          table: 'docs',
          scopes: { org_id: ['o1'], projectId: ['p1'] },
          params: '{"view":"v1"}',
        },
      ] as const;
      for (const mismatch of mismatches) {
        let code = '';
        try {
          await a.api.subscribe(mismatch);
        } catch (error) {
          code = (error as { code?: string }).code ?? '';
        }
        checkEqual(
          code,
          'client.subscription_intent_mismatch',
          'a changed table, scope, or params fails with the stable client code',
        );
        checkEqual(
          await a.api.subscriptionState('stable-subscription'),
          complete,
          'a rejected rebind cannot alter prior subscription evidence',
        );
      }
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
      await a.api.subscribe({ id: 'tasks', table: 'tasks', scopes: P1 });
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
      check(first.resets.includes('tasks'), 'reset delivered (§4.6)');
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
        [rawPullHeader(), rawSubscription('s1', 'tasks', P1, horizon)],
        { clientId: 'bd-client' },
      );
      check(boundary.ok, 'boundary pull succeeded');
      if (!boundary.ok) return;
      const section = responseSection(boundary.message, 's1');
      checkEqual(
        section.start.status,
        'active',
        'cursor = horizon is servable',
      );
      checkEqual(
        section.body.filter((frame) => frame.type === 'COMMIT').length,
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
      await a.api.subscribe({ id: 'tasks', table: 'tasks', scopes: P1 });
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
      checkEqual(
        (await a.api.subscriptionState('tasks'))?.cursor,
        -1,
        'no subscription was answered',
      );

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
