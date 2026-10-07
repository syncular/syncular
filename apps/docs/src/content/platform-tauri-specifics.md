# Tauri: platform specifics

Reference for the native side of the Tauri SDK: threading, the command and event
surface, the native transport, the read-path performance contract, authority
evidence before activation, local activation with the transport closed, and the
test clock.

::meta{for="Developers hardening or debugging a Tauri deployment" time="20 minutes" first="platform-tauri-install" spec="8.4 8.7"}

:::terms
- **Mutable owner**: The one thread that holds the writable core and its SQLite connection.
- **Read owner**: The thread that holds a read-only SQLite connection for atomic query snapshots.
- **Transport gate**: A switch that closes all network work while local work continues.
- **Authority evidence**: Accepted server rows an app checks before it installs keys.
:::

## Threading

`SyncClient` is synchronous, owns a rusqlite connection, and is not `Sync`.
Exactly one owning thread holds the mutable core. Commands and the §8.4 host
loop reach it over a mailbox. A file-backed plugin adds a second owner for a
read-only SQLite connection used only by atomic query snapshots.

:::figure{title="Two owners, one WAL file" note="Reads never queue behind sync" ticks}
<div class="d-row">
<div class="node hot"><span class="t">Mutable owner</span>Commands, host loop, HTTP rounds, realtime, writes</div>
<div class="d-down">SQLite WAL<small>one writes, one reads</small></div>
<div class="node ok"><span class="t">Read owner</span>Read-only connection, atomic snapshots</div>
</div>

::caption[SQLite WAL supplies the reader and writer snapshot boundary. Network sync can block the mutable owner without blocking local views, and no second mutable client or writer exists.]
:::

Interactive mutation, window, and realtime intents preempt retry deadlines. Both
owners idle with zero periodic wakeups.

### Local commands during sync

The native owner captures one request and hands its network I/O to a separate
executor. Local mutations and queries continue while the server reply or the
segment bytes are pending. The owner applies the reply with the captured commit
ids and the normal version checks; writes authored during the round replay over
that base and enter the next request. Socket acknowledgements use the same I/O
executor, and no extra polling loop exists.

An acknowledgement rebuilds only the tables the commit or pull touched.
Unchanged tables and their FTS projections stay untouched, so a catalogue's size
adds no full-table copy to an unrelated edit. A schema reset or a restart can
still rebuild the complete projection.

## Native transport

With `native-transport`, the plugin owns the network: blocking HTTP through
`ureq` (`POST /sync`, segment and blob endpoints) and the realtime socket
through `tungstenite`, with a reader thread that routes inbound frames. When the
socket is connected, each combined push and pull round runs over the socket in
the §8.7 one-loop shape, the same behavior as the web client. With no socket the
round runs over `POST /sync`. One round is in flight per connection, and a
mid-round socket drop fails the round immediately.

FFI and Tauri re-export one transport implementation from `syncular-client`. The
socket URL carries the persisted database client id and keeps the other
configured query parameters. The reader yields outside its short read-lock
quantum, so a quiet socket cannot starve round or acknowledgement sends.

## The command and event surface

The plugin dispatches through the shared `syncular-command` router, the same one
the conformance shim and the C-ABI FFI use, so the surface is conformance-locked.

| Entry | Does |
|---|---|
| `syncular_command(command)` | The whole surface in one command. `command` is `{ "method": "...", "params": {...} }` (create, subscribe, mutate, sync, syncUntilIdle, conflicts, presence, setPresence, and more). The reply is `{ "result": ... }` or `{ "error": { "code", "message" } }`. |
| `syncular_query(sql, params)` | The raw read-only SQL fast path. |
| `syncular_query_snapshot(sql, params, coverage)` | One IPC read for rows, window completeness, and the exact local revision. |
| `syncular_snapshot_read(...)` | Several statements plus coverage, subscription progress, and delivery state in one read transaction. |
| `syncular_set_headers(headers)` | Replaces the native transport's request headers at runtime. |
| `syncular://event` | Exact revisioned `change` batches plus `presence` and lifecycle events. |

The Rust core originates the table, scope, window, status, and conflict domains.
The bridge forwards them without counter diffing or a global-invalidation
fallback. Bytes use `{ "$bytes": "<hex>" }`, and unsafe SQLite integers use
`{ "$bigint": "<decimal>" }`.

The generic `syncular_command` entry routes `querySnapshot` and `snapshotRead`
through the same handlers as their dedicated commands. Both return structured
read errors with `code`, `retryable`, and `details`. Owned reads report failures
and the first clearing success to the mutable owner; repeated successful reads
add no diagnostics messages to its mailbox. The reader tracks at most 256
outstanding owners, matching the diagnostic journal.

