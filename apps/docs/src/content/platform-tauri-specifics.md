# Tauri: platform specifics

Reference for the native side of the Tauri SDK: threading, the command and event
surface, the native transport, the read-path performance contract, authority
evidence before activation, local activation with the transport closed, the
local authority, and the test clock.

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
| `syncular_command(command)` | The whole surface in one command. `command` is `{ "method": "...", "params": {...} }` (create, subscribe, mutate, sync, syncUntilIdle, resetClientId, conflicts, presence, setPresence, and more). The reply is `{ "result": ... }` or `{ "error": { "code", "message" } }`. |
| `syncular_query(sql, params)` | The raw read-only SQL fast path. |
| `syncular_query_snapshot(sql, params, coverage)` | One IPC read for rows, window completeness, and the exact local revision. |
| `events` channel | Exact revisioned `change` batches plus `presence` and lifecycle events. A `presence` event carries `error` (`presence.too_large` or `presence.forbidden`) when the server refuses this client's publish. The bridge passes a Tauri IPC `Channel` in the `create` params. |

The plugin runs one native client per app. Only the webview whose `create`
succeeded last receives its events; other webviews receive nothing, including
webviews granted `core:event:default`. A `create` without an `events` channel
fails with `sync.invalid_request`. A `create` from a second webview replaces
the first webview's client and moves ownership to the second webview. The
plugin refuses every other command from a webview that does not own the client
with `sync.client_owned_by_another_webview`, and the command never reaches the
client. A reload keeps the webview's label, so the owner stays the owner. Open
the client in one webview.

Within one page, `createTauriSyncClient` refuses a second client while the
first is open with `client.native_client_exists`, before the native `create`
runs: the plugin's one core would otherwise replace the first client's core,
including its pending writes and security state. Close the first client and
await `close()` before creating another. A page reload starts without a client,
so its `create` takes over the core.

### A client the Rust host creates

When Rust host code sends `create` through `app.syncular().command()`, the
plugin records the host as the client's creator. The schema, the database and
the authority declarations are the ones the host passed, so native code can
rely on what an `authorityRead` reads. The `authority_columns` ceiling still
applies to them when it is configured.

A webview reaches that client with `attachTauriSyncClient()`. The bridge sends
`attach` with its events channel, and the plugin delivers the client's events
to the webview that attached last. Commands, queries, snapshots and authority
reads from any webview then run as on a webview-created client, and the
security gate refuses ordinary reads during preflight as before. `attach`
answers with the client's security lifecycle, and the plugin emits a
`securityLifecycle` event after each `activateSecurity` and
`beginSecurityPreflight`, so the bridge's `securityLifecycle()` reads
`preflight` until the host activates and `active` after it.

```ts title="src/session.ts"
import { attachTauriSyncClient } from '@syncular/tauri';

const client = await attachTauriSyncClient();
```

The host owns the client's lifecycle. The plugin refuses a webview `create`,
`recreateWithSchema`, `shutdown` (which `close()` sends), `activateSecurity`
and `beginSecurityPreflight` with `client.host_owned` and the details
`{ method, webview }`; the command never reaches the client. `close()` still
releases the webview's bridge. A webview that closes or reloads leaves the
client open and host-owned, and the next webview attaches to the same client.
After the host sends `shutdown`, a webview `create` opens a webview-created
client under the rules above. `attach` before any `create`, or on a client a
webview created, fails with `sync.invalid_request`.

The Rust core originates the table, scope, window, status, and conflict domains.
The bridge forwards them without counter diffing or a global-invalidation
fallback. Bytes use `{ "$bytes": "<hex>" }`, and unsafe SQLite integers use
`{ "$bigint": "<decimal>" }`.

The `snapshotRead` method of `syncular_command` reads several statements plus
coverage, unit catch-up state, and delivery state in one read transaction.
`syncular_command` routes `querySnapshot` through the same handler as
`syncular_query_snapshot`. Both reads return structured read errors with
`code`, `retryable`, and `details`. Owned reads report failures
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

