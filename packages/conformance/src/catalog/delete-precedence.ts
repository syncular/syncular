/**
 * Delete precedence (SPEC.md §5.2; Appendix B.20): a delete inside the
 * tombstone horizon beats a concurrent unversioned upsert, an explicit
 * insert (`baseVersion = 0`) recreates, and pruning past the horizon
 * restores the ordinary insert rule.
 */
import { check, checkEqual } from '../checks';
import { task } from '../fixture';
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
        1,
        'the recreated row restarts at version 1',
      );
      checkEqual(
        rows[0]?.values.title,
        'recreated',
        'the insert carries its values',
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
      await a.api.mutate([{ op: 'delete', table: 'tasks', rowId: 't1' }]);
      await syncIdle(a);

      // An unversioned partial upsert against the fresh tombstone rejects.
      const blocked = await a.api.patch('tasks', 't1', { title: 'blocked' });
      const blockedReport = await syncOk(a);
      checkEqual(
        blockedReport.rejected,
        [blocked],
        'the tombstone rejects the unversioned patch',
      );
      checkEqual(
        (await a.api.rejections())[0]?.code,
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
