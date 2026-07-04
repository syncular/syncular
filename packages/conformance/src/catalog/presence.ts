/**
 * Presence (SPEC.md §8.6; Appendix B.16): ephemeral scope-keyed presence
 * over the socket. Lifecycle (join/update/leave incl. disconnect), the
 * cross-scope privacy probe, feature-off silence, and survival across a
 * §8.7 sync round on the same socket. Both pairings.
 *
 * Readiness doctrine: every wait is a seam-observed presence event
 * (`waitForPresence`) — zero sleeps, zero polls (§8.6.5).
 */
import { check, checkEqual } from '../checks';
import { task } from '../fixture';
import type { ClientHandle, Scenario, ScenarioContext } from '../scenario';
import { seedTasks, syncIdle } from './util';

const P1 = { project_id: ['p1'] } as const;
const P2 = { project_id: ['p2'] } as const;
const KEY_P1 = 'project:p1';
const KEY_P2 = 'project:p2';

async function connectedOn(
  ctx: ScenarioContext,
  actorId: string,
  clientId: string,
  scopes: Record<string, readonly string[]>,
): Promise<ClientHandle> {
  // The actor is allowed both scopes; the SUBSCRIPTION picks the key, so
  // presence grants follow the registration (§8.6.3), not the actor.
  const handle = await ctx.newClient({
    actorId,
    clientId,
    allowed: { project_id: ['p1', 'p2'] },
  });
  await handle.api.subscribe({ id: 'tasks', table: 'tasks', scopes });
  await handle.api.connectRealtime();
  await syncIdle(handle); // §8.7: the first socket round registers the sub
  return handle;
}

function peerDocs(peers: readonly { doc: Record<string, unknown> }[]) {
  return peers.map((p) => p.doc);
}

