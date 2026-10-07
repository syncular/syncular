# Native client API

The Swift, Kotlin, and Flutter packages are thin wrappers over one Rust core. This page lists what the three share: the binding model, the configuration fields, the event stream, the connectivity adapter, and the snapshot and outcome methods. Each SDK's own pages cover install steps and language-specific code.

::meta{for="App developers on Swift, Kotlin, or Flutter" time="8 minutes"}

:::terms
- **Handle**: The opaque pointer to one running core. A wrapper owns exactly one.
- **Lean core**: A `libsyncular` build without `native-transport`. It runs client-local commands and answers network commands with `transport.unavailable`.
- **Poll loop**: The wrapper's loop that drains `poll_event` and hands each event to your code.
- **Connectivity adapter**: The wrapper class that maps online and offline signals to `resume()` and `pause()`.
- **Outcome**: The durable record of how one commit ended: `applied`, `cached`, `conflict`, or `rejected`.
:::

## Binding model

:::figure{title="From your code to the database" note="Same on every native SDK" ticks}
<div class="d-row">
<div class="node hot"><span class="t">Your app</span>Swift, Kotlin, or Dart<br>typed calls</div>
<span class="d-arrow"></span>
<div class="node"><span class="t">Wrapper</span><code>SyncularClient</code><br>serializes commands<br>runs the poll loop</div>
<span class="d-arrow"></span>
<div class="node cool"><span class="t">libsyncular</span>5 C functions<br>JSON in, JSON out</div>
<span class="d-arrow"></span>
<div class="node ok"><span class="t">Rust core</span>SQLite replica<br>outbox, native transport</div>
</div>

::caption[Every behavior lives in the Rust core. The wrapper marshals JSON and owns the lifecycle. [Embedding via C FFI](/platform-ffi/) documents the C side.]
:::

Each wrapper encodes a call as `{"method", "params"}`, passes it to `syncular_client_command`, and decodes `{"result"}` or `{"error": {"code", "message"}}`. A typed method such as `mutate` or `readRows` wraps one command. The raw `command(method, params)` method reaches everything else, including `setWindow`, `windowState`, `patch`, and `purgeLocalData`.

All three wrappers share these properties:

- **One owner thread for the core.** The wrapper serializes every command (Swift: a serial dispatch queue; Kotlin: a lock; Flutter: the creating isolate). Call a `SyncularClient` from any Swift or Kotlin thread; call a Flutter client from the isolate that created it.
- **Failed commands throw.** Swift throws `SyncularError`, Kotlin throws `SyncularException`, Dart throws `SyncularError`. Each carries a stable `code` and a message, for example `client.closed` after `close()`.
- **The generated schema is the constructor input.** `syncular generate` emits a `swift`, `kotlin`, or `dart` output with a ready-made schema value, typed rows, and subscription helpers. See [Schema & typegen](/guide-schema/).

## Configuration

`SyncularConfig` splits across two calls. The transport fields go to `syncular_client_new`; `dbPath`, `clientId`, `schema`, and `limits` go to the `create` command that the constructor issues right after.

