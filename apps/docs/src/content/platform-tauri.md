# Tauri

A Tauri app runs a native syncular instance inside the host process:
`tauri-plugin-syncular` (Rust) consumes the client core directly as a crate,
with no FFI layer, and the webview talks to it through a thin JS bridge,
`@syncular/tauri`, that implements the same `SyncClientLike` interface every
other host does. The bridge works with Vue, React, Svelte, or plain TypeScript.
React apps can add the optional `@syncular/react` hooks.

## Why the client lives in the host process

Webview OPFS is eviction-prone and inconsistent across WKWebView and
webkitgtk. The Rust core gives a real on-disk SQLite database (rusqlite) and
native performance, so the full client runs in the Tauri host process and the
webview is a thin RPC client of it. The shape matches the browser worker
mode: the client core runs outside the UI thread, reached over RPC (here,
Tauri IPC).

## Local commands during sync

The native owner captures one request and gives its network I/O to a separate
executor. Local mutations and queries continue while the server reply or segment
bytes are pending. The owner applies the reply with the captured commit IDs and
normal version checks; writes authored during the round replay over that base
and enter the next request. Socket acknowledgements use the same I/O executor.
There is no extra polling loop.

An acknowledgement rebuilds only the tables touched by that commit or pull.
Unchanged tables and their FTS projections stay untouched, so a catalogue's size
does not add a full-table copy to an unrelated edit. A schema reset or restart
can still rebuild the complete projection.

## Install

Install the JS bridge and its required Tauri API peer in your frontend project:

```sh
bun add @syncular/tauri @tauri-apps/api
```

The Rust plugin is on crates.io:

```toml
[dependencies]
tauri-plugin-syncular = { version = "0.0.0", features = ["native-transport"] }
```