export const presenceScenarios: readonly Scenario[] = [
  {
    name: 'presence/lifecycle-join-update-leave-disconnect',
    specRefs: ['§8.6.1', '§8.6.2', '§8.6.4', 'B.16'],
    async run(ctx) {
      await seedTasks(ctx, [task('t1', 'p1', 'seed')]);
      const a = await connectedOn(ctx, 'actor-a', 'client-a', P1);
      const b = await connectedOn(ctx, 'actor-b', 'client-b', P1);

      // A publishes → B sees a join with A's identity + doc.
      await a.api.setPresence?.(KEY_P1, { cursor: 1, name: 'Ada' });
      await b.realtime.waitForPresence(1);
      let peers = (await b.api.presence?.(KEY_P1)) ?? [];
      checkEqual(peers.length, 1, 'B sees exactly one peer (A)');
      checkEqual(peers[0]?.clientId, 'client-a', 'the peer is A');
      checkEqual(
        peers[0]?.doc,
        { cursor: 1, name: 'Ada' },
        "B holds A's presence document",
      );
      // A never sees its own fanout.
      checkEqual(
        ((await a.api.presence?.(KEY_P1)) ?? []).length,
        0,
        'a publisher never receives its own presence',
      );

      // A republishes → B sees an update (still one peer, new doc).
      await a.api.setPresence?.(KEY_P1, { cursor: 2, name: 'Ada' });
      await b.realtime.waitForPresence(2);
      peers = (await b.api.presence?.(KEY_P1)) ?? [];
      checkEqual(peers.length, 1, 'an update does not duplicate the peer');
      checkEqual(peers[0]?.doc, { cursor: 2, name: 'Ada' }, 'the doc updated');

      // A clears (doc: null) → B sees a leave.
      await a.api.setPresence?.(KEY_P1, null);
      await b.realtime.waitForPresence(3);
      checkEqual(
        ((await b.api.presence?.(KEY_P1)) ?? []).length,
        0,
        'an explicit leave removes the peer',
      );

      // A republishes then disconnects → B sees a leave (disconnect ⇒ leave).
      await a.api.setPresence?.(KEY_P1, { cursor: 3 });
      await b.realtime.waitForPresence(4);
      checkEqual(
        ((await b.api.presence?.(KEY_P1)) ?? []).length,
        1,
        'A is present again before the drop',
      );
      await a.api.disconnectRealtime();
      await b.realtime.waitForPresence(5);
      checkEqual(
        ((await b.api.presence?.(KEY_P1)) ?? []).length,
        0,
        'disconnect implies leave (§8.6.1)',
      );

      // A late joiner receives the snapshot join-burst of who is present.
      await b.api.setPresence?.(KEY_P1, { cursor: 9, name: 'Bo' });
      const c = await connectedOn(ctx, 'actor-c', 'client-c', P1);
      await c.realtime.waitForPresence(1);
      const seen = (await c.api.presence?.(KEY_P1)) ?? [];
      checkEqual(seen.length, 1, 'the late joiner sees B via the snapshot');
      checkEqual(seen[0]?.clientId, 'client-b', 'the snapshot names B');
      checkEqual(
        seen[0]?.doc,
        { cursor: 9, name: 'Bo' },
        'snapshot carries the doc',
      );
    },
  },

  {
    name: 'presence/cross-scope-isolation-privacy-probe',
    specRefs: ['§8.6.3', 'B.16'],
    async run(ctx) {
      const a = await connectedOn(ctx, 'actor-a', 'client-a', P1);
      const d = await connectedOn(ctx, 'actor-d', 'client-d', P2);

      // A publishes on p1 — D (on p2) must never see it.
      await a.api.setPresence?.(KEY_P1, { x: 1 });
      // D publishes on p2 — A (on p1) must never see it.
      await d.api.setPresence?.(KEY_P2, { y: 2 });
      // Each client sees its own scope-mate set is empty (no peers on the
      // key it holds), and never the other's traffic.
      checkEqual(
        ((await d.api.presence?.(KEY_P1)) ?? []).length,
        0,
        "D never learns A's p1 presence (no leak to a non-scope-mate)",
      );
      checkEqual(
        ((await a.api.presence?.(KEY_P2)) ?? []).length,
        0,
        "A never learns D's p2 presence",
      );
      checkEqual(
        d.realtime.presenceEvents.length,
        0,
        'D received no presence fanout at all',
      );

      // D cannot publish onto p1 (an unheld key): the server rejects loudly
      // with presence.forbidden, fans out nothing.
      await d.api.setPresence?.(KEY_P1, { evil: true });
      await d.realtime.waitForPresence(1);
      const err = d.realtime.presenceEvents.find(
        (e) => typeof e.error === 'string',
      );
      checkEqual(
        err?.error,
        'presence.forbidden',
        'publishing to an unheld key is rejected (§8.6.3)',
      );
      checkEqual(
        ((await a.api.presence?.(KEY_P1)) ?? []).length,
        0,
        "A saw nothing from D's forbidden publish",
      );
    },
  },

  {
    name: 'presence/feature-off-silence',
    specRefs: ['§8.1', '§8.6', 'B.16'],
    async run(ctx) {
      await seedTasks(ctx, [task('t1', 'p1', 'seed')]);
      // A uses presence; B never touches it (the feature-off peer).
      const a = await connectedOn(ctx, 'actor-a', 'client-a', P1);
      const b = await connectedOn(ctx, 'actor-b', 'client-b', P1);

      await a.api.setPresence?.(KEY_P1, { cursor: 1 });
      await b.realtime.waitForPresence(1);

      // B's own sync is undisturbed by presence traffic: a fresh commit
      // still fans out as a delta and applies.
      await seedTasks(ctx, [task('t2', 'p1', 'live')]);
      const commitSeq = await ctx.server.getMaxCommitSeq();
      await b.realtime.waitForDeltas(1);
      await b.realtime.waitForAck(commitSeq);
      checkEqual(
        (await b.api.readRows('tasks')).map((r) => r.rowId).sort(),
        ['t1', 't2'],
        'presence traffic did not disturb the delta path (§8.6 rides text)',
      );
      check(
        b.realtime.wakeReasons.length === 0,
        'no spurious wake-up from presence',
      );
    },
  },

  {
    name: 'presence/survives-a-socket-sync-round',
    specRefs: ['§8.6.3', '§8.7', 'B.16'],
    async run(ctx) {
      await seedTasks(ctx, [task('t1', 'p1', 'seed')]);
      const a = await connectedOn(ctx, 'actor-a', 'client-a', P1);
      const b = await connectedOn(ctx, 'actor-b', 'client-b', P1);

      // Both are present.
      await a.api.setPresence?.(KEY_P1, { who: 'a' });
      await b.api.setPresence?.(KEY_P1, { who: 'b' });
      await a.realtime.waitForPresence(1);
      await b.realtime.waitForPresence(1);

      // A interleaves a full §8.7 round (push + pull) on the SAME socket.
      await a.api.mutate([
        { op: 'upsert', table: 'tasks', values: task('t2', 'p1', 'via-round') },
      ]);
      await syncIdle(a);
      checkEqual(
        await a.api.pendingCommitIds(),
        [],
        'the round drained over the socket (§8.7)',
      );

      // Presence survived the round: A still observes B, B still observes A
      // (the round re-registered the same scope, re-deriving the grant).
      checkEqual(
        peerDocs((await a.api.presence?.(KEY_P1)) ?? []),
        [{ who: 'b' }],
        "A still sees B's presence after its own round",
      );
      // A can still publish an update post-round and B observes it.
      await a.api.setPresence?.(KEY_P1, { who: 'a2' });
      await b.realtime.waitForPresence(2);
      checkEqual(
        peerDocs((await b.api.presence?.(KEY_P1)) ?? []),
        [{ who: 'a2' }],
        'presence publishing works across the round boundary',
      );
    },
  },
];
