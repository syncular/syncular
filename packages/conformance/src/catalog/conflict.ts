/**
 * Conflict shapes and resolution (SPEC.md §6.2–§6.5; Appendix B.6): the
 * protocol reports conflicts with the server row attached; resolution is
 * app policy, exercised here through the driver surface.
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

export const conflictScenarios: readonly Scenario[] = [
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
        conflict?.operation?.changedFields,
        ['title'],
        'patch intent survives the outbox and identifies the intentional field',
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