Declare the authority evidence as `authority query` declarations in your
`.syql` files. An authority query is a `sync query` over the columns of
schema tables: one statement, no dynamic sort, limit or conditional predicate,
and no FTS. It reads `string`, `integer`, `float`, `boolean`, `json` and
`bytes` columns, encrypted or not, `_sync_version` and, on a table with an
encrypted column, `_sync_sealed_key`. An encrypted column, a `bytes` column
and `_sync_sealed_key` are protected: a query that reads one runs only after
`activateSecurity`, and in preflight it fails with
`client.security_preflight_required` and the details `{ query }`. A query over
plain columns runs in preflight and while active, so keep clinical fields and
credentials out of plain columns. `typegen` emits each one as a data-only
declaration, `<name>Authority`, with its positional SQL, parameters, coverage
entries and read set ([SYQL](/syql/#authority-query)).

```syql title="schema/queries/authority.syql"
authority query membershipOriginal(membershipId) {
  select m.id, m.user_id, m.facility_id, m.status,
    m._sync_version as server_version
  from memberships as m
  where m.id = :membershipId;
}
```

Pass the declarations at client creation with `defineAuthorityReads` from
`@syncular/client/authority`. The set stays fixed for that client.

```ts title="src/session.ts"
import { defineAuthorityReads } from '@syncular/client/authority';
import { createTauriAuthoritySyncClient } from '@syncular/tauri/authority';
import { membershipOriginalAuthority } from './syncular.queries';

const client = await createTauriAuthoritySyncClient({
  schema,
  securityPreflight: true,
  transportGate: 'closed',
  authorityReads: defineAuthorityReads([membershipOriginalAuthority]),
});
const { revision, results } = await client.authorityRead(
  acceptedMembershipIds.map((membershipId) => ({
    query: 'membershipOriginal',
    params: { membershipId },
  })),
);
const complete = results.every((result) => result.complete);
```

`createTauriAuthoritySyncClient` returns the bridge that exposes
`authorityRead(requests)`. The ordinary `createTauriSyncClient` class contains
neither that method nor its reply decoder, so ordinary clients do not ship the
reader.

The native application also sets an independent ceiling at plugin creation:

```rust title="src-tauri/src/lib.rs"
let config = SyncularConfig {
    authority_columns: [("memberships".into(), vec![
        "id".into(), "user_id".into(), "facility_id".into(),
        "status".into(), "_sync_version".into(),
    ])].into(),
    ..Default::default()
};
```

At `create` the native host prepares each declared statement under a SQLite
authorizer and refuses it with `client.authority_read_forbidden` (details
`{ query, reason: "ceiling", table, column }`) when the statement reads a
column outside the ceiling. A protected column needs its ceiling entry like a
plain one. The check runs on the statement itself, so a
webview that understates the read set gains nothing. It prepares the
statements on the replica `create` opens; a refused `create` leaves no client,
and the next `create` opens the same file. A request naming an
undeclared query fails with `client.authority_query_unknown`, and a missing,
extra or mistyped parameter with `sync.invalid_request` and the details
`{ query, param }`. Ordinary `query`, `querySnapshot`, and writes still fail
with `client.security_preflight_required`.

On a client the Rust host created, the declarations come from the host's
`create`, and the ceiling check runs on them in the same way; see
[A client the Rust host creates](#a-client-the-rust-host-creates).

`authorityRead` runs every request in one SQLite read transaction and returns
`revision: bigint` and one result per request:

| Field | Content |
|---|---|
| `query` | The declared name. |
| `rows` | The statement's rows over the accepted base. |
| `coverage` | One entry per table and unit: `table`, `base`, `unit`, and `state` (`complete`, `pending`, `missing` or `revoked`). |
| `complete` | `true` when every coverage entry is `complete`. |
| `intent` | Every row of the query's read tables with local intent, `{ table, rowId, kind }`, sorted by table and row id. |

The statement reads each table's accepted base: the last state the server
accepted, without pending, failed or protected ACK intent. A row created on
the device and not yet accepted is absent, so it never makes a join or an
aggregate positive. `intent` names those rows at the same revision, including
the ones the rows omit: a pending creation, a pending delete, and a row whose
edit moves it out of the filter or the join. `kind` is `retained` for a row
with a retained failure, `acknowledged` for a commit the server accepted whose
row the pull has not delivered, and `pending` for outbox intent; a row with
several entries takes the first of that order. A `bytes` column reads as a
`Uint8Array` from the base, and `_sync_sealed_key AS sealed_key` names the
missing key of a sealed row, whose encrypted columns read NULL. Rows are returned even while coverage is incomplete, and
they are never evidence until `complete` is `true`. `pending` asks the host to
wait for a bootstrap, `missing` to register the unit, and `revoked` reports
lost access. A complete negative is `complete: true` with rows that say no
qualifying record exists.

A unit proves a coverage entry when its scope variables are a subset of the
entry's and its persisted echo restricts none of the others, so a unit
registered on a wrap's recipient proves a query that also fixes the wrap's
sealer. The application validates the evidence against independently accepted
authority pins, actor and device identity, a signed lease, and trusted time
before it installs keys. The SDK does not authorize the application, and the
read changes no lifecycle, transport, keyring, units, or rows. The native
authority read runs on the mutable owner and uses neither the ordinary query
read owner nor its latency contract.

The direct Bun and SQLite client and the worker handle expose the same policy
and result shape. Update npm packages and native crates together, and rebuild
the app.

## Local activation with transport closed

Create with `transportGate: 'closed'` to open the replica without network work.
Keep `SyncularConfig.auto_sync: true`: the native owner continues local reads and
commits, and resumes its scheduler when the gate opens. The gate is independent
of security preflight and encryption keys.

```ts title="src/session.ts"
import { createTauriSyncClient } from '@syncular/tauri';

const client = await createTauriSyncClient({
  schema,
  securityPreflight: true,
  transportGate: 'closed',
});

// The app verifies its signed offline lease and device authentication first.
await client.activateSecurity({ encryption: acceptedKeyring });
// Authorized local queries and mutations now work; commits queue durably.
// Keys that arrive later: await client.addEncryptionKeys(keys), see /concepts-encryption/#adding-a-key-while-the-client-runs

// The Rust `header_source` answers the fresh bearer on the next request.
await client.setTransportGate('open');
```

`setTransportGate('closed')` blocks new HTTP rounds, realtime connections,
presence sends, and uncached blob downloads with `sync.offline`. Cached blob
reads and staged uploads stay local. Automatic sync and retry intents stay
suspended; opening emits one interactive wake, and queued commits flush in FIFO
order with their own pull. `setTransportGate('pull')` runs rounds that pull and
send no commit, and a local write in `pull` schedules no round. Security
activation never changes the gate.

An already-started round finishes its captured network exchange and atomic apply,
including acknowledgement and revocation checks; closing the gate does not
cancel its reply. The owner releases realtime after the round settles, drops
unsent control frames, and starts no follow-up round while closed. Local
commands stay available while a delayed reply is pending. Security preflight
still blocks protected local access and invalidates the old authorization
context.

The gate defaults to `open` on each new client and is never stored in SQLite.
Pass `transportGate: 'closed'` on every secure offline cold start. Repeated pause or
resume calls are idempotent. The realtime supervisor owns reconnect after
resume, and a closed gate refuses its connect attempts without opening a socket.

## Local authority

Set `SyncularConfig.local_authority_path` to start without a server. The path
names the authority's own SQLite file, never the replica's `db_path`: the
client's schema reset drops every replica table outside `_syncular_*`. The
plugin enables the `local-authority` feature of `syncular-client`, so no Cargo
feature is needed.

```rust title="src-tauri/src/lib.rs"
let config = SyncularConfig {
    db_path: Some(data_dir.join("replica.db").display().to_string()),
    local_authority_path: Some(data_dir.join("authority.db").display().to_string()),
    base_url: Some("https://sync.example.com".into()),
    ..Default::default()
};
```

`create` opens the authority with the create schema. Sync rounds run against
the in-process authority until the attach completes, then against `base_url`.
While the state is `local`, `connectRealtime` and segment downloads fail with
`sync.invalid_request`. The attach commands fail with
`client.local_authority_unconfigured` when the plugin has no
`local_authority_path` or no `base_url`.

The bridge exposes the lifecycle on the client:

| Call | Does |
|---|---|
| `localAuthorityState()` | Resolves `'local'`, `'attaching'`, `'attached'`, or `null` when the plugin has no `local_authority_path`. Allowed during security preflight. |
| `attachLocalAuthority()` | Uploads the authority's live rows to the `base_url` server with the current headers. Rejects with `sync.attach_rejected` and `details.reason` when the server refuses. |
| `abandonLocalAuthorityAttach()` | Rolls back an attach that did not complete and returns the state to `local`. |

All three ride `syncular_command`, so the default permission set already covers
them. The client holds its sync rounds during an attach or rollback and restores
the transport gate afterwards. Scope choice, the attach sequence, and the rejection
reasons are in [Start without a server](/guide-local-authority/).

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
