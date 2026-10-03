/**
 * Column-granular writes (SPEC.md §6.1–§6.3, §5.10.3; Appendix B.21): a
 * sparse push payload writes its present columns only, `column_version`
 * drives conflict detection per column, crdt columns never participate in
 * the `baseVersion` comparison, and both cores emit byte-identical payloads.
 */
import { encodeSparseRow, type RowColumn } from '@syncular/core';
import { YjsColumn } from '@syncular/crdt-yjs';
import { check, checkEqual } from '../checks';
import type { DriverSchema } from '../driver';
import { FIXTURE_SCHEMA, task } from '../fixture';
import type { Scenario, ScenarioContext } from '../scenario';
import {
  bytesValue,
  CRDT_SCHEMA,
  CRDT_SERVER,
  noteRow,
  readText,
  textUpdate,
  valueBytes,
} from './crdt';
import { expectConverged, syncIdle, syncOk } from './util';

const P1 = { project_id: ['p1'] } as const;

/**
 * The fixture plus the two shapes §3.4 scope-column parity needs: a primary
 * key that is also a scope column, and a float scope column whose stored
 * REAL value coerces from a supplied integer.
 */
const PATCH_SCOPE_SCHEMA: DriverSchema = {
  ...FIXTURE_SCHEMA,
  tables: [
    ...FIXTURE_SCHEMA.tables,
    {
      name: 'tenants',
      columns: [
        { name: 'tenant_id', type: 'string', nullable: false },
        { name: 'body', type: 'string', nullable: false },
      ],
      primaryKey: 'tenant_id',
      scopes: [{ pattern: 'tenant:{tenant_id}' }],
    },
    {
      name: 'buckets',
      columns: [
        { name: 'id', type: 'string', nullable: false },
        { name: 'bucket', type: 'float', nullable: false },
        { name: 'body', type: 'string', nullable: false },
      ],
      primaryKey: 'id',
      scopes: [{ pattern: 'bucket:{bucket}' }],
    },
  ],
};

const PATCH_SCOPE_ALLOWED = {
  project_id: ['p1'],
  tenant_id: ['t1'],
  bucket: ['2'],
} as const;

const TASK_COLUMNS = (FIXTURE_SCHEMA.tables.find(
  (table) => table.name === 'tasks',
)?.columns ?? []) as readonly RowColumn[];

async function bootstrapped(
  ctx: ScenarioContext,
  actorId: string,
  clientId: string,
) {
  const handle = await ctx.newClient({ actorId, clientId, allowed: P1 });
  await handle.api.subscribe({ id: 'tasks', table: 'tasks', scopes: P1 });
  await syncIdle(handle);
  return handle;
}

async function serverRow(ctx: ScenarioContext, rowId: string) {
  const rows = await ctx.server.readRows('tasks');
  return rows.find((row) => row.rowId === rowId);
}

