# Realtime & the WebSocket-native loop

A connected client runs its sync loop over one WebSocket; the socket is the
only realtime transport.

Normative detail: [SPEC.md §8](https://github.com/syncular/syncular/blob/main/docs/SPEC.md#8-realtime).

## Two bindings, one handler

`POST /sync` and the realtime socket are two **framings of the same
request/response semantics**. The socket carries sync rounds as tagged binary
byte streams driven by the same handler as the HTTP endpoint, so the protocol
treats the two identically ([SPEC §8.7](https://github.com/syncular/syncular/blob/main/docs/SPEC.md#87-websocket-native-sync-loop),
[§1.1](https://github.com/syncular/syncular/blob/main/docs/SPEC.md#11-endpoints)).
`RealtimeHubConfig` inherits the canonical server sync capabilities so CRDT
mergers, blob checks, validators, limits, leases, and events do not disappear
when a client selects the socket transport.

- **Reference clients sync exclusively over the socket** once connected.
- `POST /sync` stays conformant, for push-only producers, curl debugging,
  and server-to-server integration.
- Segment downloads are HTTP-only (the CDN bulk path).

## Deltas and wake-ups

When a commit lands that a connected client cares about, the server pushes it
as a **delta** (an ordinary sync response over the socket), and the client
applies it and acks. There is one delta kind and one JSON **wake-up** kind
(three reason codes: `catchup-required`, `delta-too-large`, `reset-required`)
that tells the client to run a pull soon; the wake-up itself carries no data
([SPEC §8.2/§8.3](https://github.com/syncular/syncular/blob/main/docs/SPEC.md#8-realtime)). Propagation on the in-process
bench is **0.2 ms p95** ([bench results](/benchmarks/)).

## The host supervisor

`installRealtimeSupervisor()` owns the socket lifecycle: one connection
attempt at a time, a `syncUntilIdle()` catch-up before it reports
`connected`, reconnection with bounded exponential backoff plus jitter, and
cancellation before `client.close()`. Hosts feed it connectivity, lifecycle,
and (for protected apps) protection signals; the wiring per host, the
observable state snapshot, and the lower-level `connectRealtime()` /
`disconnectRealtime()` calls are documented in
[Web (browser)](/platform-web/#the-realtime-supervisor). Without the
supervisor or an equivalent host trigger, remote changes do not converge
continuously.

## Control-plane boundaries

A session never blocks the socket on control-plane storage. An `ack` frame
updates the connection cursor in memory and queues the cursor write, so
`handleMessage` returns without waiting for storage. The host owns that
boundary and drains it before it lets go of the storage:

```ts
session.handleMessage(text);
await session.drain(); // queued cursor writes settled, first failure thrown
session.close();
```

`drain()` resolves once every queued cursor write has settled and throws the
first persistence failure instead of discarding it. The reference Workers
host awaits it inside each hibernatable event and before it closes a session;
any host that shuts a database down must await it too, or an ack can be
abandoned mid-write. `close()` stays synchronous and only disconnects the
session from the hub.

Membership changes need a different boundary. A session caches its
registrations and refreshes them on connect and at the end of a socket round
([SPEC §8.7](https://github.com/syncular/syncular/blob/main/docs/SPEC.md#87-websocket-native-sync-loop)),
so a commit fanout that lands after a host revokes an actor's access still
uses the cached grants until the client happens to run a round.
`RealtimeHub.refreshScopes(partition, actorId?)` is the host-initiated point
that closes that window:

```ts
await hub.refreshScopes(partition, actorId); // after a membership change
await hub.refreshScopes(partition); // after a connection change
```

It re-resolves the matching sessions through the hub's scope resolver and
reconciles presence exactly as a round end does. It fails closed: a session
whose resolver call fails, or whose client record cannot be read, loses every
registration instead of keeping its previous grants, so it receives no
further deltas until it re-registers. The round-end path deliberately keeps
the previous registrations when a round fails, because a failed round must
change nothing; the host-initiated path has the opposite job.

## Presence

The socket also carries **presence**: ephemeral, scope-keyed peer state
(who's here, what they're doing), held in memory only. A disconnect removes
the member ([SPEC §8.6](https://github.com/syncular/syncular/blob/main/docs/SPEC.md#86-presence)).

```ts
await client.setPresence('list:groceries', { editing: 'todo-1' }); // join / update
await client.setPresence('list:groceries', null);                  // leave
const peers = await client.presence('list:groceries');             // [{ actorId, clientId, doc, … }]
```

Authorization uses the same registration as sync: you can publish to and
receive from a scope key only if your connection holds it. Publishing to an
unheld key returns `presence.forbidden`. Peers are identified as
`(actorId, clientId)`, visible only to scope-mates. In React,
`usePresence(scopeKey)` keeps the peer list live.

`usePresence(scopeKey)` clears the previous peers when the client or scope
changes. Overlapping reads publish the newest requested snapshot; an older
response cannot replace it, including after the newer read fails. Cleanup
invalidates pending reads.
