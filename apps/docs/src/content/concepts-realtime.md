# Realtime & the WebSocket-native loop

Once connected, a client has one sync loop, and it runs over a WebSocket. The
WebSocket loop is the only realtime transport: a
[direction decision](https://github.com/syncular/syncular/blob/main/docs/ROADMAP.md)
to keep a single, well-tested path per concern.

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
- `POST /sync` stays fully conformant, for push-only producers, curl
  debugging, and server-to-server integration. Reference clients skip it in
  practice, and it adds zero protocol surface.
- Segment downloads are HTTP-only (the CDN bulk path).

## Deltas and wake-ups

When a commit lands that a connected client cares about, the server pushes it
as a **delta** (an ordinary sync response over the socket), and the client
applies it and acks. There is one delta kind and one JSON **wake-up** kind
(three reason codes: `catchup-required`, `delta-too-large`, `reset-required`)
that tells the client to run a pull soon; the wake-up itself carries no data
([SPEC §8.2/§8.3](https://github.com/syncular/syncular/blob/main/docs/SPEC.md#8-realtime)). Propagation on the in-process
bench is **0.2 ms p95** ([bench results](/benchmarks/)).

## The supported host supervisor

Realtime connection ownership is explicit, but applications do not need to
reinvent its lifecycle policy. `installRealtimeSupervisor()` owns exactly one
connection attempt, runs `syncUntilIdle()` before reporting `connected`,
reconnects initial failures and later socket closes with bounded exponential
backoff plus jitter, and cancels its work before `client.close()`.

Register durable subscription intent first, then install the supervisor:

```ts
import {
  browserConnectivitySignal,
  documentLifecycleSignal,
  installRealtimeSupervisor,
  realtimeSupervisorSnapshot,
  subscribeRealtimeSupervisor,
} from '@syncular/client';

await client.start();
client.subscribe({ id: 'notes', table: 'notes', scopes: { list_id: [listId] } });

installRealtimeSupervisor(client, {
  connectivity: browserConnectivitySignal(),
  lifecycle: documentLifecycleSignal(),
  // For encrypted/locked apps, also pass the host's protection signal. An
  // explicit signal fails closed until it reports `active`.
  protection,
});
```

Render local SQLite state immediately; do not make socket availability a
startup gate. The first successful connection performs the connect-then-sync
round over the socket, which registers the connection's subscriptions at round
end. Later reconnects perform the same explicit catch-up before the supervisor
publishes `connected`.

`browserConnectivitySignal()` observes online/offline and
`documentLifecycleSignal()` observes visibility/page lifecycle. React Native
hosts pass an `AppState`-backed signal; protected applications pass a signal
that publishes `preflight` before draining keys. Unknown browser connectivity
remains connectable, while an explicit protection signal remains suspended
until it is `active`.

```ts
const off = subscribeRealtimeSupervisor(client, renderConnectionState);
const state = realtimeSupervisorSnapshot(client);
// idle | connecting | connected | retrying | offline | background |
// protected | unsupported | stopped
```

The snapshot contains only the bounded phase, attempt, and library-owned retry
delay. Transport errors, URLs, identities, headers, and arbitrary server prose
are never copied into it. The lower-level `connectRealtime()` and
`disconnectRealtime()` remain available for custom hosts and are idempotent /
single-flight: repeated or concurrent connects cannot orphan another socket.

`autoSync` owns coalesced sync intents after wake-ups; the supervisor owns
socket lifecycle and resume catch-up. They are complementary. Without the
supervisor, HTTP remains an available round transport, but remote-only changes
do **not** converge continuously unless an actual host trigger runs a sync.

## Presence

The socket also carries **presence**: ephemeral, scope-keyed peer state
(who's here, what they're doing), held in memory only. A disconnect removes
the member ([SPEC §8.6](https://github.com/syncular/syncular/blob/main/docs/SPEC.md#86-presence)).

```ts
await client.setPresence('list:welcome', { editing: 'note-1' }); // join / update
await client.setPresence('list:welcome', null);                  // leave
const peers = await client.presence('list:welcome');             // [{ actorId, clientId, doc, … }]
```

Authorization uses the same registration as sync: you can publish to and
receive from a scope key only if your connection holds it. Publishing to an
unheld key returns `presence.forbidden`. Peers are identified as
`(actorId, clientId)`, visible only to scope-mates. In React,
`usePresence(scopeKey)` keeps the peer list live.
