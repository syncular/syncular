# Realtime & lifecycle (Kotlin)

Receive change events, connect realtime, and tie the client's lifetime to the Android activity and the device's network.

::meta{for="Kotlin developers wiring sync into app lifecycle" time="7 minutes"}

:::figure{title="The client's three states" note="Database and outbox survive all of them" ticks}
<div class="d-row">
<div class="node ok"><span class="t">Running</span>poll thread drains events,<br>realtime socket open</div>
<span class="d-arrow"></span>
<div class="node cool"><span class="t">Paused</span><code>pause()</code>: poll thread joined,<br>socket closed, <code>mutate</code> still queues</div>
<span class="d-arrow"></span>
<div class="node bad"><span class="t">Closed</span><code>close()</code>: core released,<br>commands throw <code>client.closed</code></div>
</div>

::caption[`resume()` returns a paused client to Running. A closed client cannot be reopened; create a new one.]
:::

## Receive events

Set `client.listener`. The wrapper drains the core's `poll_event` queue on a daemon thread named `syncular-poll` with a 25 ms wait and calls the listener on that thread. Marshal to the UI thread before touching views. [Native client API](/native-client-api/#events) lists the event types.

```kotlin title="Events.kt"
client.listener = SyncularEventListener { event ->
    when (event.type) {
        "sync-intent" -> scope.launch(Dispatchers.IO) { client.syncUntilIdle() }
        "change"      -> runOnUiThread { refreshVisibleState() }
    }
}
```

`syncUntilIdle()` blocks its caller until the rounds finish, so call it off the listener and off the main thread. A command issued from inside the listener waits on the same lock as every other caller.

## Realtime

With a `baseUrl` the core can hold a WebSocket to `{baseUrl}/realtime` (or `wsUrl`). `connectRealtime()` opens it and `disconnectRealtime()` closes it. While the socket is up, the core sends sync rounds over it, and presence changes arrive as `presence` events; read the peers with `presence(scopeKey)` and publish yours with `setPresence(scopeKey, doc)`. [Realtime & the WS loop](/concepts-realtime/) explains the protocol.

## Pause, resume, close

```kotlin title="MainActivity.kt"
override fun onStop() { super.onStop(); client.pause() }
override fun onStart() { super.onStart(); client.resume() }
```

`SyncularClient` is `AutoCloseable`; `client.use { ... }` scopes its lifetime. `close()` joins the poll thread before freeing the core, so the handle is never freed under an in-flight `poll_event`.

## Follow the network

`AndroidConnectivitySignal` takes two lambdas: `current` reads the validated-network state and `observe` registers a callback and returns a `SyncularConnectivitySubscription` that unregisters it. `SyncularConnectivityAdapter` calls `resume()` when online and `pause()` otherwise, and applies the current state once at construction.

```kotlin title="Connectivity.kt"
fun online(): Boolean = connectivityManager
    .getNetworkCapabilities(connectivityManager.activeNetwork)
    ?.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED) == true

val signal = AndroidConnectivitySignal(
    current = ::online,
    observe = { listener ->
        val callback = object : ConnectivityManager.NetworkCallback() {
            override fun onCapabilitiesChanged(
                network: Network,
                capabilities: NetworkCapabilities,
            ) = listener(
                capabilities.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED),
            )
            override fun onLost(network: Network) = listener(false)
        }
        connectivityManager.registerDefaultNetworkCallback(callback)
        SyncularConnectivitySubscription {
            connectivityManager.unregisterNetworkCallback(callback)
        }
    },
)
val connectivity = SyncularConnectivityAdapter(client, signal)

// During client teardown:
connectivity.close()
```

:::warning{title="Pick one lifecycle owner"}
The signal reports network availability only. If `onStop()` also calls `pause()` and `resume()`, one owner can resume a client the other wants paused. Close the adapter in `onStop()`, or supply a signal that combines foreground and online state.
:::

Rotate a credential with `setHeaders`; the next HTTP request uses it. An open socket keeps its handshake headers, so call `pause()` then `resume()` to reconnect with the new token.