Native CRDT text goes through `syncular_command` with the plugin's `crdt-yjs`
feature; the bridge wraps it in typed methods ([Reads &
writes](/platform-tauri-reads-writes/#collaborative-text)).

## Performance contract

For the isolated native read path, use `@syncular/tauri` and
`tauri-plugin-syncular` with a file-backed `db_path` or `database_dir`.

| Property | Behavior |
|---|---|
| `querySnapshot` | Reads rows, window coverage, and the local revision atomically on the read owner. `auto_sync`, HTTP rounds, and realtime work on the mutable owner cannot queue ahead of that read. |
| Release gate | Warm snapshot IPC p95 stays at or below 5 ms. The budget covers the local read; React rendering, reconciliation, and painting sit outside it. |
| In-memory client | With no `database` and `db_path: None`, reads fall back to the mutable owner. That suits tests and has neither the independent read-path latency contract nor persistence across restarts. |
| Live queries | Each unique live query is one atomic IPC round trip per relevant revision on the read owner, shared by equal observers. Status-only and conflict-only changes do not rerun SQL. |

For large result sets, serialization can dominate the round trip. Prefer indexed
keyset pagination and bounded windows.

## Authority evidence before activation

Declare authority reads at client creation with `defineAuthorityReads` from
`@syncular/client/authority`. Each table declares plain columns, including its
primary key and scope columns, and concrete scope selectors. The selectors stay
fixed for that client. A declaration cannot include encrypted, bytes, blob, CRDT,
or internal columns. Choose only authority fields; clinical fields and
credentials do not belong in this policy.

```ts title="src/session.ts"
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

`createTauriAuthoritySyncClient` returns the bridge that exposes
`authoritySnapshot()`. The ordinary `createTauriSyncClient` class contains
neither that method nor its reply decoder, so importing the policy is opt-in and
ordinary clients do not ship its reader.

The native application also sets an independent ceiling at plugin creation:

```rust title="src-tauri/src/lib.rs"
let config = SyncularConfig {
    authority_columns: [("memberships".into(), vec![
        "id".into(), "user_id".into(), "facility_id".into(),
        "status".into(), "version".into(),
    ])].into(),
    ..Default::default()
};
```

Rust rejects any webview declaration outside that ceiling and validates columns
against the schema. `authoritySnapshot()` accepts zero arguments; forged IPC
carrying SQL, replacement tables, or columns fails with
`client.authority_read_forbidden`. Ordinary `query`, `querySnapshot`, and writes
still fail with `client.security_preflight_required`.

The result contains `revision: bigint`, `complete`, and `tables`. Each table
holds:

| Field | Content |
|---|---|
| `rows` | Accepted rows: `values`, server `version`, `hasLocalIntent`. |
| `localIntentRowIds` | Scoped ids of rows with local intent. |
| `scopes` | The declared scopes. |
| `coverage` | `complete`, `pending`, or `missing`. |
| `persisted` | Sanitized subscription evidence: `requestedScopes`, `effectiveScopes`, `cursor`, `status`, `complete`. |

The result exposes no intended values, bootstrap tokens, subscription
parameters, or keys. Both cores read rows, revision, and coverage in one SQLite
snapshot. The native authority read runs on the mutable owner and uses neither
the ordinary query read owner nor its latency contract.

`complete` coverage requires completed unfiltered subscriptions for every
requested scope tuple; several subscriptions can cover a selection together.
Scope loss and an unfinished bootstrap invalidate completeness. Completed empty
coverage has an empty row set. The application rejects admission when an
expected authority row is absent, even when the set is complete.

Accepted bases stay separate from pending, failed, and protected ACK intent. A
local-only creation appears only in `localIntentRowIds`. The application
validates the complete chain against independently accepted authority evidence,
actor and device identity, a signed lease, and trusted time before it installs
keys. The SDK does not authorize the application, and the read changes no
lifecycle, transport, keyring, subscriptions, or rows.

The direct Bun and SQLite client and the worker handle expose the same policy
and snapshot shape. Update npm packages and native crates together, and rebuild
the app.

## Local activation with transport closed

Create with `transportEnabled: false` to open the replica without network work.
Keep `SyncularConfig.auto_sync: true`: the native owner continues local reads and
commits, and resumes its scheduler when the gate opens. The gate is independent
of security preflight and encryption keys.

```ts title="src/session.ts"
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
presence sends, and uncached blob downloads with `sync.offline`. Cached blob
reads and staged uploads stay local. `setOffline(true)` is the bridge's alias
for browser parity. Automatic sync and retry intents stay suspended; reopening
emits one interactive wake, and queued commits flush in FIFO order with their own
pull. Header replacement and security activation never reopen the gate.

An already-started round finishes its captured network exchange and atomic apply,
including acknowledgement and revocation checks; closing the gate does not
cancel its reply. The owner releases realtime after the round settles, drops
unsent control frames, and starts no follow-up round while closed. Local
commands stay available while a delayed reply is pending. Security preflight
still blocks protected local access and invalidates the old authorization
context.

The gate defaults open on each new client and is never stored in SQLite. Pass
`transportEnabled: false` on every secure offline cold start. Repeated pause or
resume calls are idempotent. The realtime supervisor owns reconnect after
resume, and a closed gate refuses its connect attempts without opening a socket.

## Test clock

`create` accepts an optional `nowMs` that pins the client clock. The plugin reads
and applies it through the shared command router, so the core's `capturedAtMs`,
lease expiry, and previous-version TTL stay deterministic in a test. The Rust
side sets it through the command; the bridge config does not carry the field.

To move the pinned clock mid-test, build the plugin with its `test-clock`
feature and call `SyncularCore::set_now_ms`:

```rust title="src-tauri/tests/clock.rs"
use tauri_plugin_syncular::core::SyncularCore;

let mut core = SyncularCore::new(&serde_json::json!({}))?;
core.command(&serde_json::json!({
    "method": "create",
    "params": { "clientId": "test", "schema": schema, "nowMs": 1_000 },
}));
core.set_now_ms(2_000)?; // set the client clock from the host test clock
```

The setter accepts an earlier or later timestamp in milliseconds since the Unix
epoch and returns `client.not_created` before a `create`. The feature is off by
default. Set the host's own test clock separately.