| Field | Effect |
|---|---|
| `baseUrl` | The server mount, such as `http://localhost:8787`. Engages the native HTTP and WebSocket transport, which appends `/sync`, `/segments/{id}`, `/blobs/{id}`, and `/realtime`. Without it the client runs the lean core. A `baseUrl` on a core built without `native-transport` fails construction with `client.failed`. |
| `wsUrl` | Realtime socket URL. Derived from `baseUrl` when absent. |
| `headers` | Request headers for the native transport, such as `Authorization`. |
| `dbPath` | SQLite file. Without it the replica lives in memory and loses rows, cursors, client identity, and the outbox on restart. |
| `clientId` | Stable client id. Absent, the core creates one and persists it in the database. |
| `limits` | Client limits forwarded to `create`. |
| `requestTimeoutMs`, `roundDeadlineMs`, `maxRequestBytes`, `maxResponseBytes`, `redirects` | The native transport policy. [Rust: Platform specifics](/platform-rust-specifics/#native-transport-policy) lists the semantics and error codes. |

`setHeaders` replaces the full header set. The next HTTP request uses the new headers. An open WebSocket keeps the headers from its handshake; call `pause()` then `resume()` to repeat the handshake.

## Events

The core has no callbacks. It queues five event types, and the wrapper's poll loop drains them with a 25 ms bounded wait (Swift, Kotlin) or a 40 ms periodic timer that polls without blocking (Flutter, configurable with `pollInterval`).

| `type` | Carries | Use |
|---|---|---|
| `change` | An exact, revisioned change batch | Refresh the screens that read the changed tables. |
| `sync-intent` | The coalesced reason a sync round is due | Call `sync()` or `syncUntilIdle()`. |
| `presence` | No payload | Call `presence(scopeKey)` again. |
| `diagnostics` | A privacy-safe snapshot, emitted only when its state changes | Feed a support screen. |
| `progress` | Phase, bytes, and rows of the running round | Draw a progress bar. The queue keeps only the newest one. |

:::figure{title="Where an event runs" note="Per SDK"}
<div class="d-row">
<div class="node"><span class="t">Core queue</span>change, sync-intent,<br>presence, diagnostics, progress</div>
<span class="d-arrow"></span>
<div class="node cool"><span class="t">Poll loop</span>background thread,<br>queue, or timer</div>
<span class="d-arrow"></span>
<div class="d-stack">
<div class="node hot"><span class="t">Swift</span><code>deliveryQueue</code>, main by default</div>
<div class="node hot"><span class="t">Kotlin</span>the poll thread itself</div>
<div class="node hot"><span class="t">Flutter</span><code>client.events</code> stream on the owning isolate</div>
</div>
</div>
:::

## Lifecycle and connectivity

`pause()` stops the poll loop and disconnects the realtime socket. The database and the outbox stay intact, and `mutate` keeps queuing. `resume()` reconnects realtime when a transport exists and restarts the poll loop. `close()` releases the core; it is idempotent, waits for an in-flight `poll_event` before freeing the handle, and makes later commands throw `client.closed`. HTTP has no persistent connection, so `pause()` does not tear it down.

A connectivity adapter calls `resume()` when its signal reports online and `pause()` when it reports offline, and applies the signal's current value once at construction.

:::figure{title="Connectivity drives pause and resume" note="Adapter in the middle"}
<div class="d-row">
<div class="node"><span class="t">Platform signal</span><code>NWPathMonitor</code>, <code>NetworkCallback</code>,<br>connectivity stream</div>
<span class="d-arrow"></span>
<div class="node cool"><span class="t">Adapter</span>online → <code>resume()</code><br>offline → <code>pause()</code></div>
<span class="d-arrow"></span>
<div class="node ok"><span class="t">Client</span>poll loop and socket<br>start or stop</div>
</div>
:::

:::rule{title="One lifecycle owner"}
The signal reports network availability only. If app foreground state also controls the client, feed the adapter one combined foreground-and-online signal, or stop the adapter while the app is backgrounded. Two independent owners can resume the client while the other still requires a pause.
:::

## Sync results

`sync()` runs one round and `syncUntilIdle(maxRounds)` repeats rounds until nothing is pending. Both return the outcome as a JSON value and never throw for transport failure. Offline, or on the lean core, the result is `{ok: false, errorCode: "transport.unavailable"}`. The commit stays in the outbox and `pendingCommitIds()` stays non-empty until a later round drains it. `maxRounds` is optional and must be positive when given; the core default is 20 rounds.

## Snapshot and outcome methods

| Method | Returns |
|---|---|
| `querySnapshot(sql, params, coverage)` | Rows, window coverage, and the local revision from one read transaction. |
| `statusSnapshot()` | `currentSchemaVersion`, `outbox` count, `upgrading`, `leaseState`, `schemaFloor`, `syncNeeded`, and `previousVersionContext`. |
| `diagnosticsSnapshot(request)` | Bounded support evidence: subscriptions, last round, last change, query failures. |
| `commitOutcome(clientCommitId)` | The terminal outcome of one commit, or null while the commit is pending. |
| `commitOutcomes(query)` | The durable outcome journal. |
| `resolveCommitOutcome(input)` | Records `resolved_keep_server`, `superseded`, or `dismissed` for a commit and returns the outcome. |
| `rejections()` | Rejected commits. |
| `conflicts()` | Active conflict records. |

An outcome's `status` is `applied`, `cached`, `conflict`, or `rejected`; its `resolution` starts at `active`. Outcomes survive restarts, so correction UI can rebuild itself after a relaunch. [Handling conflicts](/guide-concurrency-correction/) covers the correction flow, and [Conflicts & optimistic writes](/concepts-conflicts/) the model. The raw `schemaFloor`, `leaseState`, `upgrading`, and `syncNeeded` commands no longer exist; read those fields from `statusSnapshot()`.

A schema bump on an installed app follows the wipe-and-re-bootstrap flow in [Schema upgrades](/concepts-schema-upgrades/).

## Collaborative text

The CRDT helpers `crdtText`, `crdtInsertText`, `crdtDeleteText`, and `crdtApplyUpdate` need a core built with `crdt-yjs`. Each helper pushes its update through the normal mutate path and returns the enqueued `clientCommitId`. The merge model is on [CRDT columns](/concepts-crdt/).

## SDK pages

- [Swift](/platform-swift/): `SyncularClient` over SwiftPM.
- [Kotlin](/platform-kotlin/): `dev.syncular` over FFM on JDK 21 or newer.
- [Flutter](/platform-flutter/): the `syncular` pub package over `dart:ffi`.
