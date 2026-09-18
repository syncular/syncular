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
    // B.21(e): a partial payload on an absent row (no tombstone) rejects
    // row_missing — an insert requires every column present (§6.3).
    name: 'sparse-rows/partial-on-absent-row-rejects-row-missing',
    specRefs: ['§5.2', '§6.3', 'B.21'],
    async run(ctx) {
      const a = await bootstrapped(ctx, 'actor-a', 'client-a');
      const rejected = await a.api.patch('tasks', 'ghost', { title: 'x' });
      const report = await syncOk(a);
      checkEqual(report.rejected, [rejected], 'the partial insert is rejected');
      checkEqual(
        (await a.api.rejections())[0]?.code,
        'sync.row_missing',
        'a partial payload on an absent row rejects row_missing (§6.3)',
      );
      checkEqual(
        (await ctx.server.readRows('tasks')).length,
        0,
        'nothing was written',
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
        'sync.invalid_request',
        'an absent local row rejects locally',
      );

      // A primary key that is also a scope column: the sparse payload's key
      // is by construction the row id being patched, so the value is proven
      // equal without a stored-row read, even with no local row at all.
      checkEqual(
        await a.api.readRows('tenants'),
        [],
        'the tenant row is absent locally',
      );
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
