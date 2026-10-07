# React Native: realtime & lifecycle

Pause the native core when the app backgrounds, resume it in the foreground,
keep the socket supervised, and rotate credentials. You finish with an
`AppState` handler that drives `pause()` and `resume()` and a supervisor that
recovers a dropped socket.

::meta{for="React Native developers handling app state and auth" time="7 minutes" first="platform-react-native-install" spec="8.4 8.8"}

:::terms
- **Event pump**: The native loop that polls the core for events and emits each one on the `syncular::event` topic.
- **Supervisor**: The shared policy layer for connect, reconnect, and catch-up.
- **Handshake headers**: The headers the WebSocket sends when it connects.
:::

:::figure{title="App state to client calls" note="One lifecycle owner" ticks}
<div class="d-row">
<div class="node ok"><span class="t">Foreground</span><code>client.resume()</code>: reconnect realtime, restart the pump</div>
<span class="d-arrow"></span>
<div class="node hot"><span class="t">Background</span><code>client.pause()</code>: stop the pump, disconnect realtime</div>
<span class="d-arrow"></span>
<div class="node bad"><span class="t">Teardown</span><code>client.close()</code>: release the native core</div>
</div>

::caption[While paused, the database and outbox stay intact and mutations keep queuing offline.]
:::

The client core has no callbacks. The native shims pump
`syncular_client_poll_event` on a background queue and emit each event JSON on
the `syncular::event` topic. The FFI forwards exact revisioned `change` batches
and explicit `sync-intent` effects from the Rust core, and does not diff
counters. The JS bridge feeds changes into the same reactive store as web and
Tauri, while `presence` stays ephemeral.

:::::steps
::::step{title="Drive pause and resume from AppState" time="2 min"}
```tsx title="src/lifecycle.ts"
import { AppState } from 'react-native';

const subscription = AppState.addEventListener('change', (state) => {
  if (state === 'background') void client.pause();
  else if (state === 'active') void client.resume();
});

// on teardown:
subscription.remove();
await client.close();
```

`close()` detaches listeners and releases the native core, and is idempotent.
`resume()` is one-shot: it reconnects realtime once and restarts the pump.

::checkpoint[Backgrounding the app stops events; returning to the foreground restores them and a new round runs.]
::::

::::step{title="Supervise the socket" time="3 min"}
For retry, socket-close recovery, and an explicit catch-up before the app claims
freshness, install `installRealtimeSupervisor()` from `@syncular/client` with an
`AppState`-backed lifecycle signal plus your connectivity and protection signals.
Keep calling `pause()` and `resume()` to control the native event pump. Repeated
connection attempts are idempotent, so the supervisor adds policy without
creating a second native socket.

Create the client with `realtimePolicy: 'required'` when the socket is the
designated sync path. A round while the socket is down then fails with
`sync.realtime_unavailable` instead of using `POST /sync`. See
[Realtime](/concepts-realtime/#required-realtime) for the states and
diagnostics.

::checkpoint[`realtimeSupervisorSnapshot(client).phase` reads `connected` in the foreground.]
::::

::::step{title="Rotate credentials" time="1 min"}
```ts title="src/auth.ts"
await client.setHeaders({ Authorization: `Bearer ${freshToken}` });
```

The next HTTP request uses the new headers. An open WebSocket keeps the headers
from its handshake; call `pause()` and `resume()` when the new credential must
apply to the live socket immediately.

::checkpoint[The next sync request carries the new `Authorization` header.]
::::
:::::

## Schema bumps

A schema bump on an installed app follows the wipe-and-re-bootstrap flow in
[Schema upgrades](/concepts-schema-upgrades/).

## Sync progress

`client.onProgress(listener)` and `progressSnapshot()` match the browser handle.
See [Browser: realtime & lifecycle](/platform-web-realtime/#sync-progress).
