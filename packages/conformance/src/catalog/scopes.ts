/**
 * Scope grant, revocation + purge, write-path authorization, and segment
 * re-authorization (SPEC.md §3, §5.5; Appendix B.4). Scopes are the
 * crown jewels — these scenarios pin fail-loud and fail-closed behavior.
 */
import { canonicalScopeJson } from '@syncular/core';
import { check, checkEqual } from '../checks';
import { ScenarioSkip } from '../scenario';
import type { DriverSchema, DriverTable } from '../driver';
import { ALL_SCOPES, doc, FIXTURE_SCHEMA, task } from '../fixture';
import {
  rawDelete,
  rawPullHeader,
  rawPushCommit,
  rawSubscription,
  rawUpsert,
  responsePushResults,
  responseSection,
} from '../raw';
import type { Scenario } from '../scenario';
import { seedRows, seedTasks, syncIdle, syncOk } from './util';

const ALTERNATIVE_WRITE_SCHEMA: DriverSchema = {
  version: 1,
  tables: [
    FIXTURE_SCHEMA.tables[0]!,
    ...['calendars', 'theatres'].map(
      (name): DriverTable => ({
        name,
        columns: [
          { name: 'id', type: 'string', nullable: false },
          { name: 'org_id', type: 'string', nullable: false },
          { name: 'project_id', type: 'string', nullable: false },
          { name: 'body', type: 'string', nullable: false },
        ],
        primaryKey: 'id',
        scopes: [
          { pattern: 'org:{org_id}' },
          { pattern: 'project:{projectId}', column: 'project_id' },
        ],
        writeScopeVariables: ['org_id'],
      }),
    ),
  ],
};

/** A table whose scope column is an INTEGER (§2.4); scope values are text. */
const INTEGER_SCOPE_SCHEMA: DriverSchema = {
  version: 1,
  tables: [
    {
      name: 'buckets',
      columns: [
        { name: 'id', type: 'string', nullable: false },
        { name: 'bucket', type: 'integer', nullable: false },
        { name: 'body', type: 'string', nullable: false },
      ],
      primaryKey: 'id',
      scopes: [{ pattern: 'bucket:{bucket}' }],
    },
  ],
};

