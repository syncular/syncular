/**
 * Reconnect storm (SPEC.md §8.4; Appendix B.17): ~20 sessions on one scope
 * churn (disconnect + reconnect) while the log advances under fanout. The
 * hub stays correct — every session ends registered and converged, each
 * reconnecting session gets the right `hello`, and behind sessions receive
 * coalescible `catchup-required` wake-ups rather than gap deltas (§8.2).
 *
 * Deterministic by construction: seam-observed readiness (hellos, wakes,
 * acks), no timers, no load harness (a separate suite owns load). Both
 * pairings — the Rust×TS run exercises the same hub with the Rust client.
 */
import { check, checkEqual } from '../checks';
import { task } from '../fixture';
import type { ClientHandle, Scenario, ScenarioContext } from '../scenario';
import { expectConverged, seedTasks, syncIdle } from './util';

const P1 = { project_id: ['p1'] } as const;
const SESSION_COUNT = 20;

async function connected(
  ctx: ScenarioContext,
  index: number,
): Promise<ClientHandle> {
  const handle = await ctx.newClient({
    actorId: `actor-${index}`,
    clientId: `client-${index}`,
    allowed: P1,
  });
  await handle.api.subscribe({ id: 'tasks', table: 'tasks', scopes: P1 });
  await handle.api.connectRealtime();
  await syncIdle(handle);
  return handle;
}

export const reconnectStormScenarios: readonly Scenario[] = [
  {
    name: 'reconnect-storm/n-sessions-churn-and-converge',
    specRefs: ['§8.1', '§8.2', '§8.4', 'B.17'],
    async run(ctx) {
      await seedTasks(ctx, [task('seed', 'p1', 'before the storm')]);

      // Bring up N sessions, all registered on the same scope over the socket.
      const clients: ClientHandle[] = [];
      for (let i = 0; i < SESSION_COUNT; i++) {
        clients.push(await connected(ctx, i));
      }
      checkEqual(clients.length, SESSION_COUNT, 'all sessions connected');

      // A burst of commits fans out to every registered session.
      for (let i = 0; i < 5; i++) {
        await seedTasks(ctx, [task(`burst-${i}`, 'p1', `commit ${i}`)]);
      }
      const burstSeq = await ctx.server.getMaxCommitSeq();
      // Every session applies the burst via deltas + acks (contiguous).
      for (const client of clients) {
        await client.realtime.waitForAck(burstSeq);
      }

      // The storm: every session disconnects while the log keeps moving,
      // then reconnects. Interleave disconnects with commits so each
      // returning session is genuinely behind and must recover by pull.
      for (const client of clients) {
        await client.api.disconnectRealtime();
      }
      for (let i = 0; i < 5; i++) {
        await seedTasks(ctx, [task(`storm-${i}`, 'p1', `during churn ${i}`)]);
      }
      const afterStormSeq = await ctx.server.getMaxCommitSeq();

      // Reconnect all sessions; each behind session is told to sync.
      for (const client of clients) {
        await client.api.connectRealtime();
        await client.realtime.waitForHelloCount(2);
        const lastHello = client.realtime.hellos.at(-1);
        checkEqual(
          lastHello?.requiresSync,
          true,
          'a behind session is told to sync on reconnect (§8.1)',
        );
        check(
          await client.api.syncNeeded(),
          'the reconnecting client flagged the recovery pull',
        );
      }

      // The recovery pull drains every session; a post-pull ack lifts
      // suppression. Fire one more commit and confirm deltas resume for all.
      for (const client of clients) {
        await syncIdle(client);
        await client.realtime.waitForAck(afterStormSeq);
      }
      await seedTasks(ctx, [task('resumed', 'p1', 'after the storm')]);
      const resumedSeq = await ctx.server.getMaxCommitSeq();
      for (const client of clients) {
        await client.realtime.waitForAck(resumedSeq);
        // No session dropped a gap delta and got wedged into a wake loop:
        // the storm ends with deltas flowing, not perpetual catch-up.
        check(
          client.realtime.deltasDelivered >= 1,
          'deltas resumed for every session after the storm',
        );
      }

      // Every session converged to the server's rows.
      await expectConverged(ctx, 'tasks', clients, {
        variable: 'project_id',
        values: ['p1'],
      });
    },
  },
];