export const sparseRowScenarios: readonly Scenario[] = [
  {
    name: 'sparse-rows/acknowledged-intent-awaits-row-delivery',
    specRefs: ['§7.1', '§7.2', '§3.3'],
    async run(ctx) {
      const a = await bootstrapped(ctx, 'actor-a', 'client-a');
      await a.api.mutate([
        { op: 'upsert', table: 'tasks', values: task('t1', 'p1', '100/v1') },
      ]);
      await syncIdle(a);
      check(
        a.api.prepareRound !== undefined && a.api.completeRound !== undefined,
        'client supplies an in-flight request barrier',
      );
      const first = await a.api.patch('tasks', 't1', { title: '200/v2' });
      a.faults.deferNextPulls = 4;
      await a.api.prepareRound();
      const second = await a.api.patch('tasks', 't1', { title: '300/v3' });
      const report = await a.api.completeRound();
      check(report.ok, 'captured request completes');
      checkEqual(
        report.report.applied,
        [first],
        'first captured request ACKs only the first edit',
      );
      checkEqual(
        (await a.api.readRows('tasks'))[0]?.values.title,
        '300/v3',
        'later edit stays above acknowledged intent',
      );
      await syncOk(a);
      checkEqual(
        await a.api.pendingCommitIds(),
        [],
        'both ACKs drain the send queue',
      );
      checkEqual(
        (await a.api.readRows('tasks'))[0]?.values.title,
        '300/v3',
        'second ACK never exposes old base',
      );
      checkEqual(
        (await a.api.commitOutcomes()).find(
          (outcome) => outcome.clientCommitId === second,
        )?.status,
        'applied',
        'acknowledged history is separate from retained failures',
      );
      await syncOk(a);
      await ctx.recreateClient(a, FIXTURE_SCHEMA);
      checkEqual(
        (await a.api.readRows('tasks'))[0]?.values.title,
        '300/v3',
        'restart keeps acknowledged intent',
      );
      await syncOk(a);
      checkEqual(
        (await a.api.readRows('tasks'))[0]?.values.title,
        '300/v3',
        'empty pull after restart preserves intent',
      );
      const third = await a.api.patch('tasks', 't1', { title: '400/v4' });
      checkEqual(
        (await a.api.readRows('tasks'))[0]?.values.title,
        '400/v4',
        'later edits stack on acknowledged state',
      );
      await syncIdle(a);
      checkEqual(await a.api.pendingCommitIds(), [], 'later edit applies');
      checkEqual(
        (await a.api.commitOutcomes()).find(
          (outcome) => outcome.clientCommitId === third,
        )?.status,
        'applied',
        'later edit gets its own outcome',
      );
      checkEqual(
        (await a.api.readRows('tasks'))[0]?.values.title,
        '400/v4',
        'matching pull reconciles atomically',
      );
      const b = await bootstrapped(ctx, 'actor-b', 'client-b');
      await b.api.patch('tasks', 't1', { title: '500/v5' });
      await syncIdle(b);
      await syncIdle(a);
      await ctx.recreateClient(a, FIXTURE_SCHEMA);
      checkEqual(
        (await a.api.readRows('tasks'))[0]?.values.title,
        '500/v5',
        'settled intent never overrides a newer row after restart',
      );
    },
  },

  {
    name: 'sparse-rows/acknowledged-intent-wakes-own-pull',
    specRefs: ['§7.1', '§7.2'],
    async run(ctx) {
      const a = await bootstrapped(ctx, 'actor-a', 'client-a');
      await a.api.mutate([
        { op: 'upsert', table: 'tasks', values: task('own', 'p1', '100/v1') },
      ]);
      await syncIdle(a);
      a.faults.deferNextPulls = 1;
      await a.api.patch('tasks', 'own', { title: '300/v3' });
      const pushed = await syncOk(a);
      checkEqual(pushed.commitsApplied, 0, 'push ACK has no image');
      check(
        await a.api.syncNeeded(),
        'ACK requests immediate pull without realtime',
      );
      const next = await syncOk(a);
      checkEqual(
        next.commitsApplied,
        1,
        'immediately following round pulls own commit',
      );
      await expectConverged(ctx, 'tasks', [a]);
      await ctx.recreateClient(a, FIXTURE_SCHEMA);
      await expectConverged(ctx, 'tasks', [a]);
    },
  },
  {
    name: 'sparse-rows/acknowledged-intent-revocation',
    specRefs: ['§7.1', '§3.3'],
    async run(ctx) {
      const a = await bootstrapped(ctx, 'actor-a', 'client-a');
      await a.api.mutate([
        { op: 'upsert', table: 'tasks', values: task('own', 'p1', '100/v1') },
      ]);
      await syncIdle(a);
      a.faults.deferNextPulls = 1;
      await a.api.patch('tasks', 'own', { title: '300/v3' });
      await syncOk(a);
      await ctx.server.setAllowedScopes('actor-a', { project_id: [] });
      await syncOk(a);
      checkEqual(
        await a.api.readRows('tasks'),
        [],
        'revocation purges acknowledged intent',
      );
      await ctx.recreateClient(a, FIXTURE_SCHEMA);
      checkEqual(
        await a.api.readRows('tasks'),
        [],
        'restart cannot resurrect revoked intent',
      );

      const moved = await ctx.newClient({
        actorId: 'actor-b',
        clientId: 'client-b',
        allowed: { project_id: ['p1', 'p2'] },
      });
      await moved.api.subscribe({ id: 'tasks', table: 'tasks', scopes: P1 });
      await syncIdle(moved);
      await moved.api.mutate([
        {
          op: 'upsert',
          table: 'tasks',
          values: task('moved', 'p1', 'before move'),
        },
      ]);
      await syncIdle(moved);
      moved.faults.deferNextPulls = 1;
      await moved.api.mutate([
        {
          op: 'upsert',
          table: 'tasks',
          values: task('moved', 'p2', 'after move'),
        },
      ]);
      await syncOk(moved);
      await ctx.server.setAllowedScopes('actor-b', { project_id: ['p2'] });
      await syncOk(moved);
      checkEqual(
        await moved.api.readRows('tasks'),
        [],
        'revoking the old base scope also purges acknowledged moves',
      );
      await ctx.recreateClient(moved, FIXTURE_SCHEMA);
      checkEqual(
        await moved.api.readRows('tasks'),
        [],
        'restart cannot resurrect an acknowledged move from revoked scope',
      );
    },
  },

  {
    name: 'sparse-rows/retained-atomic-conflict',
    specRefs: ['§7.1', '§7.2', '§7.2.1', '§3.3'],
    async run(ctx) {
      const a = await bootstrapped(ctx, 'actor-a', 'client-a');
      const b = await ctx.newClient({
        actorId: 'actor-b',
        clientId: 'client-b',
        allowed: P1,
        retainFailedCommits: true,
      });
      await b.api.subscribe({ id: 'tasks', table: 'tasks', scopes: P1 });
      await a.api.mutate(
        ['t1', 't2'].map((id) => ({
          op: 'upsert' as const,
          table: 'tasks',
          values: task(id, 'p1', 'original'),
        })),
      );
      await syncIdle(a);
      await syncIdle(b);
      await a.api.patch('tasks', 't1', { title: 'winner' }, 1);
      await syncIdle(a);
      const losing = await b.api.mutate([
        {
          op: 'patch',
          table: 'tasks',
          values: { id: 't1', title: 'mine' },
          baseVersion: 1,
        },
        {
          op: 'patch',
          table: 'tasks',
          values: { id: 't2', done: true },
          baseVersion: 1,
        },
        {
          op: 'upsert',
          table: 'tasks',
          values: task('event', 'p1', 'audit'),
          baseVersion: 0,
        },
      ]);
      await syncIdle(b);
      checkEqual(
        (await b.api.readRows('tasks')).map((row) => row.values.title),
        ['audit', 'mine', 'original'],
        'entire losing aggregate remains visible',
      );
      checkEqual(
        (await b.api.readRows('tasks')).find((row) => row.rowId === 't2')
          ?.values.done,
        true,
        'losing sibling stays local',
      );
      checkEqual(
        await b.api.pendingCommitIds(),
        [],
        'failed intent is not retried implicitly',
      );
      await ctx.recreateClient(b, FIXTURE_SCHEMA);
      checkEqual(
        (await b.api.readRows('tasks')).find((row) => row.rowId === 't1')
          ?.values.title,
        'mine',
        'restart retains intended row',
      );
      check(
        b.api.drainChangeBatches !== undefined,
        'outcome changes are observable',
      );
      await b.api.drainChangeBatches();
      await a.api.patch('tasks', 't1', { title: 'latest' });
      await syncIdle(a);
      await syncIdle(b);
      check(
        (await b.api.drainChangeBatches()).some(
          (batch) => batch.outcomesChanged,
        ),
        'server base changes invalidate outcome readers',
      );
      const outcome = (await b.api.commitOutcomes()).find(
        (outcome) => outcome.clientCommitId === losing,
      );
      checkEqual(outcome?.status, 'conflict', 'explicit conflict record');
      checkEqual(
        outcome?.retainedRows?.find((row) => row.rowId === 't1')?.localRow
          ?.title,
        'mine',
        'intended snapshot is readable',
      );
      checkEqual(
        outcome?.retainedRows?.find((row) => row.rowId === 't1')?.serverRow
          ?.title,
        'latest',
        'current server base is readable',
      );
      await b.api.resolveCommitOutcome(losing, 'resolved_keep_server');
      checkEqual(
        (await b.api.readRows('tasks')).find((row) => row.rowId === 't1')
          ?.values.title,
        'latest',
        'take server restores latest base',
      );
      check(
        !(await b.api.readRows('tasks')).some((row) => row.rowId === 'event'),
        'take server removes failed aggregate creation',
      );
      checkEqual(
        (await b.api.readRows('tasks')).find((row) => row.rowId === 't2')
          ?.values.done,
        false,
        'take server restores sibling',
      );
      const correctionFailure = await b.api.patch(
        'tasks',
        't1',
        { title: 'old intent' },
        1,
      );
      await syncIdle(b);
      const correction = await b.api.patch(
        'tasks',
        't1',
        { title: 'reviewed edit' },
        3,
      );
      await b.api.resolveCommitOutcome(
        correctionFailure,
        'superseded',
        correction,
      );
      checkEqual(
        (await b.api.readRows('tasks')).find((row) => row.rowId === 't1')
          ?.values.title,
        'reviewed edit',
        'superseding correction keeps the new local state',
      );
      await syncIdle(b);
      await syncIdle(a);
      checkEqual(
        (await ctx.server.readRows('tasks')).find((row) => row.rowId === 't1')
          ?.values.title,
        'reviewed edit',
        'reviewed replacement syncs',
      );
      checkEqual(
        (await b.api.commitOutcomes()).find(
          (outcome) => outcome.clientCommitId === correctionFailure,
        )?.resolution,
        'superseded',
        'failure remains linked and resolved',
      );

      // A second retained conflict cannot survive scope revocation.
      const stale = await b.api.patch(
        'tasks',
        't1',
        { title: 'unauthorized' },
        1,
      );
      await syncIdle(b);
      await a.api.mutate([{ op: 'delete', table: 'tasks', rowId: 't1' }]);
      await syncIdle(a);
      await syncIdle(b);
      checkEqual(
        (await b.api.readRows('tasks')).find((row) => row.rowId === 't1')
          ?.values.title,
        undefined,
        'server deletion leaves a sparse conflict without a local row',
      );
      checkEqual(
        (await b.api.commitOutcomes()).find(
          (outcome) => outcome.clientCommitId === stale,
        )?.retainedRows?.[0]?.serverRow,
        null,
        'server deletion advances the retained base',
      );
      await ctx.server.setAllowedScopes('actor-b', { project_id: [] });
      await syncIdle(b);
      checkEqual(
        await b.api.readRows('tasks'),
        [],
        'revocation purges retained intent',
      );
      checkEqual(
        (await b.api.commitOutcomes()).find(
          (outcome) => outcome.clientCommitId === stale,
        )?.retainedRows,
        undefined,
        'purged failure exposes no retained rows',
      );
    },
  },

  {
    name: 'sparse-rows/retained-intent-with-deleted-base',
    specRefs: ['§7.1', '§7.2', '§7.2.1'],
    async run(ctx) {
      const a = await bootstrapped(ctx, 'actor-a', 'client-a');
      const b = await ctx.newClient({
        actorId: 'actor-b',
        clientId: 'client-b',
        allowed: P1,
        retainFailedCommits: true,
      });
      await b.api.subscribe({ id: 'tasks', table: 'tasks', scopes: P1 });
      await a.api.mutate([
        { op: 'upsert', table: 'tasks', values: task('t1', 'p1', 'original') },
      ]);
      await syncIdle(a);
      await syncIdle(b);
      const intended = await b.api.patch('tasks', 't1', { title: 'mine' }, 1);
      await a.api.mutate([
        { op: 'delete', table: 'tasks', rowId: 't1', baseVersion: 1 },
      ]);
      await syncIdle(a);
      await syncIdle(b);
      checkEqual(
        await b.api.readRows('tasks'),
        [],
        'sparse intent does not recreate a deleted base',
      );
      const outcome = (await b.api.commitOutcomes()).find(
        (row) => row.clientCommitId === intended,
      );
      check(
        outcome?.retainedRows?.length === 1,
        'failed intent remains explicitly readable',
      );
      checkEqual(
        outcome?.retainedRows?.[0]?.serverRow,
        null,
        'the current base is explicitly absent',
      );
      await ctx.recreateClient(b, FIXTURE_SCHEMA);
      checkEqual(
        await b.api.readRows('tasks'),
        [],
        'restart also keeps the deleted row absent',
      );
      check(
        (await b.api.commitOutcomes()).some(
          (row) =>
            row.clientCommitId === intended && row.retainedRows?.length === 1,
        ),
        'restart retains conflict evidence',
      );
      await b.api.resolveCommitOutcome(intended, 'resolved_keep_server');
      checkEqual(
        await b.api.readRows('tasks'),
        [],
        'explicit resolution keeps the server deletion',
      );
    },
  },

  {
    name: 'sparse-rows/atomic-mixed-batch',
    specRefs: ['§6.1', '§6.4', '§7.1'],
    async run(ctx) {
      const a = await bootstrapped(ctx, 'actor-a', 'client-a');
      const b = await bootstrapped(ctx, 'actor-b', 'client-b');
      await a.api.mutate(
        ['t1', 't2'].map((id) => ({
          op: 'upsert' as const,
          table: 'tasks',
          values: task(id, 'p1', 'original'),
        })),
      );
      await syncIdle(a);
      await syncIdle(b);
      const moved = await a.api.mutate([
        {
          op: 'patch',
          table: 'tasks',
          values: { id: 't1', title: 'moved' },
          baseVersion: 1,
        },
        {
          op: 'patch',
          table: 'tasks',
          values: { id: 't2', priority: 2 },
          baseVersion: 1,
        },
        {
          op: 'upsert',
          table: 'tasks',
          values: task('event', 'p1', 'audit'),
          baseVersion: 0,
        },
      ]);
      checkEqual(
        (await a.api.readRows('tasks')).map((row) => row.values.title),
        ['audit', 'moved', 'original'],
        'all batch rows apply locally',
      );
      checkEqual(
        (await syncOk(a)).applied,
        [moved],
        'one atomic batch applies',
      );
      const stale = await b.api.mutate([
        {
          op: 'patch',
          table: 'tasks',
          values: { id: 't2', done: true },
          baseVersion: 1,
        },
        {
          op: 'patch',
          table: 'tasks',
          values: { id: 't1', title: 'stale' },
          baseVersion: 1,
        },
        {
          op: 'upsert',
          table: 'tasks',
          values: task('failed-event', 'p1', 'audit'),
          baseVersion: 0,
        },
      ]);
      checkEqual(
        (await syncOk(b)).rejected,
        [stale],
        'one stale sibling rejects the entire batch',
      );
      const rows = await ctx.server.readRows('tasks');
      checkEqual(
        rows.find((row) => row.rowId === 't2')?.values.done,
        false,
        'earlier sibling rolled back',
      );
      check(
        !rows.some((row) => row.rowId === 'failed-event'),
        'no audit orphan committed',
      );
      checkEqual(
        rows.find((row) => row.rowId === 't1')?.values.title,
        'moved',
        'accepted row unchanged',
      );
    },
  },

  {
    // B.21(a): disjoint unversioned patches to different columns both land.
    name: 'sparse-rows/disjoint-unversioned-patches-both-land',
    specRefs: ['§6.1', '§6.2', 'B.21'],
    async run(ctx) {
      const a = await bootstrapped(ctx, 'actor-a', 'client-a');
      const b = await bootstrapped(ctx, 'actor-b', 'client-b');
      await a.api.mutate([
        { op: 'upsert', table: 'tasks', values: task('t1', 'p1', 'seed') },
      ]);
      await syncIdle(a);
      await syncIdle(b);

      await a.api.patch('tasks', 't1', { title: 'a-title' });
      await syncIdle(a);
      await b.api.patch('tasks', 't1', { done: true });
      await syncIdle(b);
      await syncIdle(a);

      const row = await serverRow(ctx, 't1');
      checkEqual(row?.values.title, 'a-title', "A's column landed");
      checkEqual(row?.values.done, true, "B's disjoint column landed");
      await expectConverged(ctx, 'tasks', [a, b], {
        variable: 'project_id',
        values: ['p1'],
      });
    },
  },

  {
    // B.21(b): disjoint patches from the SAME baseVersion both land — the
    // column a patch does not present keeps its version, so the second patch
    // does not conflict on it.
    name: 'sparse-rows/disjoint-versioned-patches-both-land',
    specRefs: ['§6.2', '§6.3', 'B.21'],
    async run(ctx) {
      const a = await bootstrapped(ctx, 'actor-a', 'client-a');
      const b = await bootstrapped(ctx, 'actor-b', 'client-b');
      await a.api.mutate([
        { op: 'upsert', table: 'tasks', values: task('t1', 'p1', 'seed') },
      ]);
      await syncIdle(a);
      await syncIdle(b);

      const base = (await serverRow(ctx, 't1'))?.version ?? 0;
      check(base >= 1, 'the seeded row has a version');
      await a.api.patch('tasks', 't1', { title: 'a-title' }, base);
      await syncIdle(a);
      // B patches a DISJOINT column from the same stale base: title moved to
      // a new column_version, but done did not, so B does not conflict.
      const bCommit = await b.api.patch('tasks', 't1', { done: true }, base);
      const report = await syncOk(b);
      check(
        report.applied.includes(bCommit),
        'the disjoint versioned patch applied',
      );
      checkEqual(report.conflicts, 0, 'no conflict on a disjoint column');
      const row = await serverRow(ctx, 't1');
      checkEqual(row?.values.title, 'a-title', "A's column survived");
      checkEqual(row?.values.done, true, "B's column landed");
    },
  },

  {
    // B.21(c): two patches to the SAME column from the same base — the second
    // conflicts and conflictColumns marks exactly that column.
    name: 'sparse-rows/same-column-versioned-patch-conflicts',
    specRefs: ['§6.2', '§6.3', 'B.21'],
    async run(ctx) {
      const a = await bootstrapped(ctx, 'actor-a', 'client-a');
      const b = await bootstrapped(ctx, 'actor-b', 'client-b');
      await a.api.mutate([
        { op: 'upsert', table: 'tasks', values: task('t1', 'p1', 'seed') },
      ]);
      await syncIdle(a);
      await syncIdle(b);

      const base = (await serverRow(ctx, 't1'))?.version ?? 0;
      await a.api.patch('tasks', 't1', { title: 'a-wins' }, base);
      await syncIdle(a);
      const bCommit = await b.api.patch(
        'tasks',
        't1',
        { title: 'b-loses' },
        base,
      );
      const report = await syncOk(b);
      checkEqual(report.rejected, [bCommit], 'the same-column patch conflicts');
      const conflict = (await b.api.conflicts())[0];
      check(conflict !== undefined, 'a conflict record surfaced');
      checkEqual(conflict?.code, 'sync.version_conflict', 'conflict code');
      checkEqual(
        conflict?.conflictColumns,
        ['title'],
        'conflictColumns marks exactly the contended column (§6.3)',
      );
      checkEqual(
        (await serverRow(ctx, 't1'))?.values.title,
        'a-wins',
        'the winner holds the column',
      );
    },
  },

  {
    // B.21(d): a crdt-only patch with a stale baseVersion applies clean while
    // a concurrent non-crdt patch also applies — crdt columns never enter the
    // baseVersion comparison (§5.10.3, §6.2).
    name: 'sparse-rows/crdt-patch-with-stale-base-applies-clean',
    specRefs: ['§5.10.3', '§6.2', 'B.21'],
    requires: ['crdt'] as const,
    server: CRDT_SERVER,
    async run(ctx) {
      const a = await ctx.newClient({
        actorId: 'actor-a',
        clientId: 'client-a',
        schema: CRDT_SCHEMA,
        allowed: P1,
      });
      const b = await ctx.newClient({
        actorId: 'actor-b',
        clientId: 'client-b',
        schema: CRDT_SCHEMA,
        allowed: P1,
      });
      await a.api.subscribe({ id: 'notes', table: 'notes', scopes: P1 });
      await b.api.subscribe({ id: 'notes', table: 'notes', scopes: P1 });
      await syncIdle(a);
      await syncIdle(b);

      await a.api.mutate([
        {
          op: 'upsert',
          table: 'notes',
          values: noteRow('n1', 't', textUpdate('hello')),
        },
      ]);
      await syncIdle(a);
      await syncIdle(b);

      const notesRow = async () =>
        (await ctx.server.readRows('notes')).find((row) => row.rowId === 'n1');
      const base = (await notesRow())?.version ?? 0;

      // B moves the LWW title to base+1.
      await b.api.patch('notes', 'n1', { title: 'b-title' }, base);
      await syncIdle(b);

      // A appends to the crdt doc from the now-stale base. The patch presents
      // only the crdt column (plus the immutable pk), so nothing is
      // comparable and it applies clean.
      const docCol = new YjsColumn();
      docCol.text().insert(0, 'A ');
      const aUpdate = docCol.columnBytes();
      docCol.destroy();
      const aCommit = await a.api.patch(
        'notes',
        'n1',
        { doc: bytesValue(aUpdate) },
        base,
      );
      const report = await syncOk(a);
      check(
        report.applied.includes(aCommit),
        'the stale-based crdt patch applied clean',
      );
      checkEqual(
        report.conflicts,
        0,
        'a crdt column never conflicts (§5.10.3)',
      );
      await syncIdle(b);
      const merged = (await notesRow())?.values.doc;
      const text = readText(valueBytes(merged));
      check(text.includes('hello'), 'the crdt merge kept the stored text');
      checkEqual(
        (await notesRow())?.values.title,
        'b-title',
        'the concurrent non-crdt patch also applied',
      );
    },
  },

  {
    // Local authoring requires a base before any operation in the batch runs.
    name: 'sparse-rows/absent-base-rejects-at-author-time',
    specRefs: ['§7.1', '§6.4', 'B.21'],
    async run(ctx) {
      const a = await bootstrapped(ctx, 'actor-a', 'client-a');
      let code: string | undefined;
      try {
        await a.api.patch('tasks', 'ghost', { title: 'x' });
      } catch (error) {
        code = (error as { code?: string }).code;
      }
      checkEqual(
        code,
        'sync.row_missing',
        'absent base has a typed author-time error',
      );
      code = undefined;
      try {
        await a.api.mutate([
          {
            op: 'upsert',
            table: 'tasks',
            values: task('event', 'p1', 'audit'),
          },
          {
            op: 'patch',
            table: 'tasks',
            values: { id: 'ghost', title: 'mine' },
          },
        ]);
      } catch (error) {
        code = (error as { code?: string }).code;
      }
      checkEqual(
        code,
        'sync.row_missing',
        'the mixed batch rejects before writing',
      );
      checkEqual(await a.api.pendingCommitIds(), [], 'nothing enqueued');
      checkEqual(
        await a.api.readRows('tasks'),
        [],
        'no sibling inserted locally',
      );
      await syncIdle(a);
      checkEqual(
        await ctx.server.readRows('tasks'),
        [],
        'nothing sent to the server',
      );
    },
  },

  {
    // B.21(f): a present scope column that changes the stored value rejects
    // sync.invalid_request, replacing the old silent strip (§3.4 rule 5).
    name: 'sparse-rows/present-scope-column-change-rejects',
    specRefs: ['§3.4', '§6.2', 'B.21'],
    async run(ctx) {
      const a = await bootstrapped(ctx, 'actor-a', 'client-a');
      await a.api.mutate([
        { op: 'upsert', table: 'tasks', values: task('t1', 'p1', 'seed') },
      ]);
      await syncIdle(a);
      // A full-row mutate re-homes the row to p2 — the scope column is
      // present with a changed value.
      const rejected = await a.api.mutate([
        { op: 'upsert', table: 'tasks', values: task('t1', 'p2', 'moved') },
      ]);
      const report = await syncOk(a);
      checkEqual(report.rejected, [rejected], 'the scope move is rejected');
      checkEqual(
        (await a.api.rejections())[0]?.code,
        'sync.invalid_request',
        'a present scope column rejects, never silently strips (§3.4)',
      );
      checkEqual(
        (await serverRow(ctx, 't1'))?.values.project_id,
        'p1',
        'the stored scope is unchanged',
      );
    },
  },

  {
    // B.21(g): the optimistic overlay applies a pending patch's present
    // columns over the current local row and leaves untouched columns at
    // their synced value (§7.1).
    name: 'sparse-rows/overlay-applies-present-columns-only',
    specRefs: ['§7.1', 'B.21'],
    async run(ctx) {
      const a = await bootstrapped(ctx, 'actor-a', 'client-a');
      await a.api.mutate([
        {
          op: 'upsert',
          table: 'tasks',
          values: task('t1', 'p1', 'seed', true, 5, null),
        },
      ]);
      await syncIdle(a);
      // Patch title only; do NOT sync — read the optimistic overlay.
      await a.api.patch('tasks', 't1', { title: 'patched' });
      const local = (await a.api.readRows('tasks')).find(
        (row) => row.rowId === 't1',
      );
      checkEqual(local?.values.title, 'patched', 'the present column applied');
      checkEqual(
        local?.values.done,
        true,
        'an untouched column kept its value',
      );
      checkEqual(
        local?.values.priority,
        5,
        'a second untouched column kept its value',
      );
    },
  },

  {
    // B.21(h): the Rust and TS clients emit byte-identical sparse payloads
    // for the same patch. The expected bytes come from the shared reference
    // codec, so both pairings pin the same wire output.
    name: 'sparse-rows/byte-identical-sparse-payload',
    specRefs: ['§2.4', '§6.1', 'B.21'],
    async run(ctx) {
      const a = await bootstrapped(ctx, 'actor-a', 'client-a');
      await a.api.mutate([
        { op: 'upsert', table: 'tasks', values: task('t1', 'p1', 'seed') },
      ]);
      await syncIdle(a);
      await a.api.patch('tasks', 't1', { title: 'x' });
      const payloads = await a.api.pendingPayloads?.();
      check(payloads !== undefined, 'the driver exposes pendingPayloads');
      checkEqual(payloads?.length, 1, 'exactly one pending upsert payload');
      // id (pk) + title present; project_id, done, priority, meta absent.
      const expected = encodeSparseRow(TASK_COLUMNS, 0, [
        't1',
        undefined,
        'x',
        undefined,
        undefined,
        undefined,
      ]);
      const actual = payloads?.[0];
      check(actual !== undefined, 'a payload was produced');
      checkEqual(
        Array.from(actual ?? []),
        Array.from(expected),
        'the client payload is byte-identical to the reference sparse encoding',
      );
    },
  },

  {
    // §3.4 rule 5 / §6.2: a patch that repeats a scope column at its stored
    // value is a no-op the server accepts, so both cores drop it from the
    // presence set instead of refusing the commit. A differing value, or a
    // row with nothing local to compare against, fails closed locally.
    name: 'sparse-rows/patch-scope-column-matches-stored-local-row',
    specRefs: ['§3.4', '§6.2', 'B.21'],
    server: { schema: PATCH_SCOPE_SCHEMA },
    async run(ctx) {
      const a = await ctx.newClient({
        actorId: 'actor-a',
        clientId: 'client-a',
        schema: PATCH_SCOPE_SCHEMA,
        allowed: PATCH_SCOPE_ALLOWED,
      });
      await a.api.subscribe({ id: 'tasks', table: 'tasks', scopes: P1 });
      await syncIdle(a);
      await a.api.mutate([
        { op: 'upsert', table: 'tasks', values: task('t1', 'p1', 'seed') },
      ]);
      await syncIdle(a);

      const kept = await a.api.patch('tasks', 't1', {
        project_id: 'p1',
        title: 'kept',
      });
      const payloads = await a.api.pendingPayloads?.();
      check(payloads !== undefined, 'the driver exposes pendingPayloads');
      checkEqual(payloads?.length, 1, 'exactly one pending upsert payload');
      // id (pk) + title present; project_id, done, priority, meta absent.
      const expected = encodeSparseRow(TASK_COLUMNS, 0, [
        't1',
        undefined,
        'kept',
        undefined,
        undefined,
        undefined,
      ]);
      checkEqual(
        Array.from(payloads?.[0] ?? []),
        Array.from(expected),
        'the equal scope column left the presence set',
      );

      const report = await syncOk(a);
      check(
        report.applied.includes(kept),
        'the equal-scope patch applied on the server',
      );
      const stored = await serverRow(ctx, 't1');
      checkEqual(
        stored?.values.project_id,
        'p1',
        'the stored scope value held',
      );
      checkEqual(stored?.values.title, 'kept', 'the sibling column landed');

      // A differing value rejects locally with the stable code.
      let differing = '';
      try {
        await a.api.patch('tasks', 't1', { project_id: 'p2' });
      } catch (error) {
        differing = (error as { code?: string }).code ?? '';
      }
      checkEqual(
        differing,
        'sync.invalid_request',
        'a differing scope column rejects locally',
      );

      // No local row: the client cannot prove equality against the server's
      // stored row and fails closed the same way.
      let absent = '';
      try {
        await a.api.patch('tasks', 'ghost', { project_id: 'p1' });
      } catch (error) {
        absent = (error as { code?: string }).code ?? '';
      }
      checkEqual(
        absent,
        'sync.row_missing',
        'an absent local row rejects locally',
      );

      // A primary-key scope column also needs a local base.
      await a.api.subscribe({
        id: 'tenants',
        table: 'tenants',
        scopes: { tenant_id: ['t1'] },
      });
      await syncIdle(a);
      await a.api.mutate([
        {
          op: 'upsert',
          table: 'tenants',
          values: { tenant_id: 't1', body: 'seed' },
        },
      ]);
      await syncIdle(a);
      const created = await a.api.patch('tenants', 't1', {
        tenant_id: 't1',
        body: 'created',
      });
      const createdReport = await syncOk(a);
      check(
        createdReport.applied.includes(created),
        'the primary-key scope column patch applied',
      );
      const tenant = (await ctx.server.readRows('tenants')).find(
        (row) => row.rowId === 't1',
      );
      checkEqual(tenant?.values.body, 'created', 'the patch wrote the row');
      checkEqual(tenant?.scopes.tenant_id, 't1', 'the stored scope is the key');

      // A supplied integer for a stored REAL scope value: the value is
      // decoded through the column type before the comparison, so the two
      // equal values reach the same representation.
      await a.api.subscribe({
        id: 'buckets',
        table: 'buckets',
        scopes: { bucket: ['2'] },
      });
      await syncIdle(a);
      await a.api.mutate([
        {
          op: 'upsert',
          table: 'buckets',
          values: { id: 'b1', bucket: 2, body: 'seed' },
        },
      ]);
      await syncIdle(a);
      const coerced = await a.api.patch('buckets', 'b1', {
        bucket: 2,
        body: 'coerced',
      });
      const coercedReport = await syncOk(a);
      check(
        coercedReport.applied.includes(coerced),
        'the coerced scope value patch applied',
      );
      const bucket = (await ctx.server.readRows('buckets')).find(
        (row) => row.rowId === 'b1',
      );
      checkEqual(bucket?.values.body, 'coerced', 'the sibling column landed');
      checkEqual(bucket?.scopes.bucket, '2', 'the stored scope value held');

      checkEqual(
        await a.api.pendingCommitIds(),
        [],
        'the rejected patches recorded no commit',
      );
    },
  },
];
