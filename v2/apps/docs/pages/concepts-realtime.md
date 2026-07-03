# Realtime & the WebSocket-native loop

Once connected, a client has exactly **one** sync loop, and it runs over a
WebSocket. There is no polling mode and no degraded fallback loop — a
[direction decision](../../REVISE.md#direction-decisions-2026-07-03-confirmed-by-benjamin):
one good path per concern.

Normative detail: [SPEC.md §8](../../SPEC.md#8-realtime).

## Two bindings, one handler

`POST /sync` and the realtime socket are two **framings of the same
request/response semantics**. The socket carries sync rounds as tagged binary
byte streams driven by the same handler as the HTTP endpoint — nothing in the
protocol distinguishes the two ([SPEC §8.7](../../SPEC.md#87-websocket-native-sync-loop),
[§1.1](../../SPEC.md#11-endpoints)).

- **Reference clients sync exclusively over the socket** once connected.
- `POST /sync` stays fully conformant, for push-only producers, curl
  debugging, and server-to-server integration — clients just never touch it,
  and it adds zero protocol surface.
- Segment downloads are HTTP-only (the CDN bulk path).

## Deltas and wake-ups

When a commit lands that a connected client cares about, the server pushes it
as a **delta** — an ordinary sync response over the socket — and the client
applies it and acks. There is exactly one delta kind and one JSON **wake-up**
kind (three reason codes: `catchup-required`, `delta-too-large`,
`reset-required`) that means "run a pull soon," never carries data
([SPEC §8.2/§8.3](../../SPEC.md#8-realtime)). Propagation on the in-process
bench is **0.2 ms p95** ([bench results](../../bench/RESULTS.md)).

## Connect-then-sync

The reference boot order is: connect the socket first, then run the first sync
round *over* it. The round registers this connection's subscriptions at its
end, which structurally kills the old "connect-before-first-pull ⇒ silent
no-fanout" footgun. In client code that is simply:

```ts
await client.start();
client.subscribe({ id: 'notes', table: 'notes', scopes: { list_id: [listId] } });
await client.connectRealtime();
await client.syncUntilIdle();
```

After that, deltas arrive on their own; when the client's `onSyncNeeded`
fires (a wake-up), run another `sync()`. The [web client guide](/guide-client/)
shows the full host loop, including jittered wake coalescing.