To track unreleased changes, consume it as a git dependency instead; cargo
finds the package inside the repo by name (pin a `rev = "<commit>"` for
reproducible builds); with a local checkout, a path dependency to
[`bindings/tauri/plugin`](https://github.com/syncular/syncular/tree/main/bindings/tauri/plugin)
works too:

```toml
[dependencies]
tauri-plugin-syncular = { git = "https://github.com/syncular/syncular", features = ["native-transport"] }
```

The `native-transport` feature compiles the plugin's HTTP + WebSocket stack
(`ureq` + `tungstenite`, both blocking, with no async runtime). Without it the
plugin builds a client-local core: network commands return errors while local
reads and writes keep working.

## Register the plugin

Initialize with a `SyncularConfig` in your app's setup:

```rust
use tauri::Manager;
use tauri_plugin_syncular::SyncularConfig;

tauri::Builder::default()
    .setup(|app| {
        // Persist the database under the OS app-data dir so it survives
        // restarts.
        let db_path = app.path().app_data_dir().ok().map(|dir| {
            let _ = std::fs::create_dir_all(&dir);
            dir.join("syncular.db").to_string_lossy().into_owned()
        });
        let config = SyncularConfig {
            base_url: Some("https://your.server".into()),
            db_path,
            auto_sync: true,
            ..Default::default()
        };
        app.handle().plugin(tauri_plugin_syncular::init(config))?;
        Ok(())
    })
    .run(tauri::generate_context!())
    .expect("error while running the app");
```

The config fields:

| Field | Meaning |
| --- | --- |
| `base_url` | Server base URL for the native HTTP+WS transport. Absent → client-local only. |
| `ws_url` | Optional realtime WebSocket URL; derived from `base_url` when absent. |
| `headers` | Extra request headers (auth, actor/project ids) as name/value pairs. |
| `db_path` | On-disk SQLite path a `create` opens when it names no database. Absent → in-memory, nothing survives a restart. |
| `database_dir` | Directory of named databases. A `create` with `database: 'name'` opens `<database_dir>/name.db`; the plugin creates the directory. Without `db_path`, every `create` must name a database. |
| `auto_sync` | Run the background host loop. Default `true`. |

### One replica per actor

The server binds a client id to the first actor that syncs with it (SPEC §1.5),
and the client id lives in the replica. An app that signs one person out and
another in opens a separate database per actor. Set `database_dir` and pass
`database` to `createTauriSyncClient`:

```ts
await client.close(); // the previous actor's replica keeps its outbox
const next = await createTauriSyncClient({ schema, database: `app-actor-${actorDigest}` });
```

A database name is 1 to 128 ASCII letters, digits, `-`, `_` or `.`, starts
with a letter or digit, and contains no `..`, so it cannot leave
`database_dir`. The plugin refuses an invalid name, a name without a configured
`database_dir`, and a webview-supplied `dbPath` with `sync.invalid_request`.
The snapshot reader follows the database the last successful `create` opened.

Grant the plugin's permission in a capability file
(`src-tauri/capabilities/*.json`):

```json
{ "identifier": "syncular", "windows": ["main"], "permissions": ["syncular:default"] }
```

## Create the client in the webview

Generate `src/syncular.generated.ts` before importing it. For an existing app,
follow [Add Syncular to an existing project](/guide-schema/#add-syncular-to-an-existing-project)
to install `@syncular/typegen`, create the migration and manifest, and run
generation. The Tauri scaffold includes those inputs. Its generated `schema`
describes the synced tables and must match the schema used by your sync server.

```ts
// src/sync.ts
import { createTauriSyncClient } from '@syncular/tauri';
import { schema } from './syncular.generated';

export const client = await createTauriSyncClient({ schema });
```

Create one client for the webview and share it across your components. Its
`subscribe`, `query`, and `mutate` methods return promises and can be called
from any frontend framework. `query` returns a local snapshot; subscribe to
`onChange` events to observe later changes. The callback receives a revisioned
change batch, and `onChange` returns an unsubscribe function. Remove listeners
when their component is disposed; call `client.close()` when the app releases
the shared client.

The JS side supplies the schema and optional `limits`; the native side owns
the database path (plugin config). On first open the core generates and stores
a cryptographically random client id in that database. Later opens restore it.
An explicit `clientId` can initialize a new database, but a different id for
an existing database fails with `client.identity_mismatch` instead of silently
rebinding identity. The bridge resolves
`@tauri-apps/api` automatically (or the ambient `window.__TAURI__` when
`withGlobalTauri` is enabled); tests inject `invoke`/`listen` doubles.

For encrypted schemas, build the plugin with its `e2ee` feature and pass the
portable keyring accepted by the browser worker too:

```ts
const client = await createTauriSyncClient({
  schema,
  encryption: {
    keys: { 'key-2026-07': activeKey, 'key-2026-06': previousKey },
    keyIdColumns: { patient_notes: 'encryption_key_id' },
  },
});
```

Raw keys cross only into the native command core and are never sent to the
server. See [Encryption keys](/concepts-encryption-keys/).

The bridge exposes the native durable outcome journal through `commitOutcome`,
`commitOutcomes`, and `resolveCommitOutcome`; React observes it with
`useCommitOutcomes()`.

`purgeLocalData({ purgeId, targets })` and the `securityPreflight` /
`activateSecurity` / `beginSecurityPreflight` lifecycle cross the same
command bridge to the native core, with the semantics defined in
[Authorized local purge](/concepts-local-data-purge/). `close()` shuts down
the native client.

Install the shared realtime supervisor on the returned client so a transient
startup failure or socket close cannot strand remote-only changes:

```ts
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

This baseline follows WebView connectivity/visibility. A desktop app with
native sleep/wake evidence should expose it through the same structural
lifecycle signal. The supervisor owns bounded reconnect and catch-up; the
native core guarantees repeated connect commands still own only one socket.
Create the client with `realtimePolicy: 'required'` when the socket is the
designated sync path: a round while it is down then fails with
`sync.realtime_unavailable` instead of using `POST /sync`.
See [Realtime](/concepts-realtime/#required-realtime) for phases and
diagnostics.

## Test clock

`create` accepts an optional `nowMs` that pins the client clock. The plugin
reads and applies it through the shared command router, so the core's
`capturedAtMs`, lease expiry, and previous-version TTL stay deterministic in a
test.

To set the pinned clock mid-test, build the plugin with its `test-clock`
feature and call `SyncularCore::set_now_ms`:

```rust
use tauri_plugin_syncular::core::SyncularCore;

let mut core = SyncularCore::new(&serde_json::json!({}))?;
core.command(&serde_json::json!({
    "method": "create",
    "params": { "clientId": "test", "schema": schema, "nowMs": 1_000 },
}));
core.set_now_ms(2_000)?; // set the client clock from the host test clock
```

The setter accepts an earlier or later timestamp in milliseconds since the Unix
epoch. It returns `client.not_created` before a `create`. The feature is off
by default. Set the host's test clock separately.

## React bindings (optional)

In a React app, install the hooks and pass the shared client to `SyncProvider`:

```sh
bun add @syncular/react
```

```tsx
import { SyncProvider } from '@syncular/react';
import { client } from './sync';

<SyncProvider client={client}>
  <App />
</SyncProvider>
```

The provider adapts the Tauri client for live queries, mutations, status, and
presence. See [React](/platform-react/) for the hooks and startup handling.

## One codebase, web and desktop

The same React tree runs over two hosts: in the browser, the client core
lives in a Web Worker on OPFS; on desktop, this plugin's native Rust core.
Everything in `@syncular/react` targets one structural interface,
`SyncClientLike`, so the only host-aware code is an engine seam that picks
the client:

```ts
// engine.ts: the one file that knows about hosts.
import type { SyncClientLike } from '@syncular/react';
import { schema } from './syncular.generated';

/** Tauri v2 injects this into every webview it hosts. */
const isTauri = () =>
  '__TAURI_INTERNALS__' in window ||
  import.meta.env.VITE_FORCE_ENGINE === 'tauri';

export async function createEngine(): Promise<SyncClientLike> {
  if (isTauri()) {
    // Desktop: the native Rust core in the Tauri process. The plugin owns
    // the database path and the transport; the webview is a thin RPC proxy.
    const { createTauriSyncClient } = await import('@syncular/tauri');
    return createTauriSyncClient({ schema });
  }
  // Web: the whole core in a worker, persisted on OPFS. The first tab
  // leads; further tabs follow it over a BroadcastChannel.
  const { createSyncClientHandle } = await import('@syncular/client');
  const WS = location.protocol === 'https:' ? 'wss' : 'ws';
  return createSyncClientHandle({
    worker: () =>
      new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' }),
    schema,
    database: { mode: 'persistent', name: 'app' },
    endpoints: {
      syncUrl: '/sync',
      segmentsUrl: '/segments',
      realtimeUrl: `${WS}://${location.host}/realtime?clientId={clientId}`,
    },
  });
}
```

Render one `<SyncProvider client={await createEngine()}>` around the shared
tree. The dynamic imports keep each host's machinery out of the other's
bundle: the web build never ships the Tauri bridge, and the Tauri webview
never loads sqlite-wasm. The `VITE_FORCE_ENGINE` override is for developing
the Tauri UI in a plain browser tab.

What differs per host:

| | Web (worker) | Desktop (Tauri) |
| --- | --- | --- |
| Core | TypeScript client in a Web Worker | Rust client in the host process |
| Storage | OPFS (`opfs-sahpool`) | On-disk SQLite under app-data |
| Transport | `fetch` + WebSocket from the worker | `ureq` + `tungstenite` in Rust |
| Query round trip | postMessage RPC | Tauri IPC to an independent read-only SQLite owner |
| Setup | [Vite config](/guide-vite/) | plugin registration above |

Auth rotation on desktop goes through `client.setHeaders(...)` (below); on
the web the worker's transport sends whatever your reverse proxy or session
carries. `bun create syncular-app my-app --template tauri` scaffolds the
engine seam, the shared React tree, the sync server, and a `src-tauri/` host
as a runnable project: run the web half with `bun run dev` and the desktop
half with `cargo tauri dev`.

## The command and event surface

The plugin dispatches through the shared `syncular-command` router, the same
router the conformance shim and the C-ABI FFI use, so the surface is
conformance-locked.

- **`syncular_command(command)`**: the whole surface in one command.
  `command` is `{ "method": "...", "params": {...} }` (create, subscribe,
  mutate, sync, syncUntilIdle, conflicts, presence, setPresence, …). The reply
  is `{ "result": ... }` or `{ "error": { "code", "message" } }`.
- **`syncular_query(sql, params)`**: the raw read-only SQL fast path.
- **`syncular_query_snapshot(sql, params, coverage)`**: one IPC read for rows,
  window completeness, and exact local revision. A file-backed plugin serves
  this from an independent read-only SQLite connection, so network work on the
  mutable owner cannot stall reactive views.
- **`syncular_set_headers(headers)`**: replace the native transport's
  request headers at runtime (see below).
- **`syncular://event`**: exact revisioned `change` batches plus `presence`
  and lifecycle events. The Rust core originates table/scope/window/status/
  conflict domains; the bridge forwards them without counter diffing or a
  global-invalidation fallback. Bytes use `{ "$bytes": "<hex>" }`, and unsafe
  SQLite integers use `{ "$bigint": "<decimal>" }`.

Native CRDT text (plugin `crdt-yjs` feature) goes through `syncular_command`, and
`@syncular/tauri` exposes typed `crdtText` / `crdtInsertText` /
`crdtDeleteText` / `crdtApplyUpdate` methods, byte-compatible with the web
`@syncular/crdt-yjs` helper, so a Tauri app and a browser can edit the same
document. See [CRDT columns](/concepts-crdt/).

## Authority evidence before activation

Declare authority reads at client creation with `defineAuthorityReads` from
`@syncular/client/authority`. Each table declares plain columns, including
its primary key and scope columns, and concrete scope selectors. These selectors remain
fixed for that client. A declaration cannot include encrypted, bytes, blob,
CRDT or internal columns. Choose only authority fields; clinical fields and
credentials do not belong in this policy.

```ts
import { defineAuthorityReads } from '@syncular/client/authority';
import { createTauriAuthoritySyncClient } from '@syncular/tauri/authority';

const client = await createTauriAuthoritySyncClient({
  schema,
  securityPreflight: true,
  transportEnabled: false,
  authorityReads: defineAuthorityReads([{
    table: 'memberships',
    columns: ['id', 'user_id', 'facility_id', 'status', 'version'],
    scopes: { membership_id: acceptedMembershipIds },
  }]),
});
const evidence = await client.authoritySnapshot();
```

Use `createTauriAuthoritySyncClient` for the bridge that exposes
`authoritySnapshot()`. The ordinary `createTauriSyncClient` class does not
contain that method or its reply decoder. Upgrade 0.30.15 callers to these
explicit subpaths; the snapshot and native security checks keep their semantics.

The native application must also set an independent ceiling at plugin creation:

```rust
let config = SyncularConfig {
    authority_columns: [("memberships".into(), vec![
        "id".into(), "user_id".into(), "facility_id".into(),
        "status".into(), "version".into(),
    ])].into(),
    ..Default::default()
};
```

Rust rejects any webview declaration outside that ceiling. It also validates
columns against the schema. `authoritySnapshot()` accepts zero arguments;
forged IPC carrying SQL, replacement tables or columns fails with
`client.authority_read_forbidden`. Ordinary `query`, `querySnapshot` and writes
still fail with `client.security_preflight_required`.

The result contains `revision: bigint`, `complete`, and `tables`. Every table
contains accepted `rows` (`values`, server `version`, `hasLocalIntent`), scoped
`localIntentRowIds`, the declared `scopes`, `coverage`, and sanitized
`persisted` subscription evidence (`requestedScopes`, `effectiveScopes`,
`cursor`, `status`, `complete`). It exposes no intended values, bootstrap
tokens, subscription parameters or keys. Both cores read rows, revision and
coverage in one SQLite snapshot. The native authority read runs on the mutable
owner; it does not use the ordinary query sidecar or its latency contract.

`coverage` is `complete`, `pending` or `missing`. Complete coverage requires
completed unfiltered subscriptions for every requested scope tuple. Several
subscriptions can cover the selection together. Scope loss and an unfinished
bootstrap invalidate completeness. Completed empty coverage has an empty row
set. The application must reject admission when an expected authority row is
absent, even when the set is complete.

Accepted bases remain separate from pending, failed and protected ACK intent.
A local-only creation appears only in `localIntentRowIds`. The application
validates the complete chain against independently accepted authority evidence,
actor/device identity, signed lease and trusted time before installing keys.
The SDK does not authorize the application. The read changes no lifecycle,
transport, keyring, subscriptions or rows.

The direct Bun/SQLite client and worker handle expose the same policy and
snapshot shape. Importing the policy is opt-in; ordinary clients do not ship
its reader. Update npm packages and native crates together and rebuild the app.

## Local activation with transport closed

Create with `transportEnabled: false` to open the replica without starting
network work. Keep `SyncularConfig.auto_sync: true`; the native owner continues
handling local reads and commits, and resumes its existing scheduler when the
gate opens. The gate is independent of security preflight and encryption keys.

```ts
const client = await createTauriAuthoritySyncClient({
  schema,
  securityPreflight: true,
  transportEnabled: false,
});

// The app verifies its signed offline lease and device authentication first.
await client.activateSecurity({ encryption: acceptedKeyring });
// Authorized local queries and mutations now work; commits queue durably.

// After online authentication returns a fresh bearer:
await client.setHeaders({ authorization: `Bearer ${freshBearer}` });
await client.setTransportEnabled(true);
```

`setTransportEnabled(false)` blocks new HTTP rounds, realtime connections,
presence sends and uncached blob downloads with `sync.offline`. Cached blob
reads and staged uploads remain local. `setOffline(true)` is the bridge's
browser-parity alias. Automatic sync and retry intents stay suspended; reopening
emits one interactive wake and queued commits flush in FIFO order with own pull.
Header replacement and security activation never reopen the gate.

An already-started round finishes its captured network exchange and atomic apply,
including acknowledgement and revocation checks. Closure does not cancel its
reply. The owner releases realtime after the round settles, drops unsent control
frames and starts no follow-up round while closed. Local commands remain available
while a delayed reply is pending. Security preflight still blocks protected local
access and invalidates the old authorization context.

The gate defaults open on each newly created client and is never stored in
SQLite. Pass `transportEnabled: false` on every secure offline cold start.
Repeated pause or resume calls are idempotent. The existing realtime supervisor
owns reconnect after resume; a closed gate refuses its connect attempts without
opening a socket.

## Rotating auth

`SyncularConfig.headers` sets the initial header set at plugin registration.
The bridge replaces it at runtime for token rotation:

```ts
await client.setHeaders({ authorization: `Bearer ${freshToken}` });
```

Pass the FULL header set each time; it replaces the previous set. HTTP
requests (sync rounds, segments, blobs) use the new headers from the next
call; the realtime WebSocket sends headers at handshake time, so a live
socket keeps its old set until it reconnects. To force the new auth onto the
socket immediately, call `disconnectRealtime()` followed by
`connectRealtime()` after `setHeaders`.

## Threading

`SyncClient` is synchronous, owns a rusqlite connection, and is not `Sync`.
Exactly one owning thread holds the mutable core; commands and the §8.4 host
loop reach it over a mailbox. File-backed plugins add a second owner for a
read-only SQLite connection used only by atomic query snapshots. SQLite WAL
supplies the reader/writer snapshot boundary: network sync can block the
mutable owner without blocking local views, while no second mutable client or
writer exists. Interactive mutation/window/realtime intents preempt retry
deadlines, and both owners idle with zero periodic wakeups.

## Native transport

With `native-transport`, the plugin owns the network: blocking HTTP via
`ureq` (`POST /sync`, segment and blob endpoints) and the realtime socket via
`tungstenite`, with a reader thread routing inbound frames. When the socket
is connected, each combined push+pull round runs over the socket in the
§8.7 one-loop shape, the same behavior as the web client; with no socket the
round runs over `POST /sync`. One round is in flight per connection, and a
mid-round socket drop fails the round immediately.

FFI and Tauri re-export one transport implementation from `syncular-client`.
The socket URL carries the persisted database client id (while retaining other
configured query parameters), and the reader yields outside its short read
lock quantum so a quiet socket cannot starve round or acknowledgement sends.

Each unique live query is one atomic IPC round trip per relevant revision on
the independent read owner, shared by equal observers. Status/conflict-only
changes do not rerun SQL. For large result sets serialization can dominate, so
prefer indexed keyset pagination and bounded windows.

The generic `syncular_command` entry routes `querySnapshot` and `snapshotRead`
through the same handlers as their dedicated commands. Both return structured
read errors with `code`, `retryable`, and `details`. Owned reads report failures
and the first clearing success to the mutable owner; repeated successful reads
add no diagnostics messages to its mailbox. The reader tracks at most 256
outstanding owners, matching the diagnostic journal.

## Performance contract

For the isolated native read path, use `@syncular/tauri` and
`tauri-plugin-syncular` with a file-backed `db_path` or `database_dir`:

- `querySnapshot` reads rows, window coverage, and local revision atomically on
  the independent SQLite owner. `auto_sync`, HTTP rounds, and realtime socket
  work on the mutable owner cannot queue ahead of that read.
- The native bridge release gate requires warm snapshot IPC p95 to remain at or
  below 5 ms. The budget covers the local read; React rendering,
  reconciliation, and painting are outside it.
- An in-memory client (no `database` and `db_path: None`) falls back to the mutable
  owner: useful for tests, without the independent read-path latency contract
  or persistence across restarts.

A symptom-by-symptom checklist for slow, partial, or non-converging Tauri
views is in [Troubleshooting](/troubleshooting/#tauri).

## The example

[`bindings/tauri/example`](https://github.com/syncular/syncular/tree/main/bindings/tauri/example)
is a minimal Tauri app proving the loop end to end: `src-tauri` registers the
plugin with `native-transport` pointed at a local dev server, and the
frontend is a React todo list over `createTauriSyncClient`; the same generated
query phases, typed mutations, and status hooks used by browser clients apply.
The only Tauri-specific line is client construction.

## Where to go next

- **[React hooks](/platform-react/)**: the hook surface the bridge feeds.
- **[Rust](/platform-rust/)**: the `syncular-client` crate the plugin
  consumes directly.
- **[Realtime](/concepts-realtime/)**: sockets, deltas, and sync rounds over
  the socket.
- **[Server setup](/guide-server/)**: the server this native instance syncs
  against.

The snapshot API revision removes the individual `schemaFloor`, `leaseState`,
`upgrading`, and `syncNeeded` methods. Read those fields from
`await client.statusSnapshot()`. Collection and outcome reads remain methods.
React accepts the bridge directly. See the
[client migration](https://syncular.dev/platform-web/#snapshot-api-migration).

## Closed client errors

After `await client.close()`, data and control methods reject with
`client.closed` before checking security preflight. Local listener registration
and progress reads throw the same code. `close()` remains idempotent. Dispose
host session listeners with their client so a later sign-in cannot rotate a
closed replica's headers.

Use `activateSecurity({ encryption, headers })` to install the current bearer
atomically with activation. Runtime `setHeaders()` requires an active client.
