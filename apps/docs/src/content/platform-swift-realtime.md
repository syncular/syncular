# Realtime & lifecycle (Swift)

Receive change events, connect realtime, and tie the client's lifetime to the app's scene phase and the device's network.

::meta{for="Swift developers wiring sync into app lifecycle" time="7 minutes"}

:::figure{title="The client's three states" note="Database and outbox survive all of them" ticks}
<div class="d-row">
<div class="node ok"><span class="t">Running</span>poll queue drains events,<br>realtime socket open</div>
<span class="d-arrow"></span>
<div class="node cool"><span class="t">Paused</span><code>pause()</code>: poll loop stopped,<br>socket closed, <code>mutate</code> still queues</div>
<span class="d-arrow"></span>
<div class="node bad"><span class="t">Closed</span><code>close()</code>: core released,<br>commands throw <code>client.closed</code></div>
</div>

::caption[`resume()` returns a paused client to Running. A closed client cannot be reopened; create a new one.]
:::

## Receive events

Set `onEvent` or a `SyncularClientDelegate`. The wrapper drains the core's `poll_event` queue on a background queue with a 25 ms wait and delivers each event on `deliveryQueue`, which defaults to `.main`. Events delivered before a handler is set are dropped, so set `onEvent` right after construction. [Native client API](/native-client-api/#events) lists the event types.

```swift title="Events.swift"
client.onEvent = { event in
    switch event.type {
    case "sync-intent": Task { try? client.syncUntilIdle() }
    case "change":      refreshVisibleState()
    default:            break
    }
}
```

`syncUntilIdle()` blocks its caller until the rounds finish, so call it from a background task. To deliver events on another queue, pass `deliveryQueue:` to the initializer.

## Realtime

With a `baseUrl` the core can hold a WebSocket to `{baseUrl}/realtime` (or `wsUrl`). `connectRealtime()` opens it and `disconnectRealtime()` closes it. While the socket is up, the core sends sync rounds over it, and presence changes arrive as `presence` events; read the peers with `presence(scopeKey:)` and publish yours with `setPresence(scopeKey:doc:)`. [Realtime & the WS loop](/concepts-realtime/) explains the protocol.

## Pause, resume, close

```swift title="SceneView.swift"
.onChange(of: scenePhase) { _, phase in
    switch phase {
    case .background: client.pause()
    case .active:     client.resume()
    default:          break
    }
}
```

`close()` waits for the poll loop to leave its in-flight `poll_event` call before the core is freed, so it can block for up to 25 ms. The client also closes in `deinit`.

## Follow the network

`IOSPathConnectivitySignal` wraps `NWPathMonitor`. `SyncularConnectivityAdapter` calls `resume()` when the path is satisfied and `pause()` otherwise, and applies the current path state once at construction.

```swift title="Connectivity.swift"
let pathSignal = IOSPathConnectivitySignal()
let connectivity = SyncularConnectivityAdapter(client: client, signal: pathSignal)

// During client teardown:
connectivity.stop()
pathSignal.stop()
```

:::warning{title="Pick one lifecycle owner"}
The path signal reports network availability only. If `scenePhase` also calls `pause()` and `resume()`, one owner can resume a client the other wants paused. Stop the adapter while the app is backgrounded, or implement `SyncularConnectivitySignal` over a combined foreground-and-online value.
:::

Rotate a credential with `setHeaders`; the next HTTP request uses it. An open socket keeps its handshake headers, so call `pause()` then `resume()` to reconnect with the new token.
