/**
 * Sync rounds over the socket (SPEC.md §8.7; Appendix B.11): the
 * WebSocket binding is a second framing of the same handler — rounds
 * ride the realtime seam, registrations follow the round, and the §8.1
 * connect-before-first-pull no-fanout footgun is structurally dead.
 *
 * Readiness doctrine: every wait is an explicit completion promise at
 * the transport seam (rounds completed, deltas, acks, server close).
 * Zero sleeps, zero polls.
 */
import { REALTIME_TAG_ROUND } from '@syncular-v2/core';
import { check, checkEqual } from '../checks';
import { task } from '../fixture';
import { rawPullHeader, rawRequestBytes, rawSubscription } from '../raw';
import type { Scenario } from '../scenario';
import { expectConverged, seedTasks, syncIdle } from './util';

const P1 = { project_id: ['p1'] } as const;

function tagged(bytes: Uint8Array): Uint8Array {
  const out = new Uint8Array(bytes.length + 1);
  out[0] = REALTIME_TAG_ROUND;
  out.set(bytes, 1);
  return out;
}

export const wsRoundScenarios: readonly Scenario[] = [
  {
    name: 'ws-round/socket-round-equals-transport-round',
    specRefs: ['§1.1', '§8.7', 'B.11'],
    async run(ctx) {
      await seedTasks(ctx, [task('t1', 'p1', 'seed-1'), task('t2', 'p1')]);

      // Control client: rounds over the request/response transport seam.
      const a = await ctx.newClient({
        actorId: 'actor-a',
        clientId: 'client-a',
        allowed: P1,
      });
      await a.api.subscribe({ id: 'tasks', table: 'tasks', scopes: P1 });
      await syncIdle(a);

      // Socket client: connects first, every round rides the socket.
      const b = await ctx.newClient({
        actorId: 'actor-b',
        clientId: 'client-b',
        allowed: P1,
      });
      await b.api.connectRealtime();
      checkEqual(
        b.realtime.hellos[0]?.requiresSync,
        true,
        'a never-synced client is told to run a round (§8.1)',
      );
      await b.api.subscribe({ id: 'tasks', table: 'tasks', scopes: P1 });
      await syncIdle(b);
      check(
        b.realtime.roundsCompleted >= 1,
        'rounds actually rode the socket (§8.7), not the transport seam',
      );

      // Push over each binding; both drain their outboxes and converge.
      await b.api.mutate([
        { op: 'upsert', table: 'tasks', values: task('t3', 'p1', 'via-ws') },
      ]);
      await syncIdle(b);
      checkEqual(
        await b.api.pendingCommitIds(),
        [],
        'the outbox drained over the socket binding',
      );
      await a.api.mutate([
        { op: 'upsert', table: 'tasks', values: task('t4', 'p1', 'via-http') },
      ]);
      await syncIdle(a);
      await syncIdle(b);
      await syncIdle(a);

      await expectConverged(ctx, 'tasks', [a, b], {
        variable: 'project_id',
        values: ['p1'],
      });
      const subA = await a.api.subscriptionState('tasks');
      const subB = await b.api.subscriptionState('tasks');
      checkEqual(
        subB?.cursor,
        subA?.cursor,
        'both bindings advanced the same cursor — one handler, two framings',
      );
      checkEqual(
        b.realtime.deltaInterleavedDuringRound,
        false,
        'no delta interleaved a response stream (§8.7)',
      );
    },
  },

  {
    name: 'ws-round/first-round-registers-fanout',
    specRefs: ['§8.1', '§8.7', 'B.11'],
    async run(ctx) {
      // The dead footgun: connect realtime BEFORE the first-ever pull.
      // Under fixed-at-upgrade registration alone this connection would
      // silently never fan out; §8.7 registers at round end instead.
      const b = await ctx.newClient({
        actorId: 'actor-b',
        clientId: 'client-b',
        allowed: P1,
      });
      await b.api.connectRealtime();
      await b.api.subscribe({ id: 'tasks', table: 'tasks', scopes: P1 });
      await syncIdle(b);
      check(
        b.realtime.roundsCompleted >= 1,
        'the subscribing round rode this very connection',
      );

      await seedTasks(ctx, [task('t1', 'p1', 'fanned out')]);
      const commitSeq = await ctx.server.getMaxCommitSeq();
      // A DELTA — not a wake-up, not silence — with zero reconnects.
      await b.realtime.waitForDeltas(1);
      await b.realtime.waitForAck(commitSeq);
      checkEqual(
        (await b.api.readRows('tasks')).map((row) => row.rowId),
        ['t1'],
        'the delta applied on the round-registered connection',
      );
      await expectConverged(ctx, 'tasks', [b], {
        variable: 'project_id',
        values: ['p1'],
      });
    },
  },

  {
    name: 'ws-round/pipelined-round-drops-connection',
    specRefs: ['§8.7', 'B.11'],
    async run(ctx) {
      // Raw socket surface: drive the server session directly.
      await ctx.server.setAllowedScopes('actor-raw', P1);
      let closed = false;
      let closeResolve: () => void = () => {};
      const closePromise = new Promise<void>((resolve) => {
        closeResolve = resolve;
      });
      const result = await ctx.server.connectRealtime(
        'actor-raw',
        'client-raw',
        {
          onText: () => {},
          onBinary: () => {},
          onClose: () => {
            closed = true;
            closeResolve();
          },
        },
      );
      check(result.ok, 'raw realtime connect failed');
      if (!result.ok) return;
      const request = tagged(
        rawRequestBytes(
          [rawPullHeader(), rawSubscription('s1', 'tasks', P1, -1)],
          { clientId: 'client-raw' },
        ),
      );
      // First complete request starts a round; a second while its
      // response streams is pipelining — MUST NOT be processed, drops
      // the connection (§8.7).
      result.connection.sendBinary(request);
      result.connection.sendBinary(request);
      await closePromise;
      check(closed, 'the server closed the pipelining connection (§8.7)');
    },
  },

  {
    name: 'ws-round/commit-during-round-wakes-then-deltas-resume',
    specRefs: ['§8.2', '§8.7', 'B.11'],
    async run(ctx) {
      const b = await ctx.newClient({
        actorId: 'actor-b',
        clientId: 'client-b',
        allowed: P1,
      });
      await b.api.connectRealtime();
      await b.api.subscribe({ id: 'tasks', table: 'tasks', scopes: P1 });
      await syncIdle(b); // registers this connection (§8.7)

      // b's own push fans out to its own session MID-ROUND: §8.7 forbids
      // a 0x00 message inside the response stream, so the session takes
      // the §8.2 suppression path — a text wake-up, free to interleave.
      await b.api.mutate([
        { op: 'upsert', table: 'tasks', values: task('t1', 'p1', 'own') },
      ]);
      await syncIdle(b);
      checkEqual(
        b.realtime.deltasDelivered,
        0,
        'no standalone delta during the round (§8.7 interleaving)',
      );
      checkEqual(
        b.realtime.deltaInterleavedDuringRound,
        false,
        'nothing interleaved the response stream',
      );
      check(
        b.realtime.wakeReasons.includes('catchup-required'),
        'the mid-round commit degraded to a coalescible wake-up (§8.2)',
      );

      // The round's own pull half covered the commit, so the post-round
      // ack (§8.2 ack point) lifts suppression — deltas resume.
      const ownSeq = await ctx.server.getMaxCommitSeq();
      await b.realtime.waitForAck(ownSeq);
      await seedTasks(ctx, [task('t2', 'p1', 'resumed')]);
      const resumedSeq = await ctx.server.getMaxCommitSeq();
      await b.realtime.waitForDeltas(1);
      await b.realtime.waitForAck(resumedSeq);
      checkEqual(
        (await b.api.readRows('tasks')).map((row) => row.rowId),
        ['t1', 't2'],
        'suppressed window plus resumed deltas converged',
      );
      await expectConverged(ctx, 'tasks', [b], {
        variable: 'project_id',
        values: ['p1'],
      });
    },
  },
];