export const scopeScenarios: readonly Scenario[] = [
  {
    name: 'scopes/partial-window-coverage-and-intersection',
    specRefs: ['§3.2', '§3.3', '§4.8', '§7.5'],
    requires: ['scope-authorization'],
    server: { schema: ALTERNATIVE_WRITE_SCHEMA },
    async run(ctx) {
      await ctx.server.setAllowedScopes('window-seed', {
        org_id: ['o1', 'o2'],
      });
      for (const table of ['calendars', 'theatres']) {
        const response = await ctx.rawSync(
          'window-seed',
          [
            rawPushCommit(
              `seed-${table}`,
              [
                doc('old', 'o1', 'old', 'referenced'),
                doc('other', 'o1', 'other', 'unreferenced'),
                doc('foreign', 'o2', 'foreign', 'private'),
              ].map((row) => rawUpsert(ctx.serverSchema, table, row)),
            ),
          ],
          { clientId: 'window-seed' },
        );
        check(response.ok, 'the rows are seeded');
      }
      const host = await ctx.newClient({
        actorId: 'window-host',
        clientId: 'window-host',
        schema: ALTERNATIVE_WRITE_SCHEMA,
        allowed: { org_id: ['o1'] },
      });
      const reader = await ctx.newClient({
        actorId: 'window-reader',
        clientId: 'window-reader',
        schema: ALTERNATIVE_WRITE_SCHEMA,
        allowed: { projectId: ['old'] },
      });
      const intersection = await ctx.newClient({
        actorId: 'window-intersection',
        clientId: 'window-intersection',
        schema: ALTERNATIVE_WRITE_SCHEMA,
        allowed: { org_id: ['o1'], projectId: ['old'] },
      });
      check(
        host.api.setWindow !== undefined && host.api.snapshotRead !== undefined,
        'window and snapshot APIs are available',
      );
      check(
        reader.api.setWindow !== undefined &&
          intersection.api.setWindow !== undefined,
        'reader windows are available',
      );
      if (
        !host.api.setWindow ||
        !host.api.snapshotRead ||
        !reader.api.setWindow ||
        !intersection.api.setWindow
      )
        return;
      for (const table of ['calendars', 'theatres']) {
        const facility = { table, variable: 'org_id' };
        const exact = { table, variable: 'projectId' };
        const both = {
          table,
          variable: 'org_id',
          fixedScopes: { projectId: ['old'] },
        };
        await host.api.setWindow(facility, ['o1']);
        await reader.api.setWindow(exact, ['old']);
        await intersection.api.setWindow(both, ['o1']);
        const before = await host.api.snapshotRead({
          statements: [],
          coverage: [{ base: facility, units: ['o1'] }],
        });
        check(
          !before.coverage.complete,
          'an unbootstrapped facility window is incomplete',
        );
      }
      await syncIdle(host);
      await syncIdle(reader);
      await syncIdle(intersection);
      for (const table of ['calendars', 'theatres']) {
        const facility = { table, variable: 'org_id' };
        const ready = await host.api.snapshotRead({
          statements: [],
          coverage: [{ base: facility, units: ['o1'] }],
        });
        check(ready.coverage.complete, 'the facility window becomes complete');
        checkEqual(
          (await host.api.readRows(table)).map((row) => row.rowId),
          ['old', 'other'],
          'facility coverage excludes foreign rows',
        );
        checkEqual(
          (await reader.api.readRows(table)).map((row) => row.rowId),
          ['old'],
          'exact historical coverage stays narrow',
        );
        checkEqual(
          (await intersection.api.readRows(table)).map((row) => row.rowId),
          ['old'],
          'bound dimensions retain intersection semantics',
        );
        await host.api.mutate([
          { op: 'upsert', table, values: doc('new', 'o1', 'new', 'offline') },
        ]);
      }
      await syncIdle(host);
      await syncIdle(reader);
      await syncIdle(intersection);
      checkEqual(
        (await reader.api.readRows('calendars')).map((row) => row.rowId),
        ['old'],
        'new facility rows do not reach exact readers',
      );
      checkEqual(
        (await intersection.api.readRows('calendars')).map((row) => row.rowId),
        ['old'],
        'new facility rows do not widen an intersection',
      );
      await ctx.recreateClient(host, ALTERNATIVE_WRITE_SCHEMA);
      await syncIdle(host);
      checkEqual(
        (await host.api.readRows('calendars')).map((row) => row.rowId),
        ['new', 'old', 'other'],
        'restart keeps the facility window',
      );
      await ctx.server.setAllowedScopes('window-host', { org_id: [] });
      await syncOk(host);
      check(host.api.snapshotRead !== undefined, 'snapshot survives restart');
      if (!host.api.snapshotRead) return;
      const revoked = await host.api.snapshotRead({
        statements: [],
        coverage: [
          { base: { table: 'calendars', variable: 'org_id' }, units: ['o1'] },
        ],
      });
      check(!revoked.coverage.complete, 'revoked coverage is incomplete');
      checkEqual(
        await host.api.readRows('calendars'),
        [],
        'revocation removes facility rows',
      );
      await syncIdle(reader);
      checkEqual(
        (await reader.api.readRows('calendars')).map((row) => row.rowId),
        ['old'],
        'facility revocation leaves the exact reader intact',
      );
    },
  },
  {
    name: 'scopes/independent-read-and-write-scopes',
    specRefs: ['§3.2', '§3.3', '§3.4', '§6.2'],
    requires: ['scope-authorization'],
    server: { schema: ALTERNATIVE_WRITE_SCHEMA },
    async run(ctx) {
      await ctx.server.setAllowedScopes('alternative-seed', {
        org_id: ['o1', 'o2'],
      });
      for (const table of ['calendars', 'theatres']) {
        const seeded = await ctx.rawSync(
          'alternative-seed',
          [
            rawPushCommit(
              `seed-${table}`,
              [
                doc('old', 'o1', 'old', 'referenced'),
                doc('other', 'o1', 'other', 'unreferenced'),
                doc('foreign', 'o2', 'foreign', 'private'),
              ].map((row) => rawUpsert(ctx.serverSchema, table, row)),
            ),
          ],
          { clientId: 'alternative-seed' },
        );
        check(seeded.ok, 'seed request succeeds');
        if (!seeded.ok) return;
        checkEqual(
          responsePushResults(seeded.message)[0]?.status,
          'applied',
          'facility grants seed both facilities',
        );
      }
      const host = await ctx.newClient({
        actorId: 'host',
        clientId: 'host',
        schema: ALTERNATIVE_WRITE_SCHEMA,
        allowed: { org_id: ['o1'] },
        retainFailedCommits: true,
      });
      const reader = await ctx.newClient({
        actorId: 'reader',
        clientId: 'reader',
        schema: ALTERNATIVE_WRITE_SCHEMA,
        allowed: { projectId: ['old'] },
      });
      const rival = await ctx.newClient({
        actorId: 'rival',
        clientId: 'rival',
        schema: ALTERNATIVE_WRITE_SCHEMA,
        allowed: { org_id: ['o1'] },
        retainFailedCommits: true,
      });
      for (const table of ['calendars', 'theatres']) {
        await host.api.subscribe({
          id: table,
          table,
          scopes: { org_id: ['o1'] },
        });
        await reader.api.subscribe({
          id: table,
          table,
          scopes: { projectId: ['old'] },
        });
        await rival.api.subscribe({
          id: table,
          table,
          scopes: { org_id: ['o1'] },
        });
      }
      await syncIdle(host);
      await syncIdle(reader);
      await syncIdle(rival);
      for (const table of ['calendars', 'theatres']) {
        checkEqual(
          (await reader.api.readRows(table)).map((row) => row.rowId),
          ['old'],
          'exact reader sees one row',
        );
        checkEqual(
          (await host.api.readRows(table)).map((row) => row.rowId),
          ['old', 'other'],
          'host sees only its facility',
        );
        await host.api.mutate([
          { op: 'upsert', table, values: doc('new', 'o1', 'new', 'offline') },
        ]);
      }
      await syncIdle(host);
      await syncIdle(reader);
      for (const table of ['calendars', 'theatres']) {
        checkEqual(
          (await reader.api.readRows(table)).map((row) => row.rowId),
          ['old'],
          'new rows stay outside exact read',
        );
        checkEqual(
          (await host.api.readRows(table)).map((row) => row.rowId),
          ['new', 'old', 'other'],
          'offline insert reaches host',
        );
        const denied = await host.api.mutate([
          {
            op: 'upsert',
            table,
            values: doc('foreign', 'o1', 'foreign', 'attack'),
          },
        ]);
        checkEqual(
          (await syncOk(host)).rejected,
          [denied],
          'foreign insert race is denied',
        );
        checkEqual(
          (await host.api.rejections()).find((r) => r.clientCommitId === denied)
            ?.code,
          'sync.forbidden',
          'foreign row is not disclosed',
        );
        checkEqual(
          (await host.api.commitOutcomes()).find(
            (r) => r.clientCommitId === denied,
          )?.status,
          'rejected',
          'failed intent is retained',
        );
        checkEqual(
          (await host.api.readRows(table)).find(
            (row) => row.rowId === 'foreign',
          )?.values.body,
          'attack',
          'retained intent contains no foreign server row',
        );
        await host.api.resolveCommitOutcome(denied, 'resolved_keep_server');
        const readerWrite = await reader.api.mutate([
          {
            op: 'upsert',
            table,
            values: doc('old', 'o1', 'old', 'reader edit'),
          },
        ]);
        checkEqual(
          (await syncOk(reader)).rejected,
          [readerWrite],
          'exact read grant does not authorize writes',
        );
        await host.api.mutate([
          { op: 'upsert', table, values: doc('old', 'o1', 'old', 'host edit') },
        ]);
        await syncIdle(host);
        checkEqual(
          (await ctx.server.readRows(table)).find((row) => row.rowId === 'old')
            ?.values.body,
          'host edit',
          'facility write updates an existing row',
        );
        await host.api.mutate([
          {
            op: 'upsert',
            table,
            values: doc('race', 'o1', 'race', 'winner'),
            baseVersion: 0,
          },
        ]);
        const losing = await rival.api.mutate([
          {
            op: 'upsert',
            table,
            values: doc('race', 'o1', 'race', 'loser'),
            baseVersion: 0,
          },
        ]);
        await syncIdle(host);
        checkEqual(
          (await syncOk(rival)).rejected,
          [losing],
          'concurrent insert returns a conflict',
        );
        checkEqual(
          (await rival.api.conflicts()).find(
            (conflict) => conflict.clientCommitId === losing,
          )?.serverRow?.body,
          'winner',
          'authorized conflict carries the winner',
        );
      }
      check(host.api.recreateWithSchema !== undefined, 'restart supported');
      await ctx.recreateClient(host, ALTERNATIVE_WRITE_SCHEMA);
      await syncIdle(host);
      checkEqual(
        (await host.api.readRows('calendars')).map((row) => row.rowId),
        ['new', 'old', 'other', 'race'],
        'restart preserves authorized data',
      );
      await ctx.server.setAllowedScopes('raw-host', { org_id: ['o1'] });
      const conflict = rawPushCommit('cached-conflict', [
        rawUpsert(
          ctx.serverSchema,
          'calendars',
          doc('old', 'o1', 'old', 'mine'),
          0,
        ),
      ]);
      const first = await ctx.rawSync('raw-host', [conflict], {
        clientId: 'raw-host',
      });
      check(first.ok, 'initial conflict request succeeds');
      if (!first.ok) return;
      checkEqual(
        responsePushResults(first.message)[0]?.results[0]?.status,
        'conflict',
        'authorized conflict includes snapshot',
      );
      await ctx.server.setAllowedScopes('raw-host', { org_id: ['o2'] });
      const replay = await ctx.rawSync('raw-host', [conflict], {
        clientId: 'raw-host',
      });
      check(replay.ok, 'revoked conflict replay succeeds');
      if (!replay.ok) return;
      checkEqual(
        responsePushResults(replay.message)[0]?.results[0]?.status,
        'error',
        'revoked replay contains no conflict row',
      );
      await ctx.server.setAllowedScopes('raw-host', { org_id: ['o1'] });
      const restored = await ctx.rawSync('raw-host', [conflict], {
        clientId: 'raw-host',
      });
      check(restored.ok, 'restored conflict replay succeeds');
      if (!restored.ok) return;
      checkEqual(
        responsePushResults(restored.message)[0]?.results[0]?.status,
        'conflict',
        'restored grant returns the original conflict',
      );
      await ctx.server.setAllowedScopes('host', { org_id: [] });
      const pending = await host.api.mutate([
        {
          op: 'upsert',
          table: 'calendars',
          values: doc('after-loss', 'o1', 'after-loss', 'offline'),
        },
      ]);
      const revoked = await syncOk(host);
      check(
        revoked.revoked.includes('calendars'),
        'facility subscription revoked',
      );
      check(
        !(await ctx.server.readRows('calendars')).some(
          (row) => row.rowId === 'after-loss',
        ),
        'revoked write did not reach the server',
      );
      check(
        !(await host.api.pendingCommitIds()).includes(pending),
        'revoked write leaves the outbox',
      );
    },
  },
  {
    name: 'scopes/effective-is-requested-intersect-allowed',
    specRefs: ['§3.2'],
    requires: ['scope-authorization'],
    async run(ctx) {
      const a = await ctx.newClient({
        actorId: 'actor-a',
        clientId: 'client-a',
        allowed: { project_id: ['p1'] },
      });
      await seedTasks(ctx, [task('t1', 'p1'), task('t2', 'p2')]);
      // Requested wider than allowed: the intersection filters delivery.
      await a.api.subscribe({
        id: 'tasks',
        table: 'tasks',
        scopes: { project_id: ['p1', 'p2'] },
      });
      await syncIdle(a);
      checkEqual(
        (await a.api.readRows('tasks')).map((row) => row.rowId),
        ['t1'],
        'only rows inside the effective grant were delivered',
      );
      const state = await a.api.subscriptionState('tasks');
      checkEqual(
        state?.effectiveScopes,
        { project_id: ['p1'] },
        'the effective scopes were echoed and persisted (§3.2 rule 6)',
      );
    },
  },

  {
    name: 'scopes/paired-parent-scope-fences-child-wildcard',
    specRefs: ['§3.2', '§3.4'],
    requires: ['scope-authorization'],
    async run(ctx) {
      const a = await ctx.newClient({
        actorId: 'actor-a',
        clientId: 'client-a',
        allowed: { org_id: ['o1'], projectId: ['*'] },
      });
      await seedRows(ctx, 'docs', [
        doc('inside', 'o1', 'p1', 'inside parent'),
        doc('outside-same-child', 'o2', 'p1', 'outside parent'),
        doc('inside-other-child', 'o1', 'p2', 'other child'),
      ]);
      await a.api.subscribe({
        id: 'docs',
        table: 'docs',
        scopes: { org_id: ['o1'], projectId: ['p1', 'p2'] },
      });
      await syncIdle(a);
      checkEqual(
        (await a.api.readRows('docs')).map((row) => row.rowId),
        ['inside', 'inside-other-child'],
        'the parent scope excludes an out-of-parent row even when its child value is wildcard-authorized',
      );

      const outside = await a.api.mutate([
        {
          op: 'upsert',
          table: 'docs',
          values: doc('outside-write', 'o2', 'p1', 'must reject'),
        },
      ]);
      const denied = await syncOk(a);
      checkEqual(
        denied.rejected,
        [outside],
        'the same paired scope denies an out-of-parent write',
      );
      checkEqual(
        (await a.api.rejections())[0]?.code,
        'sync.forbidden',
        'the paired-scope write denial is explicit',
      );
      check(
        !(await ctx.server.readRows('docs')).some(
          (row) => row.rowId === 'outside-write',
        ),
        'the denied cross-parent row never reaches authoritative storage',
      );
    },
  },

  {
    name: 'scopes/wildcard-fence-adds-omitted-variables',
    specRefs: ['§3.2'],
    requires: ['scope-authorization'],
    async run(ctx) {
      await seedRows(ctx, 'docs', [
        doc('inside', 'o1', 'p1', 'inside parent'),
        doc('outside-same-child', 'o2', 'p1', 'outside parent'),
        doc('inside-other-child', 'o1', 'p2', 'other child'),
      ]);
      const fenced = await ctx.newClient({
        actorId: 'actor-a',
        clientId: 'client-a',
        allowed: { org_id: ['o1'], projectId: ['*'] },
      });
      const open = await ctx.newClient({
        actorId: 'actor-b',
        clientId: 'client-b',
        allowed: { org_id: ['*'], projectId: ['*'] },
      });
      for (const client of [fenced, open]) {
        // The request names only the wildcard-granted child variable.
        await client.api.subscribe({
          id: 'docs',
          table: 'docs',
          scopes: { projectId: ['p1', 'p2'] },
        });
        await syncIdle(client);
      }
      checkEqual(
        (await fenced.api.readRows('docs')).map((row) => row.rowId).sort(),
        ['inside', 'inside-other-child'],
        "the actor's org list fences a subscription that omits org_id (§3.2 rule 4)",
      );
      checkEqual(
        (await fenced.api.subscriptionState('docs'))?.effectiveScopes,
        { org_id: ['o1'], projectId: ['p1', 'p2'] },
        'the effective scopes echo the variable the fence added',
      );
      checkEqual(
        (await open.api.readRows('docs')).map((row) => row.rowId).sort(),
        ['inside', 'inside-other-child', 'outside-same-child'],
        'an all-wildcard actor is not fenced',
      );
      checkEqual(
        (await open.api.subscriptionState('docs'))?.effectiveScopes,
        { projectId: ['p1', 'p2'] },
        'an all-wildcard actor keeps the requested scopes',
      );
    },
  },

  {
    name: 'scopes/revocation-purges-exactly-the-grant',
    specRefs: ['§3.3', '§3.4', 'B.4'],
    requires: ['scope-authorization'],
    async run(ctx) {
      const a = await ctx.newClient({
        actorId: 'actor-a',
        clientId: 'client-a',
        allowed: { project_id: ['p1', 'p2'] },
      });
      await seedTasks(ctx, [
        task('t1', 'p1', 'one'),
        task('t2', 'p1', 'two'),
        task('t3', 'p2', 'keep'),
      ]);
      await a.api.subscribe({
        id: 'sub-p1',
        table: 'tasks',
        scopes: { project_id: ['p1'] },
      });
      await a.api.subscribe({
        id: 'sub-p2',
        table: 'tasks',
        scopes: { project_id: ['p2'] },
      });
      await syncIdle(a);
      checkEqual((await a.api.readRows('tasks')).length, 3, 'all rows synced');

      // The host revokes p1; a pending write into p1 is now doomed.
      await ctx.server.setAllowedScopes('actor-a', { project_id: ['p2'] });
      await a.api.mutate([
        { op: 'upsert', table: 'tasks', values: task('t1', 'p1', 'doomed') },
      ]);
      const report = await syncOk(a);
      check(report.revoked.includes('sub-p1'), 'sub-p1 was revoked');
      checkEqual(
        (await a.api.subscriptionState('sub-p1'))?.status,
        'revoked',
        'the client stopped pulling the subscription',
      );
      checkEqual(
        (await a.api.subscriptionState('sub-p1'))?.reasonCode,
        'sync.scope_revoked',
        'reason code delivered via SUB_START (§10.2)',
      );
      checkEqual(
        (await a.api.readRows('tasks')).map((row) => row.rowId),
        ['t3'],
        "exactly the revoked grant's rows were purged; p2 rows untouched",
      );
      checkEqual(
        await a.api.pendingCommitIds(),
        [],
        'doomed outbox writes do not replay into guaranteed rejections',
      );
      const t1 = (await ctx.server.readRows('tasks')).find(
        (row) => row.rowId === 't1',
      );
      checkEqual(t1?.values.title, 'one', 'the doomed write never applied');
      // The still-granted subscription keeps syncing.
      await seedTasks(ctx, [task('t4', 'p2', 'new')]);
      await syncIdle(a);
      checkEqual(
        (await a.api.readRows('tasks')).map((row) => row.rowId),
        ['t3', 't4'],
        'p2 stays live after the p1 revocation',
      );
    },
  },

  {
    name: 'scopes/revocation-keeps-rows-another-subscription-covers',
    specRefs: ['§3.3', '§4.8'],
    requires: ['scope-authorization'],
    async run(ctx) {
      await seedRows(ctx, 'docs', [
        doc('shared', 'o1', 'p1'),
        doc('lone', 'o2', 'p1'),
      ]);
      const a = await ctx.newClient({
        actorId: 'actor-a',
        clientId: 'client-a',
        allowed: { org_id: ['o1', 'o2'], projectId: ['p1'] },
      });
      await a.api.subscribe({
        id: 'org',
        table: 'docs',
        scopes: { org_id: ['o1'] },
      });
      await a.api.subscribe({
        id: 'project',
        table: 'docs',
        scopes: { projectId: ['p1'] },
      });
      await syncIdle(a);
      checkEqual(
        (await a.api.readRows('docs')).map((row) => row.rowId).sort(),
        ['lone', 'shared'],
        'both subscriptions synced',
      );

      await ctx.server.setAllowedScopes('actor-a', {
        org_id: ['o1', 'o2'],
        projectId: ['p9'],
      });
      const report = await syncOk(a);
      checkEqual(report.revoked, ['project'], 'only the project grant ended');
      checkEqual(
        (await a.api.readRows('docs')).map((row) => row.rowId),
        ['shared'],
        'the purge keeps the row the org subscription still covers',
      );
      await seedRows(ctx, 'docs', [doc('shared', 'o1', 'p1', 'edited')]);
      await syncIdle(a);
      checkEqual(
        (await a.api.readRows('docs'))[0]?.values.body,
        'edited',
        'the surviving subscription keeps syncing the shared row',
      );
    },
  },

  {
    name: 'scopes/revocation-purges-an-integer-scope-column',
    specRefs: ['§3.3', '§2.4'],
    requires: ['scope-authorization'],
    server: { schema: INTEGER_SCOPE_SCHEMA },
    async run(ctx) {
      await ctx.server.setAllowedScopes('bucket-seed', { bucket: ['*'] });
      const seeded = await ctx.rawSync(
        'bucket-seed',
        [
          rawPushCommit(
            'seed-buckets',
            [
              { id: 'b7', bucket: 7, body: 'seven' },
              { id: 'b8', bucket: 8, body: 'eight' },
            ].map((row) => rawUpsert(ctx.serverSchema, 'buckets', row)),
          ),
        ],
        { clientId: 'bucket-seed' },
      );
      check(seeded.ok, 'the rows are seeded');
      const a = await ctx.newClient({
        actorId: 'actor-a',
        clientId: 'client-a',
        schema: INTEGER_SCOPE_SCHEMA,
        allowed: { bucket: ['7', '8'] },
      });
      for (const bucket of ['7', '8']) {
        await a.api.subscribe({
          id: `bucket-${bucket}`,
          table: 'buckets',
          scopes: { bucket: [bucket] },
        });
      }
      await syncIdle(a);
      checkEqual(
        (await a.api.readRows('buckets')).map((row) => row.rowId),
        ['b7', 'b8'],
        'both buckets synced',
      );

      await ctx.server.setAllowedScopes('actor-a', { bucket: ['8'] });
      const report = await syncOk(a);
      checkEqual(report.revoked, ['bucket-7'], 'bucket 7 was revoked');
      checkEqual(
        (await a.api.readRows('buckets')).map((row) => row.rowId),
        ['b8'],
        'the purge matches the integer scope column by value',
      );
    },
  },

  {
    name: 'scopes/re-subscribe-rearms-a-revoked-subscription',
    specRefs: ['§3.3', '§4.1'],
    requires: ['scope-authorization'],
    async run(ctx) {
      const a = await ctx.newClient({
        actorId: 'actor-a',
        clientId: 'client-a',
        allowed: { project_id: ['p2'] },
      });
      await seedTasks(ctx, [task('t1', 'p1', 'granted later')]);
      // The app subscribes before the grant exists.
      await a.api.subscribe({
        id: 'sub-p1',
        table: 'tasks',
        scopes: { project_id: ['p1'] },
      });
      const revoked = await syncIdle(a);
      check(revoked.revoked.includes('sub-p1'), 'sub-p1 was revoked');
      checkEqual(
        (await a.api.subscriptionState('sub-p1'))?.status,
        'revoked',
        'the client stopped pulling the subscription',
      );
      checkEqual(
        (await a.api.readRows('tasks')).length,
        0,
        'nothing was delivered before the grant',
      );

      // The grant arrives; the app subscribes with the same id and intent.
      await ctx.server.setAllowedScopes('actor-a', {
        project_id: ['p1'],
      });
      await a.api.subscribe({
        id: 'sub-p1',
        table: 'tasks',
        scopes: { project_id: ['p1'] },
      });
      const rearmed = await a.api.subscriptionState('sub-p1');
      checkEqual(rearmed?.status, 'active', 'the registration was re-armed');
      checkEqual(rearmed?.cursor, -1, 'its cursor starts over');
      checkEqual(
        rearmed?.effectiveScopes,
        undefined,
        'no effective scopes are carried into the new attempt',
      );
      checkEqual(
        rearmed?.reasonCode,
        undefined,
        'the revocation reason is cleared',
      );

      await syncIdle(a);
      checkEqual(
        (await a.api.readRows('tasks')).map((row) => row.rowId),
        ['t1'],
        'the rows arrive once the grant exists',
      );
      checkEqual(
        (await a.api.subscriptionState('sub-p1'))?.effectiveScopes,
        { project_id: ['p1'] },
        'the next pull resolved the scopes again',
      );
    },
  },

  {
    name: 'scopes/fail-closed-without-local-mapping',
    specRefs: ['§3.3', '§5.6'],
    async run(ctx) {
      // A client whose generated schema lacks the projectId mapping for
      // docs: precision or nothing — it must not clear-approximate.
      const brokenSchema: DriverSchema = {
        version: FIXTURE_SCHEMA.version,
        tables: FIXTURE_SCHEMA.tables.map((table) =>
          table.name === 'docs'
            ? { ...table, scopes: [{ pattern: 'org:{org_id}' }] }
            : table,
        ),
      };
      const a = await ctx.newClient({
        actorId: 'actor-a',
        clientId: 'client-a',
        schema: brokenSchema,
        allowed: { projectId: ['p1'], org_id: ['o1'] },
      });
      await seedRows(ctx, 'docs', [doc('d1', 'o1', 'p1')]);
      await a.api.subscribe({
        id: 'docs',
        table: 'docs',
        scopes: { projectId: ['p1'] },
      });
      const report = await syncOk(a);
      check(
        report.failed.includes('docs'),
        'the subscription failed closed as a fatal configuration error',
      );
      checkEqual(
        (await a.api.subscriptionState('docs'))?.status,
        'failed',
        'syncing the table stopped',
      );
      checkEqual(
        (await a.api.readRows('docs')).length,
        0,
        'nothing was applied or cleared by approximation',
      );
      // A failed registration is a configuration error, not a revocation:
      // subscribing again with the same intent leaves it failed.
      await a.api.subscribe({
        id: 'docs',
        table: 'docs',
        scopes: { projectId: ['p1'] },
      });
      checkEqual(
        (await a.api.subscriptionState('docs'))?.status,
        'failed',
        'a failed subscription is not re-armed',
      );
    },
  },

  {
    name: 'scopes/resolver-failure-fails-loud-and-closed',
    specRefs: ['§3.2', '§3.4'],
    requires: ['scope-authorization'],
    async run(ctx) {
      const a = await ctx.newClient({
        actorId: 'actor-a',
        clientId: 'client-a',
        allowed: { project_id: ['p1'] },
      });
      await seedTasks(ctx, [task('t1', 'p1')]);
      await a.api.subscribe({
        id: 'tasks',
        table: 'tasks',
        scopes: { project_id: ['p1'] },
      });
      await syncIdle(a);

      await ctx.server.setResolverFailing(true);
      const m1 = await a.api.mutate([
        { op: 'upsert', table: 'tasks', values: task('t2', 'p1', 'blocked') },
      ]);
      const report = await syncOk(a);
      checkEqual(
        report.rejected,
        [m1],
        'writes reject while authorization is broken (§3.4 step 4)',
      );
      checkEqual(
        (await a.api.rejections())[0]?.code,
        'sync.forbidden',
        'the write rejects with sync.forbidden, never applies blind',
      );
      check(
        report.revoked.includes('tasks'),
        'the subscription revokes — no data on resolver errors (§3.2 rule 5)',
      );
      checkEqual(
        await ctx.server.getMaxCommitSeq(),
        1,
        'only the seed commit exists server-side',
      );

      // Recovery: the host fixes the resolver; a fresh subscription syncs.
      await ctx.server.setResolverFailing(false);
      await a.api.subscribe({
        id: 'tasks-2',
        table: 'tasks',
        scopes: { project_id: ['p1'] },
      });
      await syncIdle(a);
      checkEqual(
        (await a.api.readRows('tasks')).map((row) => row.rowId),
        ['t1'],
        'data returns once authorization works again',
      );
    },
  },

  {
    name: 'scopes/write-outside-grant-denied-and-scope-columns-immutable',
    specRefs: ['§3.4'],
    requires: ['scope-authorization'],
    async run(ctx) {
      const a = await ctx.newClient({
        actorId: 'actor-a',
        clientId: 'client-a',
        allowed: { project_id: ['p1'] },
      });
      await a.api.subscribe({
        id: 'tasks',
        table: 'tasks',
        scopes: { project_id: ['p1'] },
      });
      await syncIdle(a);

      // Insert outside the grant: denied.
      const outside = await a.api.mutate([
        { op: 'upsert', table: 'tasks', values: task('x1', 'p2', 'nope') },
      ]);
      const denied = await syncOk(a);
      checkEqual(denied.rejected, [outside], 'cross-scope insert rejected');
      checkEqual(
        (await a.api.rejections())[0]?.code,
        'sync.forbidden',
        'denial code',
      );
      checkEqual((await ctx.server.readRows('tasks')).length, 0, 'no write');

      // Re-homing by update: a present scope column with a changed value
      // rejects whole; it is never silently stripped (§3.4 rule 5).
      const b = await ctx.newClient({
        actorId: 'actor-b',
        clientId: 'client-b',
        allowed: { project_id: ['p1', 'p2'] },
      });
      await b.api.subscribe({
        id: 'tasks',
        table: 'tasks',
        scopes: { project_id: ['p1', 'p2'] },
      });
      await syncIdle(b);
      await b.api.mutate([
        { op: 'upsert', table: 'tasks', values: task('t1', 'p1', 'home') },
      ]);
      await syncIdle(b);
      const moved = await b.api.mutate([
        { op: 'upsert', table: 'tasks', values: task('t1', 'p2', 'moved?') },
      ]);
      const movedReport = await syncOk(b);
      checkEqual(
        movedReport.rejected,
        [moved],
        'the scope move is rejected, not stripped',
      );
      checkEqual(
        (await b.api.rejections())[0]?.code,
        'sync.invalid_request',
        'a present changed scope column rejects with sync.invalid_request',
      );
      const t1 = (await ctx.server.readRows('tasks')).find(
        (row) => row.rowId === 't1',
      );
      checkEqual(
        t1?.values.project_id,
        'p1',
        'scope columns are immutable on update (§3.4 rule 5)',
      );
      checkEqual(t1?.scopes.project_id, 'p1', 'stored scopes unchanged');
      checkEqual(
        t1?.values.title,
        'home',
        'the rejected commit wrote nothing, sibling columns included',
      );
      // The client's optimistic p2 row reconciles back on rebuild (§7.2).
      await syncIdle(b);
      const local = (await b.api.readRows('tasks')).find(
        (row) => row.rowId === 't1',
      );
      checkEqual(
        local?.values.project_id,
        'p1',
        'the rebuild reconciled the rejected optimistic write locally',
      );
      checkEqual(local?.values.title, 'home', 'the local title reconciled too');
    },
  },

  {
    name: 'scopes/segment-download-reauthorizes-every-time',
    specRefs: ['§5.5', '§3.5', '§5.1'],
    requires: ['scope-authorization', 'segment-refs', 'server-limits'],
    server: { limits: { inlineSegmentMaxBytes: 0 } },
    async run(ctx) {
      await ctx.server.setAllowedScopes('dl-actor', { project_id: ['p1'] });
      await seedTasks(ctx, [task('t1', 'p1', 'external')]);

      const pull = await ctx.rawSync(
        'dl-actor',
        [
          rawPullHeader(),
          rawSubscription('s1', 'tasks', { project_id: ['p1'] }, -1),
        ],
        { clientId: 'dl-client' },
      );
      check(pull.ok, 'bootstrap pull succeeded');
      if (!pull.ok) return;
      const section = responseSection(pull.message, 's1');
      const ref = section.body.find((frame) => frame.type === 'SEGMENT_REF');
      check(
        ref !== undefined && ref.type === 'SEGMENT_REF',
        'the segment was delivered as an external reference',
      );
      if (ref?.type !== 'SEGMENT_REF') return;
      const scopesHeader = canonicalScopeJson({ project_id: ['p1'] });

      // Authorized download works.
      const ok = await ctx.server.downloadSegment(
        'dl-actor',
        ref.segmentId,
        scopesHeader,
      );
      check(ok.ok, 'authorized download succeeded');

      // Unknown segment: not_found, never a byte.
      const missing = await ctx.server.downloadSegment(
        'dl-actor',
        `sha256:${'0'.repeat(64)}`,
        scopesHeader,
      );
      check(!missing.ok, 'unknown segment rejected');
      if (!missing.ok) {
        checkEqual(
          missing.error.code,
          'sync.not_found',
          'unknown segment code',
        );
      }

      // A different effective grant → digest mismatch → forbidden.
      await ctx.server.setAllowedScopes('dl-actor', {
        project_id: ['p1', 'p2'],
      });
      const mismatched = await ctx.server.downloadSegment(
        'dl-actor',
        ref.segmentId,
        canonicalScopeJson({ project_id: ['p2'] }),
      );
      check(!mismatched.ok, 'digest mismatch rejected');
      if (!mismatched.ok) {
        checkEqual(
          mismatched.error.code,
          'sync.forbidden',
          'scope digest mismatch is forbidden (§3.5)',
        );
      }

      // Revocation: the earlier reference is not a bearer capability.
      await ctx.server.setAllowedScopes('dl-actor', { project_id: ['p2'] });
      const revoked = await ctx.server.downloadSegment(
        'dl-actor',
        ref.segmentId,
        scopesHeader,
      );
      check(!revoked.ok, 'revoked download rejected');
      if (!revoked.ok) {
        checkEqual(
          revoked.error.code,
          'sync.forbidden',
          'every download re-authorizes (§5.5)',
        );
      }
    },
  },

  {
    name: 'scopes/scope-move-keeps-the-row-in-either-section-order',
    specRefs: ['§2.2', '§4.5', '§3.4'],
    async run(ctx) {
      await seedTasks(ctx, [task('t1', 'p1', 'before')]);
      const readers = [];
      for (const order of [
        [
          ['a-old', 'p1'],
          ['b-new', 'p2'],
        ],
        [
          ['a-new', 'p2'],
          ['b-old', 'p1'],
        ],
      ] as const) {
        const label = order[0]?.[0] ?? 'reader';
        const reader = await ctx.newClient({
          actorId: `actor-${label}`,
          clientId: `client-${label}`,
          allowed: { project_id: ['p1', 'p2'] },
        });
        for (const [id, project] of order) {
          await reader.api.subscribe({
            id,
            table: 'tasks',
            scopes: { project_id: [project] },
          });
        }
        await syncIdle(reader);
        checkEqual(
          await reader.api.readRows('tasks'),
          [
            {
              rowId: 't1',
              version: 1,
              values: task('t1', 'p1', 'before'),
            },
          ],
          'the reader starts with the row in its old scope',
        );
        readers.push(reader);
      }

      // One commit, delete under p1 and insert under p2 (the §40 scope move).
      await ctx.server.setAllowedScopes('mover', ALL_SCOPES);
      const moved = await ctx.rawSync(
        'mover',
        [
          rawPushCommit('scope-move', [
            rawDelete('tasks', 't1'),
            rawUpsert(ctx.serverSchema, 'tasks', task('t1', 'p2', 'after'), 0),
          ]),
        ],
        { clientId: 'scope-move', schemaVersion: ctx.serverSchema.version },
      );
      check(moved.ok, 'the scope move applies');
      if (!moved.ok) return;
      checkEqual(
        responsePushResults(moved.message)[0]?.status,
        'applied',
        'the move is one applied commit',
      );

      for (const reader of readers) {
        await syncIdle(reader);
        checkEqual(
          await reader.api.readRows('tasks'),
          [
            {
              rowId: 't1',
              version: 1,
              values: task('t1', 'p2', 'after'),
            },
          ],
          'the upsert wins over the move delete whatever order the sections arrive in',
        );
      }
      checkEqual(
        (await ctx.server.readRows('tasks')).map(
          (row) => row.values.project_id,
        ),
        ['p2'],
        'the server holds the moved row',
      );
    },
  },

  {
    name: 'scopes/rescope-moves-twice-and-back',
    specRefs: ['§2.2', '§3.4', '§4.5'],
    async run(ctx) {
      const rescope = ctx.server.rescope?.bind(ctx.server);
      if (rescope === undefined) {
        throw new ScenarioSkip('server driver has no rescope operation');
      }
      await seedTasks(ctx, [task('t1', 'p1', 'row')]);
      await seedTasks(ctx, [task('t1', 'p1', 'updated')]);

      const oneSubscription = await ctx.newClient({
        actorId: 'actor-one',
        clientId: 'client-one',
        allowed: { project_id: ['p1', 'p2'] },
      });
      await oneSubscription.api.subscribe({
        id: 'both',
        table: 'tasks',
        scopes: { project_id: ['p1', 'p2'] },
      });
      const twoSubscriptions = await ctx.newClient({
        actorId: 'actor-two',
        clientId: 'client-two',
        allowed: { project_id: ['p1', 'p2'] },
      });
      for (const [id, project] of [
        ['old', 'p1'],
        ['new', 'p2'],
      ] as const) {
        await twoSubscriptions.api.subscribe({
          id,
          table: 'tasks',
          scopes: { project_id: [project] },
        });
      }
      const readers = [oneSubscription, twoSubscriptions];
      for (const reader of readers) {
        await syncIdle(reader);
        checkEqual(
          (await reader.api.readRows('tasks')).map((row) => row.values),
          [task('t1', 'p1', 'updated')],
          'the reader starts with the row under its old scope',
        );
      }

      await ctx.server.setAllowedScopes('mover', ALL_SCOPES);
      for (const project of ['p2', 'p1', 'p2'] as const) {
        const moved = await rescope(
          'mover',
          'tasks',
          task('t1', project, 'updated'),
        );
        check(moved.ok, `the rescope to ${project} applies`);
        if (!moved.ok) return;
        const serverRows = await ctx.server.readRows('tasks');
        checkEqual(serverRows.length, 1, 'the server holds exactly one row');
        checkEqual(
          serverRows[0]?.values,
          task('t1', project, 'updated'),
          'the stored row carries the new scope and values',
        );
        checkEqual(
          serverRows[0]?.version,
          2,
          'the move keeps server_version instead of restarting at 1',
        );
        for (const reader of readers) {
          await syncIdle(reader);
          checkEqual(
            (await reader.api.readRows('tasks')).map((row) => ({
              rowId: row.rowId,
              values: row.values,
            })),
            [{ rowId: 't1', values: task('t1', project, 'updated') }],
            'readers on the old and the new scope keep exactly one moved row',
          );
        }
      }
    },
  },
];
