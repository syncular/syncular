/**
 * Windowed sync (SPEC.md §4.8, Appendix B.18 / DESIGN-eviction.md W1). A
 * client holds a partial local replica keyed by window units (scope
 * values); `setWindow` manages the value-sharded subscription family. These
 * scenarios pin the six behaviors the design enumerates: widen bootstraps
 * only the new unit, shrink evicts exactly the departed one (outbox-pinned
 * rows excepted), re-entry is a fresh writable bootstrap, value-sharded
 * replace touches only the delta, re-entry across a pruned horizon
 * converges — and the completeness oracle tells the truth throughout. The
 * server is never told of any eviction (evicted ≠ revoked).
 */
import { check, checkEqual } from '../checks';
import { task } from '../fixture';
import type { ClientHandle, Scenario } from '../scenario';
import { seedTasks, syncIdle, syncOk } from './util';

const BASE = { table: 'tasks', variable: 'project_id' } as const;

async function readIds(handle: ClientHandle): Promise<string[]> {
  return (await handle.api.readRows('tasks')).map((row) => row.rowId).sort();
}

async function windowUnits(handle: ClientHandle): Promise<string[]> {
  const state = await handle.api.windowState?.(BASE);
  return [...(state?.units ?? [])].sort();
}

export const windowScenarios: readonly Scenario[] = [
  {
    name: 'window/widen-bootstraps-only-the-new-unit',
    specRefs: ['§4.8', 'B.18a'],
    async run(ctx) {
      const a = await ctx.newClient({
        actorId: 'actor-a',
        clientId: 'client-a',
        allowed: { project_id: ['p1', 'p2'] },
      });
      await seedTasks(ctx, [
        task('t1', 'p1'),
        task('t2', 'p1'),
        task('t3', 'p2'),
      ]);
      await a.api.setWindow?.(BASE, ['p1']);
      await syncIdle(a);
      checkEqual(await readIds(a), ['t1', 't2'], 'only p1 windowed in');
      checkEqual(await windowUnits(a), ['p1'], 'registry holds p1 only');

      // Widen to include p2: p1's subscription is untouched (assert via the
      // bootstrap-rows-applied accounting — p1 is not re-downloaded).
      await a.api.setWindow?.(BASE, ['p1', 'p2']);
      const report = await syncOk(a);
      // The widen bootstraps exactly p2's rows (p1 untouched — no re-download).
      checkEqual(
        report.segmentRowsApplied,
        1,
        'the widen applied exactly p2 (t3) segment rows — p1 not re-bootstrapped',
      );
      await syncIdle(a);
      checkEqual(
        await readIds(a),
        ['t1', 't2', 't3'],
        'p2 rows are now present alongside the untouched p1 rows',
      );
      checkEqual(await windowUnits(a), ['p1', 'p2'], 'registry now p1,p2');
    },
  },

  {
    name: 'window/shrink-evicts-exactly-the-departed-unit',
    specRefs: ['§4.8', '§3.3', 'B.18b'],
    async run(ctx) {
      const a = await ctx.newClient({
        actorId: 'actor-a',
        clientId: 'client-a',
        allowed: { project_id: ['p1', 'p2'] },
      });
      await seedTasks(ctx, [task('t1', 'p1'), task('t2', 'p2')]);
      await a.api.setWindow?.(BASE, ['p1', 'p2']);
      await syncIdle(a);
      checkEqual(await readIds(a), ['t1', 't2'], 'both units windowed in');

      // Shrink to {p2}: p1 is evicted, p2 untouched.
      await a.api.setWindow?.(BASE, ['p2']);
      checkEqual(
        await readIds(a),
        ['t2'],
        'exactly p1 evicted; p2 rows untouched',
      );
      checkEqual(await windowUnits(a), ['p2'], 'registry drops p1');

      // The evicted unit is a window miss; p2 stays complete (oracle).
      const state = await a.api.windowState?.(BASE);
      check(
        !(state?.units.includes('p1') ?? false),
        'p1 is a window miss after eviction',
      );
      check(state?.units.includes('p2') ?? false, 'p2 stays complete');

      // The server was never told: t1 still lives server-side, unrevoked.
      const t1 = (await ctx.server.readRows('tasks')).find(
        (row) => row.rowId === 't1',
      );
      checkEqual(
        t1?.values.title,
        'task',
        'server retains t1 (evicted≠revoked)',
      );

      // p2 keeps syncing after the shrink — a new p2 row still arrives.
      await seedTasks(ctx, [task('t3', 'p2', 'new')]);
      await syncIdle(a);
      checkEqual(await readIds(a), ['t2', 't3'], 'p2 stays live after shrink');
    },
  },

  {
    name: 'window/outbox-pin-defers-eviction-until-drain',
    specRefs: ['§4.8', 'B.18c'],
    async run(ctx) {
      const a = await ctx.newClient({
        actorId: 'actor-a',
        clientId: 'client-a',
        allowed: { project_id: ['p1', 'p2'] },
      });
      await seedTasks(ctx, [
        task('t1', 'p1'),
        task('t2', 'p1'),
        task('t3', 'p2'),
      ]);
      await a.api.setWindow?.(BASE, ['p1', 'p2']);
      await syncIdle(a);

      // A pending offline write to a p1 row pins it (E1). Do NOT sync yet.
      await a.api.mutate([
        { op: 'upsert', table: 'tasks', values: task('t1', 'p1', 'edited') },
      ]);
      check(
        (await a.api.pendingCommitIds()).length === 1,
        'the p1 write is pending in the outbox',
      );

      // Shrink {p1,p2}→{p2}: t2 (p1, unpinned) is evicted now; t1 (pinned) stays.
      await a.api.setWindow?.(BASE, ['p2']);
      checkEqual(
        await readIds(a),
        ['t1', 't3'],
        'the pinned t1 survives; the unpinned t2 is evicted; p2 untouched',
      );

      // Push drains the outbox; the deferred eviction then completes.
      await syncIdle(a);
      checkEqual(
        await readIds(a),
        ['t3'],
        'after the pin drains, t1 is evicted too — only p2 remains',
      );
      checkEqual(
        await a.api.pendingCommitIds(),
        [],
        'the pinning commit drained',
      );
      // The write still landed server-side (the pin protected replay).
      const t1 = (await ctx.server.readRows('tasks')).find(
        (row) => row.rowId === 't1',
      );
      checkEqual(t1?.values.title, 'edited', 'the pinned write pushed fine');
    },
  },

  {
    name: 'window/re-entry-is-fresh-writable-bootstrap',
    specRefs: ['§4.8', '§5.6', '§6.2', 'B.18d'],
    async run(ctx) {
      const a = await ctx.newClient({
        actorId: 'actor-a',
        clientId: 'client-a',
        allowed: { project_id: ['p1', 'p2'] },
      });
      await seedTasks(ctx, [task('t1', 'p1', 'one'), task('t2', 'p2')]);
      await a.api.setWindow?.(BASE, ['p1', 'p2']);
      await syncIdle(a);
      // Evict p1.
      await a.api.setWindow?.(BASE, ['p2']);
      checkEqual(await readIds(a), ['t2'], 'p1 evicted');

      // Re-enter p1 — a fresh bootstrap re-delivers t1 with the server's
      // version (E2: no residual version cache; version comes from redelivery).
      await a.api.setWindow?.(BASE, ['p1', 'p2']);
      await syncIdle(a);
      checkEqual(await readIds(a), ['t1', 't2'], 're-entry re-delivered t1');
      const t1Server = (await ctx.server.readRows('tasks')).find(
        (row) => row.rowId === 't1',
      );
      const t1Local = (await a.api.readRows('tasks')).find(
        (row) => row.rowId === 't1',
      );
      checkEqual(
        t1Local?.version,
        t1Server?.version,
        'the re-entered row carries the server version (segment-seeded, C5)',
      );

      // An immediate baseVersion write using the segment-seeded version
      // applies cleanly — no commit delivery in between (E2 payoff).
      check(t1Local !== undefined, 're-entered t1 present locally');
      await a.api.mutate([
        {
          op: 'upsert',
          table: 'tasks',
          values: task('t1', 'p1', 'rewritten'),
          ...(t1Local !== undefined ? { baseVersion: t1Local.version } : {}),
        },
      ]);
      const report = await syncOk(a);
      checkEqual(
        report.rejected,
        [],
        'the optimistic write on the re-entered row applied cleanly',
      );
      const t1After = (await ctx.server.readRows('tasks')).find(
        (row) => row.rowId === 't1',
      );
      checkEqual(
        t1After?.values.title,
        'rewritten',
        'the re-entered row is writable immediately',
      );
    },
  },

  {
    name: 'window/value-sharded-replace-touches-only-the-delta',
    specRefs: ['§4.8', 'B.18e'],
    async run(ctx) {
      const a = await ctx.newClient({
        actorId: 'actor-a',
        clientId: 'client-a',
        allowed: { project_id: ['p1', 'p2', 'p3'] },
      });
      await seedTasks(ctx, [
        task('t1', 'p1'),
        task('t2', 'p2'),
        task('t2b', 'p2'),
        task('t3', 'p3'),
      ]);
      await a.api.setWindow?.(BASE, ['p1', 'p2']);
      await syncIdle(a);
      checkEqual(await readIds(a), ['t1', 't2', 't2b'], 'p1,p2 windowed in');

      // Replace {p1,p2}→{p2,p3}: evict p1, bootstrap p3, leave p2 alone.
      await a.api.setWindow?.(BASE, ['p2', 'p3']);
      const report = await syncOk(a);
      // The sharding proof: only p3's row is re-applied — p2 is not
      // re-bootstrapped (its cursor stayed honest). p3 has one row (t3).
      checkEqual(
        report.segmentRowsApplied,
        1,
        'replace re-downloaded only p3 (t3) — p2 untouched, the sharding win',
      );
      await syncIdle(a);
      checkEqual(
        await readIds(a),
        ['t2', 't2b', 't3'],
        'p1 evicted, p3 added, p2 intact',
      );
      checkEqual(await windowUnits(a), ['p2', 'p3'], 'registry now p2,p3');
    },
  },

  {
    name: 'window/completeness-pending-until-bootstrap',
    specRefs: ['§4.8', 'B.18g'],
    async run(ctx) {
      const a = await ctx.newClient({
        actorId: 'actor-a',
        clientId: 'client-a',
        allowed: { project_id: ['p1', 'p-empty'] },
      });
      await seedTasks(ctx, [task('t1', 'p1')]);

      // Registration alone is not completeness: between setWindow and the
      // bootstrap landing, both units are registered but PENDING — the gap
      // where a registry-membership verdict renders a false "empty" state.
      await a.api.setWindow?.(BASE, ['p1', 'p-empty']);
      const before = await a.api.windowState?.(BASE);
      checkEqual(
        [...(before?.units ?? [])].sort(),
        ['p-empty', 'p1'],
        'both units registered at setWindow',
      );
      checkEqual(
        [...(before?.pending ?? [])].sort(),
        ['p-empty', 'p1'],
        'both units pending before their bootstrap lands — not complete',
      );

      // After the bootstrap round every unit is complete — including the
      // unit with zero server rows (emptiness ≠ pendency).
      await syncIdle(a);
      const after = await a.api.windowState?.(BASE);
      checkEqual(
        [...(after?.units ?? [])].sort(),
        ['p-empty', 'p1'],
        'registration unchanged by the bootstrap',
      );
      checkEqual(
        [...(after?.pending ?? ['unread'])],
        [],
        'no unit pending after idle — the zero-row p-empty completed too',
      );
      checkEqual(
        await readIds(a),
        ['t1'],
        'p1 bootstrapped its row; p-empty is truthfully empty',
      );

      // Re-entry is a fresh bootstrap (§4.8): the verdict returns to
      // pending until that bootstrap completes; untouched units stay
      // complete throughout.
      await a.api.setWindow?.(BASE, ['p-empty']);
      await a.api.setWindow?.(BASE, ['p1', 'p-empty']);
      const reentry = await a.api.windowState?.(BASE);
      check(
        reentry?.pending.includes('p1') ?? false,
        're-entered p1 is pending again until its fresh bootstrap lands',
      );
      check(
        !(reentry?.pending.includes('p-empty') ?? true),
        'the untouched p-empty unit stays complete across the re-entry',
      );
      await syncIdle(a);
      const settled = await a.api.windowState?.(BASE);
      checkEqual(
        [...(settled?.pending ?? ['unread'])],
        [],
        'the re-entry bootstrap completed',
      );
    },
  },

  {
    name: 'window/re-entry-across-pruned-horizon-converges',
    specRefs: ['§4.8', '§4.6', '§4.7', 'B.18f'],
    async run(ctx) {
      const a = await ctx.newClient({
        actorId: 'actor-a',
        clientId: 'client-a',
        allowed: { project_id: ['p1', 'p2'] },
      });
      await seedTasks(ctx, [task('t1', 'p1', 'one'), task('t2', 'p2')]);
      await a.api.setWindow?.(BASE, ['p1', 'p2']);
      await syncIdle(a);
      // Evict p1.
      await a.api.setWindow?.(BASE, ['p2']);
      checkEqual(await readIds(a), ['t2'], 'p1 evicted');

      // Advance the log far past p1's old cursor, then prune the horizon.
      for (let i = 0; i < 6; i++) {
        await seedTasks(ctx, [task(`fill-${i}`, 'p2', `fill ${i}`)]);
      }
      await syncIdle(a);
      await ctx.server.prune({ minRetainedCommits: 1 });

      // Re-enter p1: a fresh bootstrap snapshots current state — correct at
      // any distance, independent of the pruned log (§4.7).
      await a.api.setWindow?.(BASE, ['p1', 'p2']);
      await syncIdle(a);
      const ids = await readIds(a);
      check(
        ids.includes('t1'),
        're-entered p1 converged past the pruned horizon',
      );
      const t1Local = (await a.api.readRows('tasks')).find(
        (row) => row.rowId === 't1',
      );
      const t1Server = (await ctx.server.readRows('tasks')).find(
        (row) => row.rowId === 't1',
      );
      checkEqual(
        t1Local?.version,
        t1Server?.version,
        'the re-entered row converged to the server version',
      );
    },
  },
];
