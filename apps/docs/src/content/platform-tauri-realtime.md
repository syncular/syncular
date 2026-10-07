# Tauri: realtime & lifecycle

Keep the native socket connected, rotate credentials, switch replicas on
sign-in, and close the client cleanly. You finish with a supervisor installed on
the client, header rotation that reaches the live socket, and one replica per
signed-in actor.

::meta{for="Developers running the Tauri client across sessions" time="8 minutes" first="platform-tauri-install" spec="1.5 8.4"}

:::terms
- **Supervisor**: The shared policy layer for connect, reconnect, and catch-up.
- **Replica**: One native SQLite database, with its own client id and outbox.
- **Handshake headers**: The headers the WebSocket sends when it connects.
:::

:::figure{title="Header rotation" note="HTTP at once, socket on reconnect" ticks}
<div class="d-row">
<div class="node hot"><span class="t">setHeaders(full set)</span>Replaces the previous set</div>
<span class="d-arrow"></span>
<div class="d-stack">
<div class="node ok"><span class="t">HTTP</span>Sync rounds, segments, blobs use it from the next call</div>
<div class="node"><span class="t">Live WebSocket</span>Keeps handshake headers until it reconnects</div>
</div>
</div>

::caption[To put new credentials on the live socket immediately, call `disconnectRealtime()` then `connectRealtime()` after `setHeaders`.]
:::

:::::steps
::::step{title="Install the supervisor" time="2 min"}
Install the shared realtime supervisor on the returned client so a transient
startup failure or a socket close cannot strand remote-only changes:

```ts title="src/sync.ts"
import {
  browserConnectivitySignal,
  documentLifecycleSignal,
  installRealtimeSupervisor,
} from '@syncular/client';

installRealtimeSupervisor(client, {
  connectivity: browserConnectivitySignal(),
  lifecycle: documentLifecycleSignal(),
  protection,
});
```

This baseline follows webview connectivity and visibility. A desktop app with
native sleep and wake evidence exposes it through the same structural lifecycle
signal. The supervisor owns bounded reconnect and catch-up; the native core
guarantees that repeated connect commands still own only one socket.

Create the client with `realtimePolicy: 'required'` when the socket is the
designated sync path: a round while it is down then fails with
`sync.realtime_unavailable` instead of using `POST /sync`. See
[Realtime](/concepts-realtime/#required-realtime) for the phases and
diagnostics.

::checkpoint[`realtimeSupervisorSnapshot(client).phase` reads `connected` once the native socket opens.]
::::

::::step{title="Rotate credentials" time="2 min"}
`SyncularConfig.headers` sets the initial header set at registration. The bridge
replaces it at runtime:

```ts title="src/auth.ts"
await client.setHeaders({ authorization: `Bearer ${freshToken}` });
```

Pass the full header set each time; it replaces the previous set. HTTP requests
use the new headers from the next call. The WebSocket sends headers at handshake
time, so a live socket keeps its old set until it reconnects. To apply the new
credential now, call `disconnectRealtime()` then `connectRealtime()`.

To install the current bearer atomically with security activation, use
`activateSecurity({ encryption, headers })`. Runtime `setHeaders()` requires an
active client.

::checkpoint[The next HTTP request carries the new `authorization` header.]
::::

::::step{title="Open one replica per actor" time="3 min"}
The server binds a client id to the first actor that syncs with it
([SPEC §1.5](https://github.com/syncular/syncular/blob/main/docs/SPEC.md)), and
the client id lives in the replica. An app that signs one person out and another
in opens a separate database per actor. Set `database_dir` in the plugin config
and pass `database` to `createTauriSyncClient`:

```ts title="src/session.ts"
await client.close(); // the previous actor's replica keeps its outbox
const next = await createTauriSyncClient({ schema, database: `app-actor-${actorDigest}` });
```

A database name is 1 to 128 ASCII letters, digits, `-`, `_`, or `.`. It starts
with a letter or digit and contains no `..`, so it cannot leave `database_dir`.
The plugin refuses an invalid name, a name without a configured `database_dir`,
and a webview-supplied `dbPath`, all with `sync.invalid_request`. The snapshot
reader follows the database the last successful `create` opened.

::checkpoint[After sign-in as a second actor, the previous actor's rows are absent and its outbox is intact in its own database file.]
::::
:::::

## Closing the client

`close()` shuts down the native client and is idempotent. After
`await client.close()`, data and control methods reject with `client.closed`
before they check security preflight; local listener registration and progress
reads throw the same code. Dispose host session listeners together with their
client so a later sign-in cannot rotate a closed replica's headers.

## Pausing the network

`setTransportEnabled(false)` closes all network work while local reads and
writes continue, and `setOffline(true)` is its alias. The contract is in
[Platform specifics](/platform-tauri-specifics/#local-activation-with-transport-closed).

## Sync progress

`client.onProgress(listener)` and `progressSnapshot()` match the browser
handle. See [Browser: realtime & lifecycle](/platform-web-realtime/#sync-progress).
