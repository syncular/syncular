/**
 * Conflict shapes and resolution (SPEC.md §6.2–§6.5; Appendix B.6): the
 * protocol reports conflicts with the server row attached; resolution is
 * app policy, exercised here through the driver surface.
 */
import { check, checkEqual } from '../checks';
import { FIXTURE_SCHEMA, doc, task } from '../fixture';
import type { Scenario, ScenarioContext } from '../scenario';
import { expectConverged, seedRows, syncIdle, syncOk } from './util';

const P1 = { project_id: ['p1'] } as const;

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

const UNIQUE_SCHEMA = {
  ...FIXTURE_SCHEMA,
  tables: FIXTURE_SCHEMA.tables.map((table) =>
    table.name === 'tasks'
      ? {
          ...table,
          indexes: [
            {
              name: 'tasks_unique_title',
              columns: ['project_id', 'title'],
              unique: true,
            },
            {
              name: 'tasks_unique_priority',
              columns: ['project_id', 'priority'],
              unique: true,
            },
          ],
        }
      : table,
  ),
};

export const conflictScenarios: readonly Scenario[] = [
  {
    name: 'conflict/reconcile-only-changed-tables',
    specRefs: ['§7.1', '§7.2'],
    async run(ctx) {
      await seedRows(ctx, 'docs', [doc('d1', 'o1', 'p1', 'unchanged')]);
      const a = await ctx.newClient({
        actorId: 'actor-a',
        clientId: 'table-rebuild',
        allowed: { ...P1, org_id: ['o1'], projectId: ['p1'] },
        retainFailedCommits: true,
      });
      await a.api.subscribe({ id: 'tasks', table: 'tasks', scopes: P1 });
      await a.api.subscribe({
        id: 'docs',
        table: 'docs',
        scopes: { org_id: ['o1'], projectId: ['p1'] },
      });
      await syncIdle(a);
      const unchanged = await a.api.readRows('docs');
      await a.api.executeStorageSql?.(
        "CREATE TRIGGER untouched_docs BEFORE DELETE ON docs BEGIN SELECT RAISE(ABORT, 'unchanged table copied'); END",
      );
      await a.api.mutate([
        { op: 'upsert', table: 'tasks', values: task('t1', 'p1', 'new') },
      ]);
      await syncIdle(a);
      checkEqual(
        await a.api.readRows('docs'),
        unchanged,
        'acknowledgement and pull leave unrelated data untouched',
      );
      await expectConverged(ctx, 'tasks', [a]);
    },
  },

  {
    name: 'conflict/retained-distinct-id-unique-insert',
    specRefs: ['§7.2', '§7.2.1', '§3.3'],
    server: { schema: UNIQUE_SCHEMA },
    async run(ctx) {
      const a = await ctx.newClient({
        actorId: 'actor-a',
        clientId: 'unique-a',
        schema: UNIQUE_SCHEMA,
        allowed: P1,
      });
      const b = await ctx.newClient({
        actorId: 'actor-b',
        clientId: 'unique-b',
        schema: UNIQUE_SCHEMA,
        allowed: P1,
        retainFailedCommits: true,
      });
      for (const handle of [a, b]) {
        await handle.api.subscribe({ id: 'tasks', table: 'tasks', scopes: P1 });
        await syncIdle(handle);
      }
      for (const resolution of ['server', 'mine', 'edit', 'revoke'] as const) {
        const title = `unique-${resolution}`;
        const winner = `winner-${resolution}`;
        const loser = `loser-${resolution}`;
        await a.api.mutate([
          { table: 'tasks', op: 'upsert', values: task(winner, 'p1', title) },
        ]);
        const losing = await b.api.mutate([
          { table: 'tasks', op: 'upsert', values: task(loser, 'p1', title) },
        ]);
        await syncIdle(a);
        await syncIdle(b);
        await syncIdle(b);
        checkEqual(
          (await b.api.readRows('tasks')).some((row) => row.rowId === loser),
          false,
          'colliding intent stays outside physical rows',
        );
        let outcome = (await b.api.commitOutcomes()).find(
          (row) => row.clientCommitId === losing,
        );
        checkEqual(
          outcome?.retainedRows?.[0],
          {
            table: 'tasks',
            rowId: loser,
            localRow: task(loser, 'p1', title),
            serverRow: null,
            serverVersion: null,
            uniqueConflicts: [
              {
                index: 'tasks_unique_title',
                columns: ['project_id', 'title'],
                rowId: winner,
                serverRow: task(winner, 'p1', title),
                serverVersion: 1,
              },
            ],
          },
          'durable unique conflict identifies the authorized winner and unique key',
        );
        check(b.api.recreateWithSchema !== undefined, 'restart supported');
        await ctx.recreateClient(b, UNIQUE_SCHEMA);
        await syncIdle(b);
        outcome = (await b.api.commitOutcomes()).find(
          (row) => row.clientCommitId === losing,
        );
        checkEqual(
          outcome?.resolution,
          'active',
          'restart preserves active conflict',
        );
        if (resolution === 'revoke') {
          await ctx.server.setAllowedScopes('actor-b', { project_id: [] });
          await syncIdle(b);
          checkEqual(
            await b.api.readRows('tasks'),
            [],
            'revocation purges physical rows',
          );
          checkEqual(
            (await b.api.commitOutcomes()).find(
              (row) => row.clientCommitId === losing,
            )?.retainedRows,
            undefined,
            'revocation purges unique conflict evidence',
          );
        } else {
          const replacement =
            resolution === 'mine'
              ? await b.api.patch('tasks', winner, { done: true }, 1)
              : resolution === 'edit'
                ? await b.api.mutate([
                    {
                      table: 'tasks',
                      op: 'upsert',
                      values: task(loser, 'p1', `${title}-edited`),
                    },
                  ])
                : undefined;
          await b.api.resolveCommitOutcome(
            losing,
            replacement ? 'superseded' : 'resolved_keep_server',
            replacement,
          );
          await syncIdle(b);
          await syncIdle(a);
          await expectConverged(ctx, 'tasks', [a, b], {
            variable: 'project_id',
            values: ['p1'],
          });
        }
      }
    },
  },

  {
    name: 'conflict/version-conflict-resolution-paths',
    specRefs: ['§6.2', '§6.3', '§6.5', 'B.6'],
    async run(ctx) {
      const a = await bootstrapped(ctx, 'actor-a', 'client-a');
      const b = await bootstrapped(ctx, 'actor-b', 'client-b');

      await a.api.mutate([
        { op: 'upsert', table: 'tasks', values: task('t1', 'p1', 'base') },
      ]);
      await syncIdle(a);
      await syncIdle(b); // both at t1 v1

      // A wins the race: t1 → v2.
      await a.api.mutate([
        {
          op: 'upsert',
          table: 'tasks',
          values: task('t1', 'p1', 'a-wins'),
          baseVersion: 1,
        },
      ]);
      await syncIdle(a);

      // B pushes from the same stale base: conflict, not silent overwrite.
      const mLoser = await b.api.patch('tasks', 't1', { title: 'b-stale' }, 1);
      const report = await syncOk(b);
      checkEqual(report.rejected, [mLoser], 'the losing commit was rejected');
      checkEqual(report.conflicts, 1, 'exactly one conflict surfaced');
      const conflict = (await b.api.conflicts())[0];
      check(conflict !== undefined, 'conflict record exists');
      checkEqual(conflict?.code, 'sync.version_conflict', 'conflict code');
      checkEqual(conflict?.rowId, 't1', 'conflict rowId');
      checkEqual(conflict?.serverVersion, 2, 'current server version attached');
      checkEqual(
        conflict?.serverRow.title,
        'a-wins',
        'the server row rides the conflict record — no extra round-trip (§6.3)',
      );
      checkEqual(
        conflict?.conflictColumns,
        ['title'],
        'conflictColumns marks exactly the present columns that moved past baseVersion (§6.3)',
      );
      checkEqual(
        conflict?.operation?.present,
        ['id', 'title'],
        'the sparse operation\u2019s presence set survives the outbox (§7.2.1)',
      );

      // keep-server: apply nothing, just pull — local state equals server.
      await syncIdle(b);
      await expectConverged(ctx, 'tasks', [a, b], {
        variable: 'project_id',
        values: ['p1'],
      });

      // keep-local (explicit overwrite): re-push with the conflict's
      // serverVersion as the new base (§6.5).
      await b.api.mutate([
        {
          op: 'upsert',
          table: 'tasks',
          values: task('t1', 'p1', 'b-rebased'),
          baseVersion: conflict?.serverVersion ?? -1,
        },
      ]);
      await syncIdle(b);
      await syncIdle(a);
      const t1 = (await ctx.server.readRows('tasks')).find(
        (row) => row.rowId === 't1',
      );
      checkEqual(t1?.values.title, 'b-rebased', 'keep-local overwrote');
      checkEqual(t1?.version, 3, 'rebased push incremented from v2');
      await expectConverged(ctx, 'tasks', [a, b], {
        variable: 'project_id',
        values: ['p1'],
      });
    },
  },

  {
    name: 'conflict/insert-race-discloses-winner',
    specRefs: ['§6.2'],
    async run(ctx) {
      const a = await bootstrapped(ctx, 'actor-a', 'client-a');
      const b = await bootstrapped(ctx, 'actor-b', 'client-b');

      await a.api.mutate([
        {
          op: 'upsert',
          table: 'tasks',
          values: task('t1', 'p1', 'a-first'),
          baseVersion: 0,
        },
      ]);
      await syncIdle(a);

      // B raced the same insert and lost.
      const mLoser = await b.api.mutate([
        {
          op: 'upsert',
          table: 'tasks',
          values: task('t1', 'p1', 'b-second'),
          baseVersion: 0,
        },
      ]);
      const report = await syncOk(b);
      checkEqual(report.rejected, [mLoser], 'the losing insert was rejected');
      const conflict = (await b.api.conflicts())[0];
      checkEqual(
        conflict?.code,
        'sync.version_conflict',
        'a lost insert race is a conflict, not row_missing',
      );
      checkEqual(conflict?.serverVersion, 1, "the winner's version");
      checkEqual(conflict?.serverRow.title, 'a-first', "the winner's row");
      await syncIdle(b);
      await expectConverged(ctx, 'tasks', [a, b], {
        variable: 'project_id',
        values: ['p1'],
      });
    },
  },

  {
    name: 'conflict/sibling-operations-roll-back-atomically',
    specRefs: ['§6.4', '§6.5', 'B.6'],
    async run(ctx) {
      const a = await bootstrapped(ctx, 'actor-a', 'client-a');
      const b = await bootstrapped(ctx, 'actor-b', 'client-b');

      await a.api.mutate([
        { op: 'upsert', table: 'tasks', values: task('t1', 'p1', 'base') },
      ]);
      await syncIdle(a);
      await syncIdle(b);
      await a.api.mutate([
        {
          op: 'upsert',
          table: 'tasks',
          values: task('t1', 'p1', 'a-advanced'),
          baseVersion: 1,
        },
      ]);
      await syncIdle(a);

      // One commit: a conflicting update plus an innocent sibling insert.
      const mixed = await b.api.mutate([
        {
          op: 'upsert',
          table: 'tasks',
          values: task('t1', 'p1', 'b-stale'),
          baseVersion: 1,
        },
        { op: 'upsert', table: 'tasks', values: task('t9', 'p1', 'sibling') },
      ]);
      const report = await syncOk(b);
      checkEqual(report.rejected, [mixed], 'the whole commit was rejected');
      check(
        (await ctx.server.readRows('tasks')).every((row) => row.rowId !== 't9'),
        'the sibling insert rolled back with the commit (§6.4)',
      );

      // Rebase the WHOLE commit (§6.5) and converge.
      const conflict = (await b.api.conflicts())[0];
      await b.api.mutate([
        {
          op: 'upsert',
          table: 'tasks',
          values: task('t1', 'p1', 'b-merged'),
          baseVersion: conflict?.serverVersion ?? -1,
        },
        { op: 'upsert', table: 'tasks', values: task('t9', 'p1', 'sibling') },
      ]);
      await syncIdle(b);
      await syncIdle(a);
      const rowIds = (await ctx.server.readRows('tasks')).map((r) => r.rowId);
      checkEqual(rowIds, ['t1', 't9'], 'the rebased commit applied whole');
      await expectConverged(ctx, 'tasks', [a, b], {
        variable: 'project_id',
        values: ['p1'],
      });
    },
  },

  {
    name: 'conflict/base-version-on-absent-row-is-row-missing',
    specRefs: ['§6.2', '§10.2'],
    async run(ctx) {
      const a = await bootstrapped(ctx, 'actor-a', 'client-a');
      const m1 = await a.api.mutate([
        {
          op: 'upsert',
          table: 'tasks',
          values: task('ghost', 'p1', 'nope'),
          baseVersion: 5,
        },
      ]);
      const report = await syncOk(a);
      checkEqual(report.rejected, [m1], 'the commit was rejected');
      const rejection = (await a.api.rejections())[0];
      checkEqual(
        rejection?.code,
        'sync.row_missing',
        'baseVersion ≠ 0 against an absent row is row_missing, not conflict',
      );
      checkEqual(rejection?.retryable, false, 'row_missing is not retryable');
      checkEqual(
        (await ctx.server.readRows('tasks')).length,
        0,
        'nothing applied',
      );
    },
  },
];
