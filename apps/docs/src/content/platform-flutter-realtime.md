# Realtime & lifecycle (Flutter)

Receive change events, connect realtime, and tie the client's lifetime to `AppLifecycleState` and the device's network.

::meta{for="Flutter developers wiring sync into app lifecycle" time="7 minutes"}

:::figure{title="The client's three states" note="Database and outbox survive all of them" ticks}
<div class="d-row">
<div class="node ok"><span class="t">Running</span>poll timer drains events,<br>realtime socket open</div>
<span class="d-arrow"></span>
<div class="node cool"><span class="t">Paused</span><code>pause()</code>: timer cancelled,<br>socket closed, <code>mutate</code> still queues</div>
<span class="d-arrow"></span>
<div class="node bad"><span class="t">Closed</span><code>close()</code>: core freed, stream closed,<br>commands throw <code>client.closed</code></div>
</div>

::caption[`resume()` returns a paused client to Running. A closed client cannot be reopened; create a new one.]
:::

## Receive events

`client.events` is a broadcast `Stream<SyncularEvent>` delivered on the owning isolate's event loop, so a listener can touch widget state directly. A `Timer.periodic` on that isolate (40 ms by default; set `pollInterval` on `create`) drains the core's queue with non-blocking polls, so the isolate never parks inside the FFI. A broadcast stream drops events nobody listens to, so subscribe right after `create`. [Native client API](/native-client-api/#events) lists the event types.

```dart title="events.dart"
final sub = client.events.listen((e) {
  switch (e.type) {
    case 'sync-intent':
      client.syncUntilIdle();
    case 'change':
      setState(refreshVisibleState);
  }
});
```

`syncUntilIdle()` is a synchronous FFI call; it blocks the isolate until the rounds finish. Create the client in a background isolate for sync-heavy apps, and keep every call on that isolate.

## Realtime

With a `baseUrl` the core can hold a WebSocket to `{baseUrl}/realtime` (or `wsUrl`). `connectRealtime()` opens it and `disconnectRealtime()` closes it. While the socket is up, the core sends sync rounds over it, and presence changes arrive as `presence` events; read the peers with `presence(scopeKey)` and publish yours with `setPresence(scopeKey, doc)`. [Realtime & the WS loop](/concepts-realtime/) explains the protocol.

## Pause, resume, close

```dart title="lifecycle.dart"
client.pause();   // app backgrounded: cancel the timer, drop the socket
client.resume();  // reconnect and restart the timer
client.close();   // free the core and close the events stream
```

Call `pause()` from `AppLifecycleState.paused` or a connectivity-lost handler. `close()` cancels the timer first, so no poll is in flight when the core is freed.

## Follow the network

`FlutterConnectivitySignal` takes the current value and a change stream: `online` is a `bool` and `changes` is a `Stream<bool>` of availability. `SyncularConnectivityAdapter` calls `resume()` when online and `pause()` otherwise, applies `online` once at construction, and de-duplicates repeated values on the stream.

```dart title="connectivity.dart"
final connectivity = SyncularConnectivityAdapter(
  client,
  FlutterConnectivitySignal(online: currentOnline, changes: onlineChanges),
);

// During client teardown:
await connectivity.close();
```

:::warning{title="Pick one lifecycle owner"}
The boolean stream must report network availability, not the selected interface name. If `AppLifecycleState` also calls `pause()` and `resume()`, one owner can resume a client the other wants paused. Close the adapter while the app is paused, or feed it a combined foreground-and-online stream.
:::

Rotate a credential with `setHeaders`; the next HTTP request uses it. An open socket keeps its handshake headers, so call `pause()` then `resume()` to reconnect with the new token.
