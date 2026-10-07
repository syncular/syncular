# Realtime & the WebSocket-native loop

A connected client runs its sync loop over one WebSocket, and the socket is the only realtime transport. This page is for developers who decide how a client behaves when the socket is up, down, or required, and for host authors who run the server side of it.

::meta{for="App developers and host authors" time="9 minutes" first="concepts-subscriptions" spec="8"}

:::terms
- **Delta**: An ordinary sync response the server pushes over the socket when a relevant commit lands.
- **Wake-up**: A JSON message with no data that tells the client to run a pull soon.
- **Realtime policy**: The client setting (`optional`, `required`, `off`) that decides what a round does when the socket is down.
- **Presence**: Ephemeral, scope-keyed peer state held in server memory.
- **Supervisor**: The host component that owns the socket lifecycle.
:::

:::figure{title="Two framings of one handler" note="Same request and response semantics" ticks}
<div class="d-cols-2">
<div class="d-box">
<p class="d-label">POST /sync</p>
<div class="d-stack">
<div class="node">Push-only producers, curl, server-to-server</div>
<div class="node">Carries rounds under <code>optional</code> while the socket is down</div>
</div>
</div>
<div class="d-box">
<p class="d-label">WebSocket · /realtime</p>
<div class="d-stack">
<div class="node ok">Sync rounds as tagged binary frames</div>
<div class="node cool">Deltas, wake-ups, presence</div>
</div>
</div>
</div>
<div class="node hot"><span class="t">One server sync handler</span>Same validators, limits, leases, CRDT mergers, and blob checks on both paths</div>

::caption[Segment downloads are HTTP only: the CDN bulk path. The reference clients sync exclusively over the socket once connected.]
:::

## Two bindings, one handler

