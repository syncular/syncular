# Tauri: realtime & lifecycle

Keep the native socket connected, renew credentials through the header source, switch replicas on
sign-in, and close the client cleanly. You finish with a supervisor installed on
the client, a header source that renews the bearer, and one replica per
signed-in actor.

::meta{for="Developers running the Tauri client across sessions" time="8 minutes" first="platform-tauri-install" spec="1.5 8.4"}

:::terms
- **Supervisor**: The shared policy layer for connect, reconnect, and catch-up.
- **Replica**: One native SQLite database, with its own client id and outbox.
- **Handshake headers**: The headers the WebSocket sends when it connects.
:::

:::figure{title="Header source" note="Asked per request, socket on reconnect" ticks}
<div class="d-row">
<div class="node hot"><span class="t">header_source(rejected)</span>Answers the full set for one request</div>
<span class="d-arrow"></span>
<div class="d-stack">
<div class="node ok"><span class="t">HTTP</span>Sync rounds, segments, blobs ask before every request</div>
<div class="node"><span class="t">Live WebSocket</span>Keeps handshake headers until it reconnects</div>
</div>
</div>

::caption[A live socket keeps its handshake headers. A reconnect asks the source; call `disconnectRealtime()` then `connectRealtime()` to reconnect now.]
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

::::step{title="Renew credentials" time="2 min"}
The host app's Rust code passes a `header_source` in `SyncularConfig`. The
webview has no call that pushes headers:

```rust title="src-tauri/src/lib.rs"
header_source: Some(HeaderSource::new(|rejected| {
    Some(vec![("authorization".into(), format!("Bearer {}", token(rejected)))])
})),
```

The native transport calls the source in the host process before every HTTP
request and every WebSocket handshake, so a hidden or throttled webview never
delays a renewal. After a 401 it calls the source once more with the refused
headers and resends once; a second 401 surfaces the retryable
`sync.auth_required`. A source that returns `None` fails the request with
`sync.auth_required` and `causeKind` `header_source`. A live socket keeps its
handshake headers until it reconnects. To reconnect now, call
`disconnectRealtime()` then `connectRealtime()`.

`activateSecurity({ encryption })` takes no headers.

::checkpoint[The next HTTP request carries the header the Rust source answered.]
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

`close()` shuts down the native client. Every call returns the same promise:
a concurrent or repeated `close()` settles when the one native shutdown settles
and rejects with its error. After `await client.close()`, data and control methods reject with `client.closed`
before they check security preflight; local listener registration and progress
reads throw the same code. Dispose host session listeners together with their
client so a later sign-in cannot reach a closed replica.

## Pausing the network

`setTransportGate('closed')` closes all network work while local reads and
writes continue; `setTransportGate('pull')` keeps pulls and realtime and sends
no commit. The contract is in
[Platform specifics](/platform-tauri-specifics/#local-activation-with-transport-closed).

## The app in the background

The supervisor reports its lifecycle signal to the plugin with
`setHostLifecycle`. While the signal reads `background`, the plugin's host
loop starts no round of its own, and the round in flight ends as
`client.round_cancelled` instead of failing as `transport.failed` when the
app returns. iOS suspends the app's network within seconds of a move to the
background, so a request started then fails on return as a dead connection.
On `active` the plugin runs the work it held, and the supervisor reconnects
and drives a round. Rounds the app starts with `sync()` or `syncUntilIdle()`
run in the background too. A supervisor installed with `sharedTransport`
reports nothing, because a sibling view may still be in the foreground.

An app without the supervisor calls `client.setHostLifecycle('background')`
and `client.setHostLifecycle('active')` from its own lifecycle evidence.

## Sync progress

`client.onProgress(listener)` and `progressSnapshot()` match the browser
handle. See [Browser: realtime & lifecycle](/platform-web-realtime/#sync-progress).
