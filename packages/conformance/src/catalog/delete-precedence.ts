/**
 * Delete precedence (SPEC.md §5.2; Appendix B.20): a delete inside the
 * tombstone horizon beats a concurrent unversioned upsert, an explicit
 * insert (`baseVersion = 0`) recreates above the deleted version, a
 * tombstone answers only an actor who could write the deleted row, and
 * pruning past the horizon restores the ordinary insert rule.
 */
import { encodeSparseRow, type RowColumn } from '@syncular/core';
import { check, checkEqual } from '../checks';
import { FIXTURE_SCHEMA, task } from '../fixture';
import { rawPushCommit, responsePushResults } from '../raw';
import type { Scenario, ScenarioContext } from '../scenario';
import { expectConverged, syncIdle, syncOk } from './util';

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

export const deletePrecedenceScenarios: readonly Scenario[] = [
  {
    name: 'delete-precedence/stale-patch-loses-to-delete',
    specRefs: ['§5.2', 'B.20'],
    async run(ctx) {
      const a = await bootstrapped(ctx, 'actor-a', 'client-a');
      const b = await bootstrapped(ctx, 'actor-b', 'client-b');
      await a.api.mutate([
        { op: 'upsert', table: 'tasks', values: task('t1', 'p1', 'seed') },
      ]);
      await syncIdle(a);
      await syncIdle(b);

      // A deletes; B holds a stale copy and patches without a baseVersion.
      await a.api.mutate([{ op: 'delete', table: 'tasks', rowId: 't1' }]);
      await syncIdle(a);
      const rejected = await b.api.patch('tasks', 't1', { title: 'too late' });
      const report = await syncOk(b);
      checkEqual(report.rejected, [rejected], 'the stale patch is rejected');
      checkEqual(
        (await b.api.rejections())[0]?.code,
        'sync.row_deleted',
        'delete precedence reports its own code (§5.2)',
      );
      checkEqual(
        (await ctx.server.readRows('tasks')).length,
        0,
        'the row stays absent on the server',
      );
      await syncIdle(a);
      await expectConverged(ctx, 'tasks', [a, b], {
        variable: 'project_id',
        values: ['p1'],
      });
      checkEqual(
        await b.api.readRows('tasks'),
        [],
        'the rejected patch removes the optimistic row locally (§7.2)',
      );
    },
  },

  {
    name: 'delete-precedence/explicit-insert-recreates',
    specRefs: ['§5.2', 'B.20'],
    async run(ctx) {
      const a = await bootstrapped(ctx, 'actor-a', 'client-a');
      await a.api.mutate([
        { op: 'upsert', table: 'tasks', values: task('t1', 'p1', 'seed') },
      ]);
      await syncIdle(a);
      await a.api.mutate([{ op: 'delete', table: 'tasks', rowId: 't1' }]);
      await syncIdle(a);

      // baseVersion 0 is explicit insert intent: it recreates over the
      // tombstone (§5.2 row 1).
      const applied = await a.api.mutate([
        {
          op: 'upsert',
          table: 'tasks',
          values: task('t1', 'p1', 'recreated'),
          baseVersion: 0,
        },
      ]);
      const report = await syncOk(a);
      check(
        report.applied.includes(applied),
        'the explicit insert applies over the tombstone',
      );
      const rows = await ctx.server.readRows('tasks');
      checkEqual(rows.length, 1, 'the row exists again');
      checkEqual(
        rows[0]?.version,
        2,
        'the recreated row starts above the deleted version (§6.2)',
      );
      checkEqual(
        rows[0]?.values.title,
        'recreated',
        'the insert carries its values',
      );
    },
  },

  {
    name: 'delete-precedence/stale-base-version-conflicts-after-recreate',
    specRefs: ['§6.2', 'B.20'],
    async run(ctx) {
      const a = await bootstrapped(ctx, 'actor-a', 'client-a');
      const b = await bootstrapped(ctx, 'actor-b', 'client-b');
      await a.api.mutate([
        { op: 'upsert', table: 'tasks', values: task('t1', 'p1', 'seed') },
      ]);
      await syncIdle(a);
      for (const title of ['v2', 'v3']) {
        await a.api.patch('tasks', 't1', { title });
        await syncIdle(a);
      }
      await syncIdle(b);

      // A deletes and recreates; B still holds the first incarnation at 3.
      await a.api.mutate([{ op: 'delete', table: 'tasks', rowId: 't1' }]);
      await syncIdle(a);
      await a.api.mutate([
        {
          op: 'upsert',
          table: 'tasks',
          values: task('t1', 'p1', 'new'),
          baseVersion: 0,
        },
      ]);
      await syncIdle(a);
      checkEqual(
        (await ctx.server.readRows('tasks'))[0]?.version,
        4,
        'the recreate starts above the deleted version 3',
      );

      const stale = await b.api.patch('tasks', 't1', { title: 'stale' }, 3);
      const report = await syncOk(b);
      checkEqual(report.rejected, [stale], 'the stale patch is rejected');
      checkEqual(
        (await b.api.conflicts())[0]?.code,
        'sync.version_conflict',
        'a baseVersion from the old incarnation conflicts',
      );
      checkEqual(
        (await ctx.server.readRows('tasks'))[0]?.values.title,
        'new',
        'the new incarnation keeps its values',
      );
    },
  },

  {
    // §6.2: a patch omitting its scope column is authorized against the
    // tombstone's stored scopes; an actor who fails them gets the answer for
    // a row id that never existed.
    name: 'delete-precedence/unauthorized-patch-cannot-see-the-tombstone',
    specRefs: ['§3.4', '§6.2', 'B.20'],
    requires: ['scope-authorization'],
    async run(ctx) {
      const a = await bootstrapped(ctx, 'actor-a', 'client-a');
      await a.api.mutate([
        { op: 'upsert', table: 'tasks', values: task('t1', 'p1', 'seed') },
      ]);
      await syncIdle(a);
      await a.api.mutate([{ op: 'delete', table: 'tasks', rowId: 't1' }]);
      await syncIdle(a);

      const columns = (FIXTURE_SCHEMA.tables.find(
        (table) => table.name === 'tasks',
      )?.columns ?? []) as readonly RowColumn[];
      const answer = async (actorId: string, rowId: string) => {
        const response = await ctx.rawSync(
          actorId,
          [
            rawPushCommit(`${actorId}-${rowId}`, [
              {
                table: 'tasks',
                rowId,
                op: 'upsert',
                // id and title present; project_id and the rest absent.
                payload: encodeSparseRow(
                  columns,
                  0,
                  columns.map((_, index) =>
                    index === 0 ? rowId : index === 2 ? 'patched' : undefined,
                  ),
                ),
              },
            ]),
          ],
          { clientId: actorId },
        );
        check(response.ok, 'the push request succeeds');
        if (!response.ok) return undefined;
        return responsePushResults(response.message)[0]?.results[0];
      };
      await ctx.server.setAllowedScopes('outsider', { project_id: ['p2'] });
      const deleted = await answer('outsider', 't1');
      checkEqual(
        deleted,
        await answer('outsider', 'never-existed'),
        'the deleted row answers like a row id that never existed',
      );
      checkEqual(
        deleted?.status === 'error' ? deleted.code : deleted?.status,
        'sync.row_missing',
        'the answer for an absent row (§6.2)',
      );
      const insider = await answer('actor-a', 't1');
      checkEqual(
        insider?.status === 'error' ? insider.code : insider?.status,
        'sync.row_deleted',
        'an actor inside the scope still meets the tombstone',
      );
    },
  },

  {
    name: 'delete-precedence/own-delete-rejects-the-whole-recreating-commit',
    specRefs: ['§5.2', '§7.2', 'B.20'],
    async run(ctx) {
      const a = await bootstrapped(ctx, 'actor-a', 'client-a');
      await a.api.mutate([
        { op: 'upsert', table: 'tasks', values: task('t1', 'p1', 'seed') },
      ]);
      await syncIdle(a);
      await a.api.mutate([{ op: 'delete', table: 'tasks', rowId: 't1' }]);
      await syncIdle(a);

      // The writer saw its own delete, yet an unversioned upsert still meets
      // the tombstone. The rejection takes the unrelated t2 down with it.
      const rejected = await a.api.mutate([
        { op: 'upsert', table: 'tasks', values: task('t1', 'p1', 'again') },
        { op: 'upsert', table: 'tasks', values: task('t2', 'p1', 'other') },
      ]);
      const report = await syncIdle(a);
      checkEqual(report.rejected, [rejected], 'the idle report lists it');
      checkEqual(
        (await a.api.rejections())[0]?.code,
        'sync.row_deleted',
        'the journal carries the code',
      );
      checkEqual(
        await a.api.readRows('tasks'),
        [],
        'the round removes every optimistic row of the commit (§7.2)',
      );
      checkEqual(
        (await ctx.server.readRows('tasks')).length,
        0,
        'the server applied nothing of the commit',
      );

      const applied = await a.api.mutate([
        {
          op: 'upsert',
          table: 'tasks',
          values: task('t1', 'p1', 'again'),
          baseVersion: 0,
        },
        { op: 'upsert', table: 'tasks', values: task('t2', 'p1', 'other') },
      ]);
      check(
        (await syncIdle(a)).applied.includes(applied),
        'an explicit insert recreates the row in the same commit',
      );
      checkEqual(
        (await ctx.server.readRows('tasks')).length,
        2,
        'both rows exist on the server',
      );
    },
  },

  {
    name: 'delete-precedence/pruned-tombstone-restores-the-insert-rule',
    specRefs: ['§4.6', '§5.2', 'B.20'],
    async run(ctx) {
      const a = await bootstrapped(ctx, 'actor-a', 'client-a');
      await a.api.mutate([
        { op: 'upsert', table: 'tasks', values: task('t1', 'p1', 'seed') },
      ]);
      await syncIdle(a);
      const b = await bootstrapped(ctx, 'actor-b', 'client-b');
      await a.api.mutate([{ op: 'delete', table: 'tasks', rowId: 't1' }]);
      await syncIdle(a);

      // An unversioned partial upsert against the fresh tombstone rejects.
      const blocked = await b.api.patch('tasks', 't1', { title: 'blocked' });
      const blockedReport = await syncOk(b);
      checkEqual(
        blockedReport.rejected,
        [blocked],
        'the tombstone rejects the unversioned patch',
      );
      checkEqual(
        (await b.api.rejections())[0]?.code,
        'sync.row_deleted',
        'delete precedence inside the horizon',
      );

      // Prune the whole log: the tombstone leaves with the commit (§4.6).
      const maxSeq = await ctx.server.getMaxCommitSeq();
      await ctx.server.advanceClock(60 * 60 * 1000);
      const horizon = await ctx.server.prune({
        activeWindowMs: 0,
        ageForceMs: 0,
        minRetainedCommits: 0,
      });
      checkEqual(horizon, maxSeq, 'the horizon advanced past the delete');

      // Beyond the horizon the insert rule applies: an unversioned FULL-row
      // upsert recreates (§5.2 row 4).
      const applied = await a.api.mutate([
        { op: 'upsert', table: 'tasks', values: task('t1', 'p1', 'fresh') },
      ]);
      // The first post-prune round pushes the insert and receives the
      // cursor reset; later rounds re-bootstrap.
      const first = await syncOk(a);
      check(
        first.applied.includes(applied),
        'the unversioned full-row upsert applied as an insert',
      );
      await syncIdle(a);
      const rows = await ctx.server.readRows('tasks');
      checkEqual(rows.length, 1, 'the insert rule applied');
      checkEqual(
        rows[0]?.version,
        1,
        'the recreated row restarts at version 1',
      );
      checkEqual(
        rows[0]?.values.title,
        'fresh',
        'the insert carries its values',
      );
      await syncIdle(a);
      await expectConverged(ctx, 'tasks', [a], {
        variable: 'project_id',
        values: ['p1'],
      });
    },
  },
];