`POST /sync` and the realtime socket are two framings of the same request and response semantics. The socket carries sync rounds as tagged binary byte streams, driven by the same handler as the HTTP endpoint, so the protocol treats the two identically ([SPEC §8.7](https://github.com/syncular/syncular/blob/main/docs/SPEC.md#87-websocket-native-sync-loop), [§1.1](https://github.com/syncular/syncular/blob/main/docs/SPEC.md#11-endpoints)). `RealtimeHubConfig` inherits the canonical server sync capabilities, so CRDT mergers, blob checks, validators, limits, leases, and events apply when a client selects the socket.

## Required realtime

`realtimePolicy` decides what a sync round does when the socket is not connected ([SPEC §8.8](https://github.com/syncular/syncular/blob/main/docs/SPEC.md#88-realtime-policy-and-connectivity-state)). The default is `optional`.

| Policy | Behavior |
|---|---|
| `optional` | A connected socket carries the round; otherwise the round uses `POST /sync`. |
| `required` | A connected socket carries the round. While the socket is down, `sync()` rejects with `RealtimeUnavailableError` and never uses `POST /sync`. |
| `off` | Rounds always use `POST /sync`, and `connectRealtime()` fails with `sync.invalid_request`. |

```ts title="src/sync.ts"
const client = new SyncClient({
  database,
  schema,
  clientId,
  transport: httpSyncTransport('/sync'),
  realtime: webSocketRealtimeConnector('wss://example.com/realtime?clientId={clientId}'),
  realtimePolicy: 'required', // the socket is the designated sync path
});
```

Use `required` when the application treats the socket as the designated sync path and a silently downgraded HTTP round would misrepresent the state of the world. `required` without a `realtime` connector fails at construction with `sync.invalid_request`. The worker handle and the Tauri and React Native create configs accept the same key and forward it to their client core. The Rust core exposes `set_realtime_policy`, `realtime_state()`, and `SyncOutcome::RealtimeUnavailable`.

### Connection states

`RealtimeUnavailableError` extends `ClientSyncError` and carries the state that refused the round.

:::figure{title="Realtime connection states"}
<div class="d-row">
<div class="node cool"><span class="t">connecting</span>One attempt in flight</div>
<span class="d-arrow"></span>
<div class="node ok"><span class="t">connected</span>Catch-up round done; reason and delay cleared</div>
</div>
<div class="d-cols-3">
<div class="node bad"><span class="t">lost</span>Socket closed without <code>disconnectRealtime()</code>. Carries a reason code.</div>
<div class="node bad"><span class="t">refused</span>A connect attempt failed. Carries a reason code.</div>
<div class="node"><span class="t">disconnected · disabled · unsupported</span>Deliberate disconnect, policy <code>off</code>, or a host without a socket</div>
</div>

::caption[`lost` and `refused` each schedule one background retry intent. Its delay is `retryDelayMs` on the error and on the diagnostics entry.]
:::

```ts title="src/sync.ts"
try {
  await client.sync();
} catch (error) {
  if (error instanceof RealtimeUnavailableError) {
    // error.state: 'connecting' | 'lost' | 'refused' | 'disconnected'
    // error.reasonCode: the stable code behind a lost or refused state
    // error.retryDelayMs: the delay of the background retry intent
  }
}
```

`diagnosticsSnapshot().host` reports the same vocabulary: `realtime` (`connected`, `connecting`, `disconnected`, `lost`, `refused`, `disabled`, or `unsupported`), `realtimePolicy`, `realtimeReasonCode`, and `realtimeRetryDelayMs`. `optional` also reports the explicit state, so an application can render "realtime connecting" or "realtime lost" without a policy change.

## Deltas and wake-ups

When a commit lands that a connected client cares about, the server pushes it as a delta: an ordinary sync response over the socket. The client applies it and acknowledges.

The protocol has one delta kind and one wake-up kind. The wake-up tells the client to run a pull soon and carries no data. It has three reason codes: `catchup-required`, `delta-too-large`, and `reset-required` ([SPEC §8.2 and §8.3](https://github.com/syncular/syncular/blob/main/docs/SPEC.md#8-realtime)). Realtime propagation latency is on [Benchmarks](/benchmarks/).

## The host supervisor

`installRealtimeSupervisor()` owns the socket lifecycle: one connection attempt at a time, a `syncUntilIdle()` catch-up before it reports `connected`, reconnection with bounded exponential backoff plus jitter, and cancellation before `client.close()`. Hosts feed it connectivity, lifecycle, and (for protected apps) protection signals. The wiring per host, the observable state snapshot, and the lower-level `connectRealtime()` and `disconnectRealtime()` calls are in [Web (browser)](/platform-web-realtime/#install-the-supervisor). Without the supervisor or an equivalent host trigger, remote changes do not converge continuously.

## Presence

The socket also carries presence: ephemeral, scope-keyed peer state (who is here, what they are doing), held in memory only. A disconnect removes the member ([SPEC §8.6](https://github.com/syncular/syncular/blob/main/docs/SPEC.md#86-presence)).

```ts title="src/presence.ts"
await client.setPresence('list:groceries', { editing: 'todo-1' }); // join or update
await client.setPresence('list:groceries', null);                  // leave
const peers = await client.presence('list:groceries');             // [{ actorId, clientId, doc, … }]
```

Authorization uses the same registration as sync. A connection publishes to and receives from a scope key only if it holds that key, and publishing to an unheld key returns `presence.forbidden`. Peers are identified as `(actorId, clientId)` and are visible only to scope-mates.

In React, `usePresence(scopeKey)` keeps the peer list live. It clears the previous peers when the client or scope changes. Overlapping reads publish the newest requested snapshot, and an older response cannot replace it, including after the newer read fails. Cleanup invalidates pending reads.

## Advanced: server host boundaries

### Control-plane writes

A session never blocks the socket on control-plane storage. An `ack` frame updates the connection cursor in memory and queues the cursor write, so `handleMessage` returns without waiting for storage. The host owns that boundary and drains it before it lets go of the storage.

```ts title="src/host.ts"
session.handleMessage(text);
await session.drain(); // queued cursor writes settled, first failure thrown
session.close();
```

`drain()` resolves once every queued cursor write has settled and throws the first persistence failure instead of discarding it. The reference Workers host awaits it inside each hibernatable event and before it closes a session. Any host that shuts a database down must await it too, or an ack can be abandoned mid-write. `close()` stays synchronous and only disconnects the session from the hub.

### Membership changes

A session caches its registrations and refreshes them on connect and at the end of a socket round ([SPEC §8.7](https://github.com/syncular/syncular/blob/main/docs/SPEC.md#87-websocket-native-sync-loop)). A commit fanout that lands after a host revokes an actor's access therefore still uses the cached grants until the client runs a round. `RealtimeHub.refreshScopes(partition, actorId?)` is the host-initiated point that closes that window.

```ts title="src/host.ts"
await hub.refreshScopes(partition, actorId); // after a membership change
await hub.refreshScopes(partition);          // after a connection change
```

`refreshScopes` re-resolves the matching sessions through the hub's scope resolver and reconciles presence as a round end does. It fails closed: a session whose resolver call fails, or whose client record cannot be read, loses every registration and receives no further deltas until it registers again. The round-end path keeps the previous registrations when a round fails, because a failed round must change nothing. The host-initiated path has the opposite job.
