/**
 * Realtime: handshake, binary deltas, scope-filtered fanout, wake-ups,
 * and catch-up (SPEC.md §8; Appendix B.7 within skeleton scope).
 *
 * Readiness doctrine: every wait here is an explicit completion promise
 * observed at the transport seam — a delivered delta, a wake-up, or the
 * client's ack after applying. Zero sleeps, zero polls.
 */
import { check, checkEqual } from '../checks';
import { task } from '../fixture';
import type { Scenario, ScenarioContext } from '../scenario';
import { expectConverged, seedTasks, syncIdle, syncOk } from './util';

const P1 = { project_id: ['p1'] } as const;

async function connectedClient(
  ctx: ScenarioContext,
  actorId: string,
  clientId: string,
) {
  const handle = await ctx.newClient({ actorId, clientId, allowed: P1 });
  await handle.api.subscribe({ id: 'tasks', table: 'tasks', scopes: P1 });
  await syncIdle(handle);
  return handle;
}

export const realtimeScenarios: readonly Scenario[] = [
  {
    name: 'realtime/delta-roundtrip-and-ack',
    specRefs: ['§8.1', '§8.2'],
    async run(ctx) {
      const a = await connectedClient(ctx, 'actor-a', 'client-a');
      const b = await connectedClient(ctx, 'actor-b', 'client-b');
      await b.api.connectRealtime();
      checkEqual(
        b.realtime.hellos[0]?.requiresSync,
        false,
        'a caught-up client needs no recovery pull (§8.1)',
      );

      await a.api.mutate([
        { op: 'upsert', table: 'tasks', values: task('t1', 'p1', 'live') },
      ]);
      await syncOk(a);
      const commitSeq = await ctx.server.getMaxCommitSeq();

      // Readiness: the delta was delivered, then applied (the ack).
      await b.realtime.waitForDeltas(1);
      await b.realtime.waitForAck(commitSeq);
      checkEqual(
        (await b.api.readRows('tasks')).map((row) => row.rowId),
        ['t1'],
        'the delta applied without any HTTP pull',
      );
      checkEqual(b.realtime.wakeReasons, [], 'no wake-up was needed');
      await expectConverged(ctx, 'tasks', [a, b], {
        variable: 'project_id',
        values: ['p1'],
      });
    },
  },

  {
    name: 'realtime/scope-filtered-fanout',
    specRefs: ['§8.1', '§8.2'],
    async run(ctx) {
      const b = await connectedClient(ctx, 'actor-b', 'client-b');
      await b.api.connectRealtime();

      // A commit outside the registration's scopes: no delta, no wake.
      await seedTasks(ctx, [task('x1', 'p2', 'other scope')]);
      // A matching commit afterwards: exactly one delta.
      await seedTasks(ctx, [task('t1', 'p1', 'mine')]);
      const commitSeq = await ctx.server.getMaxCommitSeq();

      await b.realtime.waitForAck(commitSeq);
      checkEqual(
        b.realtime.deltasDelivered,
        1,
        'only the matching commit fanned out (§8.2)',
      );
      checkEqual(
        (await b.api.readRows('tasks')).map((row) => row.rowId),
        ['t1'],
        'no cross-scope row reached the client',
      );
    },
  },

  {
    name: 'realtime/behind-session-wakes-then-deltas-resume',
    specRefs: ['§8.1', '§8.2', '§8.3', '§8.4', 'B.7'],
    async run(ctx) {
      const b = await connectedClient(ctx, 'actor-b', 'client-b');

      // The log moves while b is disconnected.
      await seedTasks(ctx, [task('t1', 'p1', 'missed')]);
      await b.api.connectRealtime();
      checkEqual(
        b.realtime.hellos[0]?.requiresSync,
        true,
        'a behind session must pull before trusting the socket (§8.1)',
      );
      check(await b.api.syncNeeded(), 'the client flagged the pull');

      // A matching commit while behind: a coalescible wake-up, NO delta —
      // deltas must be cursor-contiguous (§8.2).
      await seedTasks(ctx, [task('t2', 'p1', 'while behind')]);
      await b.realtime.waitForWakes(1);
      checkEqual(
        b.realtime.wakeReasons[0],
        'catchup-required',
        'the gap is bridged by a pull, not a delta',
      );
      checkEqual(b.realtime.deltasDelivered, 0, 'no non-contiguous delta');

      // The recovery pull applies both commits and acks; deltas resume.
      await syncIdle(b);
      const caughtUp = await ctx.server.getMaxCommitSeq();
      await b.realtime.waitForAck(caughtUp);
      await seedTasks(ctx, [task('t3', 'p1', 'resumed')]);
      const resumedSeq = await ctx.server.getMaxCommitSeq();
      await b.realtime.waitForDeltas(1);
      await b.realtime.waitForAck(resumedSeq);
      checkEqual(
        (await b.api.readRows('tasks')).map((row) => row.rowId),
        ['t1', 't2', 't3'],
        'catch-up plus resumed deltas converged',
      );
      await expectConverged(ctx, 'tasks', [b], {
        variable: 'project_id',
        values: ['p1'],
      });
    },
  },

  {
    name: 'realtime/oversize-delta-degrades-to-wake',
    specRefs: ['§8.2', '§8.3'],
    server: { limits: { maxDeltaBytes: 1 } },
    async run(ctx) {
      const b = await connectedClient(ctx, 'actor-b', 'client-b');
      await b.api.connectRealtime();

      await seedTasks(ctx, [task('t1', 'p1', 'too big for one byte')]);
      await b.realtime.waitForWakes(1);
      checkEqual(
        b.realtime.wakeReasons[0],
        'delta-too-large',
        'the oversize delta became a wake-up (§8.2 flow control)',
      );
      checkEqual(b.realtime.deltasDelivered, 0, 'the delta itself was dropped');
      check(await b.api.syncNeeded(), 'any wake-up means "pull soon" (§8.3)');

      await syncIdle(b);
      await expectConverged(ctx, 'tasks', [b], {
        variable: 'project_id',
        values: ['p1'],
      });
    },
  },
];
