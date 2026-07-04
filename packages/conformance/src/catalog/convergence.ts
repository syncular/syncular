/**
 * Convergence scenarios (SPEC.md Appendix B.1): two clients through one
 * server end up row- and version-identical with the server.
 */
import { check, checkEqual } from '../checks';
import { task } from '../fixture';
import type { Scenario } from '../scenario';
import { expectConverged, seedTasks, syncIdle, syncOk } from './util';

const P1 = { project_id: ['p1'] } as const;

export const convergenceScenarios: readonly Scenario[] = [
  {
    name: 'convergence/two-client-basic',
    specRefs: ['§2.2', '§4.5', '§6.4', '§7.2', 'B.1'],
    async run(ctx) {
      const a = await ctx.newClient({
        actorId: 'actor-a',
        clientId: 'client-a',
        allowed: P1,
      });
      const b = await ctx.newClient({
        actorId: 'actor-b',
        clientId: 'client-b',
        allowed: P1,
      });
      for (const c of [a, b]) {
        await c.api.subscribe({ id: 'tasks', table: 'tasks', scopes: P1 });
        await syncIdle(c);
      }

      await a.api.mutate([
        { op: 'upsert', table: 'tasks', values: task('t1', 'p1', 'hello') },
      ]);
      await a.api.mutate([
        {
          op: 'upsert',
          table: 'tasks',
          values: task('t2', 'p1', 'world', true, 3, '{"k":1}'),
        },
      ]);
      // §7.2: push and pull ride one combined request — a single round
      // drains the outbox AND returns the pusher's own server-versioned
      // rows (the v1 "repeated pull" gate intent).
      const report = await syncOk(a);
      checkEqual(report.pushed, 2, 'both outbox commits rode the request');
      checkEqual(report.applied.length, 2, 'both commits applied');
      checkEqual(
        await a.api.pendingCommitIds(),
        [],
        'outbox drained in the same round',
      );
      await expectConverged(ctx, 'tasks', [a], {
        variable: 'project_id',
        values: ['p1'],
      });

      await syncIdle(b);
      await expectConverged(ctx, 'tasks', [a, b], {
        variable: 'project_id',
        values: ['p1'],
      });
      const rows = await b.api.readRows('tasks');
      check(
        rows.every((row) => row.version === 1),
        'fresh inserts carry server_version 1 (§2.2)',
      );
    },
  },

  {
    name: 'convergence/interleaved-upserts-deletes',
    specRefs: ['§2.2', '§4.5', '§6.2', 'B.1'],
    async run(ctx) {
      const a = await ctx.newClient({
        actorId: 'actor-a',
        clientId: 'client-a',
        allowed: P1,
      });
      const b = await ctx.newClient({
        actorId: 'actor-b',
        clientId: 'client-b',
        allowed: P1,
      });
      for (const c of [a, b]) {
        await c.api.subscribe({ id: 'tasks', table: 'tasks', scopes: P1 });
        await syncIdle(c);
      }

      await a.api.mutate([
        { op: 'upsert', table: 'tasks', values: task('t1', 'p1', 'one') },
        { op: 'upsert', table: 'tasks', values: task('t2', 'p1', 'two') },
      ]);
      await syncIdle(a);
      await syncIdle(b);

      await b.api.mutate([
        { op: 'delete', table: 'tasks', rowId: 't1' },
        { op: 'upsert', table: 'tasks', values: task('t3', 'p1', 'three') },
      ]);
      await b.api.mutate([
        { op: 'upsert', table: 'tasks', values: task('t2', 'p1', 'two v2') },
      ]);
      await syncIdle(b);
      await syncIdle(a);

      await expectConverged(ctx, 'tasks', [a, b], {
        variable: 'project_id',
        values: ['p1'],
      });
      const rows = await a.api.readRows('tasks');
      checkEqual(
        rows.map((row) => row.rowId),
        ['t2', 't3'],
        'delete propagated, inserts survived',
      );
      checkEqual(
        rows.map((row) => row.version),
        [2, 1],
        'upsert incremented server_version by exactly 1 (§2.2)',
      );
    },
  },

  {
    name: 'convergence/quiet-subscription-cursor-advances',
    specRefs: ['§4.5'],
    async run(ctx) {
      const a = await ctx.newClient({
        actorId: 'actor-a',
        clientId: 'client-a',
        allowed: P1,
      });
      await a.api.subscribe({ id: 'tasks', table: 'tasks', scopes: P1 });
      await syncIdle(a);

      // Commits the subscription cannot see (other scope).
      await seedTasks(ctx, [task('x1', 'p2'), task('x2', 'p2')]);
      const maxSeq = await ctx.server.getMaxCommitSeq();

      const report = await syncOk(a);
      checkEqual(report.commitsApplied, 0, 'nothing matched the scope');
      const state = await a.api.subscriptionState('tasks');
      checkEqual(
        state?.cursor,
        maxSeq,
        'the cursor advances past unmatched commits — quiet subscriptions are cheap (§4.5)',
      );
      checkEqual(
        (await a.api.readRows('tasks')).length,
        0,
        'no cross-scope rows leaked',
      );
    },
  },
];
