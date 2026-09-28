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
import { ScenarioSkip, type Scenario, type ScenarioContext } from '../scenario';
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
    name: 'realtime/reversed-notifications-recover-before-resuming-deltas',
    specRefs: ['§8.2', '§8.3', '§8.4'],
    requires: ['concurrent-storage-faults'],
    async run(ctx) {
      const client = await connectedClient(ctx, 'reader', 'reader');
      await client.api.connectRealtime();
      await ctx.server.reverseNextCommitNotifications!();
      await seedTasks(ctx, [task('t1', 'p1', 'first')]);
      await seedTasks(ctx, [task('t2', 'p1', 'second')]);
      await client.realtime.waitForWakes(2);
      checkEqual(
        client.realtime.deltasDelivered,
        0,
        'no delta crosses the missing notification',
      );
      check(await client.api.syncNeeded(), 'the wake schedules catch-up');
      await syncIdle(client);
      await client.realtime.waitForAck(await ctx.server.getMaxCommitSeq());
      await seedTasks(ctx, [task('t3', 'p1', 'resumed')]);
      await client.realtime.waitForDeltas(1);
      await client.realtime.waitForAck(await ctx.server.getMaxCommitSeq());
      await expectConverged(ctx, 'tasks', [client], {
        variable: 'project_id',
        values: ['p1'],
      });
    },
  },
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

  {
    name: 'realtime/required-policy-refuses-http-without-a-socket',
    specRefs: ['§8.7', '§8.8'],
    async run(ctx) {
      const handle = await ctx.newClient({
        actorId: 'actor-required',
        clientId: 'client-required',
        realtimePolicy: 'required',
      });
      await handle.api.subscribe({ id: 'tasks', table: 'tasks', scopes: P1 });
      const denied = await handle.api.sync();
      check(!denied.ok, 'a required round without a socket cannot succeed');
      if (!denied.ok) {
        checkEqual(
          denied.errorCode,
          'sync.realtime_unavailable',
          'the refusal is the typed §8.8 code',
        );
        checkEqual(
          denied.realtimeState,
          'disconnected',
          'the refusal names the availability state',
        );
        check(
          denied.retryDelayMs !== undefined && denied.retryDelayMs > 0,
          'the refusal carries the next retry delay',
        );
      }
      checkEqual(
        handle.sentRequests.length,
        0,
        'required never falls back to an HTTP sync round',
      );
      const diagnostics = await handle.api.diagnosticsSnapshot?.();
      checkEqual(
        diagnostics?.host.realtime,
        'disconnected',
        'diagnostics expose the explicit state',
      );
      checkEqual(
        diagnostics?.host.realtimePolicy,
        'required',
        'diagnostics expose the configured policy',
      );
    },
  },

  {
    name: 'realtime/required-policy-refuses-after-socket-loss',
    specRefs: ['§8.8'],
    async run(ctx) {
      const handle = await ctx.newClient({
        actorId: 'actor-loss',
        clientId: 'client-loss',
        realtimePolicy: 'required',
      });
      if (handle.api.loseRealtime === undefined) {
        throw new ScenarioSkip('client driver has no realtime loss injection');
      }
      await handle.api.subscribe({ id: 'tasks', table: 'tasks', scopes: P1 });
      await handle.api.connectRealtime();
      await syncIdle(handle);
      checkEqual(
        handle.sentRequests.length,
        0,
        'the boot round rode the socket',
      );

      await handle.api.loseRealtime();
      const failed = await handle.api.sync();
      check(!failed.ok, 'the round on the dead socket cannot succeed');
      const refused = await handle.api.sync();
      check(!refused.ok, 'the required round after the loss is refused');
      if (!refused.ok) {
        checkEqual(
          refused.errorCode,
          'sync.realtime_unavailable',
          'the refusal is the typed §8.8 code',
        );
        checkEqual(
          refused.realtimeState,
          'lost',
          'the loss is the explicit state',
        );
        check(
          typeof refused.realtimeReasonCode === 'string' &&
            refused.realtimeReasonCode.length > 0,
          'the loss carries its reason code',
        );
      }
      checkEqual(
        handle.sentRequests.length,
        0,
        'required never falls back to HTTP after a loss',
      );
      const diagnostics = await handle.api.diagnosticsSnapshot?.();
      checkEqual(
        diagnostics?.host.realtime,
        'lost',
        'diagnostics report the loss',
      );
      check(
        typeof diagnostics?.host.realtimeReasonCode === 'string' &&
          diagnostics.host.realtimeReasonCode.length > 0,
        'diagnostics carry the loss reason',
      );

      await handle.api.connectRealtime();
      await syncIdle(handle);
      checkEqual(
        handle.sentRequests.length,
        0,
        'the reconnected round rode the socket',
      );
      checkEqual(
        (await handle.api.diagnosticsSnapshot?.())?.host.realtime,
        'connected',
        'reconnect returns the state to connected',
      );
    },
  },

  {
    name: 'realtime/required-policy-exposes-a-refused-handshake',
    specRefs: ['§8.8'],
    async run(ctx) {
      const handle = await ctx.newClient({
        actorId: 'actor-refused',
        clientId: 'client-refused',
        realtimePolicy: 'required',
      });
      handle.faults.refuseNextRealtimeConnect = true;
      let connectRefused = false;
      try {
        await handle.api.connectRealtime();
      } catch {
        connectRefused = true;
      }
      check(connectRefused, 'the refused handshake surfaces to the host');

      const denied = await handle.api.sync();
      check(
        !denied.ok,
        'the required round after a refused handshake is refused',
      );
      if (!denied.ok) {
        checkEqual(
          denied.errorCode,
          'sync.realtime_unavailable',
          'the refusal is the typed §8.8 code',
        );
        checkEqual(
          denied.realtimeState,
          'refused',
          'the failed attempt is the explicit state',
        );
        checkEqual(
          denied.realtimeReasonCode,
          'transport.lost',
          'the refusal carries the transport reason',
        );
      }
      checkEqual(
        handle.sentRequests.length,
        0,
        'required never falls back to HTTP after a refused handshake',
      );
      const diagnostics = await handle.api.diagnosticsSnapshot?.();
      checkEqual(
        diagnostics?.host.realtime,
        'refused',
        'diagnostics report the refused state',
      );
      checkEqual(
        diagnostics?.host.realtimeReasonCode,
        'transport.lost',
        'diagnostics carry the refusal reason',
      );

      await handle.api.connectRealtime();
      checkEqual(
        (await handle.api.diagnosticsSnapshot?.())?.host.realtime,
        'connected',
        'the next attempt connects',
      );
    },
  },

  {
    name: 'realtime/required-policy-reconnect-restores-socket-rounds',
    specRefs: ['§8.4', '§8.8'],
    async run(ctx) {
      const handle = await ctx.newClient({
        actorId: 'actor-reconnect',
        clientId: 'client-reconnect',
        realtimePolicy: 'required',
      });
      await handle.api.subscribe({ id: 'tasks', table: 'tasks', scopes: P1 });
      await handle.api.connectRealtime();
      await syncIdle(handle);
      checkEqual(
        handle.sentRequests.length,
        0,
        'the boot round rode the socket',
      );

      await handle.api.disconnectRealtime();
      const denied = await handle.api.sync();
      check(!denied.ok, 'a deliberate disconnect refuses the required round');
      if (!denied.ok) {
        checkEqual(
          denied.realtimeState,
          'disconnected',
          'a deliberate disconnect is not a loss',
        );
      }
      checkEqual(
        handle.sentRequests.length,
        0,
        'the deliberate disconnect never falls back to HTTP',
      );

      await handle.api.connectRealtime();
      await syncIdle(handle);
      checkEqual(
        handle.sentRequests.length,
        0,
        'reconnect restored socket rounds',
      );
      checkEqual(
        (await handle.api.diagnosticsSnapshot?.())?.host.realtime,
        'connected',
        'the state returns to connected',
      );
    },
  },
];
