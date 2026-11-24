# @syncular/tauri

Tauri integration for the Syncular client.

Install the bridge together with its required Tauri JavaScript API peer:

```sh
bun add @syncular/tauri @tauri-apps/api
```

The bridge works with any frontend framework. Generate the schema module using
the [existing-project setup](https://syncular.dev/add-to-existing-app/),
then create one shared client in the webview:

```ts
// src/sync.ts
import { createTauriSyncClient } from '@syncular/tauri';
import { schema } from './syncular.generated';

export const client = await createTauriSyncClient({ schema });
```

Use `@syncular/tauri/remote` for a client that only connects to a remote
authority, and leave the native plugin's `local_authority_path` unset. This
entry omits the JavaScript local-authority lifecycle methods while retaining
the other client APIs. It does not change the code compiled into the native
plugin. The default `@syncular/tauri` entry retains those lifecycle methods.

Register the native plugin as described in the
[Tauri guide](https://syncular.dev/platform-tauri/). React apps can separately
install `@syncular/react` for hooks over the same client.

Reactive snapshots use the plugin's independent read-only SQLite path, so
local Tauri views remain responsive while the native client is syncing over
HTTP/WebSocket. Mutations, sync, and all durable writes remain serialized on
the single mutable core owner.

## Realtime lifecycle

Use the supervisor exported by `@syncular/client` for the WebView host policy:

```ts
import {
  browserConnectivitySignal,
  documentLifecycleSignal,
  installRealtimeSupervisor,
} from '@syncular/client';
import { createTauriSyncClient } from '@syncular/tauri';

const client = await createTauriSyncClient({ schema });
installRealtimeSupervisor(client, {
  connectivity: browserConnectivitySignal(),
  lifecycle: documentLifecycleSignal(),
  protection,
});
```

The supervisor performs reconnect, bounded retry, resume catch-up, diagnostics,
and close cancellation without opening duplicate native sockets. The document
signal is the portable WebView baseline. Apps that observe native sleep/wake or
window lifecycle should pass that evidence through the same structural
`RealtimeSupervisorSignal`; protected apps publish `preflight` before releasing
keys and `active` only after reactivation. Render local SQLite immediately.

The bridge includes the native core's durable commit-outcome journal:
`commitDelivery`, `commitOutcomes`, and `resolveCommitOutcome`. Final results
and explicit conflict resolutions survive process restarts; active failures
are never silently removed by retention. Failed outcomes retain their complete
ordered local operation envelope for authorized aggregate recovery with the
same protected-storage and retention contract as the core client.

The bridge also exposes `purgeLocalData({ purgeId, targets })` with the same
idempotent transaction as the browser worker: exact synced-row and generated
FTS deletion, whole-commit outbox rejection, optimistic replay, blob-reference
reconciliation, and counts-only acknowledgement. The app remains responsible
for validating the server-authoritative directive, gating units before
the purge, deleting app-owned drafts/files, and removing the corresponding key
from the OS secure store after SQLite cleanup succeeds.

For support-directed projection recovery, the bridge also exposes
`rebootstrapLocalData({ rebootstrapId })`. It atomically recreates only synced
projection tables, rewinds every registered unit, replays the complete
outbox, and requests a fresh bootstrap while preserving device identity,
lease state, outcomes, and protected bookkeeping. The result contains only
`alreadyApplied`, `retainedCommits`, and `resetSubscriptions`. It is blocked
during security preflight and an active schema-floor stop; it is not a sign-out
or secure-erasure API. The native SQLite marker atomically retains the original
counts, so a retry after process restart returns `alreadyApplied: true` with the
same receipt rather than zero counts. Malformed or unreadable receipt storage
fails closed as sanitized `sync.local_corrupt` without repeating the reset;
pre-0.15.36 legacy markers retain their former zero-count compatibility. The
JavaScript bridge strictly validates the exact
acknowledgement shape and non-negative safe-integer counts; version drift or a
malformed native response fails with the sanitized, stable
`client.invalid_host_response` code before application recovery state can
persist it.

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

## Local activation with transport closed

Create with `transportGate: 'closed'` to open the replica without starting
network work. Keep `SyncularConfig.auto_sync: true`; the native owner continues
handling local reads and commits, and resumes its existing scheduler when the
gate opens. The gate is independent of security preflight and encryption keys.

```ts
const client = await createTauriSyncClient({
  schema,
  securityPreflight: true,
  transportGate: 'closed',
});

// The app verifies its signed offline lease and device authentication first.
await client.activateSecurity({ encryption: acceptedKeyring });
// Authorized local queries and mutations now work; commits queue durably.

// The Rust `header_source` answers the fresh bearer on the next request.
await client.setTransportGate('open');
```

`setTransportGate('closed')` blocks new HTTP rounds, realtime connections,
presence sends and uncached blob downloads with `sync.offline`. Cached blob
reads and staged uploads remain local. Automatic sync and retry intents stay
suspended; opening emits one interactive wake and queued commits flush in FIFO
order with their own pull. `setTransportGate('pull')` runs rounds that pull and
send no commit, and a local write in `pull` schedules no round. Security
activation never changes the gate.

An already-started round finishes its captured network exchange and atomic apply,
including acknowledgement and revocation checks. Closure does not cancel its
reply. The owner releases realtime after the round settles, drops unsent control
frames and starts no follow-up round while closed. Local commands remain available
while a delayed reply is pending. Security preflight still blocks protected local
access and invalidates the old authorization context.

The gate defaults to `open` on each newly created client and is never stored
in SQLite. Pass `transportGate: 'closed'` on every secure offline cold start.
Repeated pause or resume calls are idempotent. The existing realtime supervisor
owns reconnect after resume; a closed gate refuses its connect attempts without
opening a socket.

## Secure preflight and native disposal

Create with `securityPreflight: true` when authentication, signed device
quarantine, or crash-resumed cleanup must finish before clinical data is
available. The native database opens and migrates, but query/snapshot, mutation,
unit registration, sync, realtime, presence, blob, and automatic retry work fails
with `client.security_preflight_required`. Status, local revision, lifecycle,
and `purgeLocalData` remain available. A creation-time `defineAuthorityReads`
policy on `createTauriAuthoritySyncClient` enables the read-only
`authorityRead(requests)` described below.

```ts
const client = await createTauriSyncClient({
  schema,
  securityPreflight: true,
});

await client.purgeLocalData(directive.plan);
await client.activateSecurity({ encryption: acceptedKeyring });
```

`beginSecurityPreflight()` closes the JavaScript gate synchronously, waits for
the mutable owner and independent SQLite snapshot reader, disconnects realtime,
and removes the Rust keyring. `close()` now issues native shutdown before
detaching listeners, so disposing a resource does not leave a key-bearing core
behind. The Rust core overwrites owned key buffers on replacement/drop; the app
still owns OS secure-store deletion and any key buffers it supplied.

The webview has no call that sets headers: the host's Rust `header_source` supplies them, and `activateSecurity` takes none. `addEncryptionKeys(keys)` adds keys to the active keyring ([Encryption](https://syncular.dev/concepts-encryption/#adding-a-key-while-the-client-runs)). Closed clients reject data
and control calls with `client.closed` before testing preflight; listener
registration and local progress reads throw that code. `close()` is idempotent.

## Authority evidence before activation

Declare authority queries at client creation with `defineAuthorityReads` from
`@syncular/client/authority`. Each entry is a generated `authority query`
declaration (SYQL.md §13.3). The declared set stays fixed for that client. A
read set cannot include `blob_ref`, CRDT or internal columns. Encrypted
columns, `bytes` columns and `_sync_sealed_key` are protected: a query that
reads one runs only while the lifecycle is active and fails in preflight with
`client.security_preflight_required` and the details `{ query }`. A query over
plain columns runs in preflight too, so keep clinical fields and credentials
out of plain columns.

```ts
import { defineAuthorityReads } from '@syncular/client/authority';
import { createTauriAuthoritySyncClient } from '@syncular/tauri/authority';

const client = await createTauriAuthoritySyncClient({
  schema,
  securityPreflight: true,
  transportGate: 'closed',
  authorityReads: defineAuthorityReads([activeMembershipAuthority]),
});
const { revision, results } = await client.authorityRead([
  { query: 'activeMembership', params: { userId, facilityId } },
]);
```

Use `createTauriAuthoritySyncClient` for the bridge that exposes
`authorityRead(requests)`. The ordinary `createTauriSyncClient` class does not
contain that method or its reply decoder.

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

At `create` Rust prepares each declared statement under a SQLite authorizer
and refuses a declaration that reads outside that ceiling (a protected column
needs its ceiling entry too), or performs any
action other than a read or a deterministic core function, with
`client.authority_read_forbidden` and `reason: "ceiling"`. The native
`authorityRead` command takes `{ requests }` and nothing else; forged IPC
carrying SQL or replacement declarations fails with
`client.authority_read_forbidden`. Ordinary `query`, `querySnapshot` and
writes still fail with `client.security_preflight_required`.

The result contains `revision: bigint` and one result per request with the
query's raw SQL `rows`, its `coverage` entries (`table`, `base`, `unit`,
`state`), `complete` and `intent`: every row of the query's read tables with
local intent as `{ table, rowId, kind }` (`pending`, `retained` or
`acknowledged`), including rows the result omits. Both cores read rows,
revision, coverage and intent in one SQLite read transaction. The native authority read runs on the mutable owner;
it does not use the ordinary query sidecar or its latency contract.

A coverage entry is `complete`, `pending` (the unit is still bootstrapping or
its echo restricts the entry), `missing` (no unit) or `revoked` (the unit is
revoked or failed). A complete negative is `complete: true` with rows that
say no qualifying record exists. Rows are never evidence while `complete` is
false.

The queries read accepted bases: pending, failed and protected ACK intent
never replace an accepted value, and a local-only creation is absent. The
application validates the complete chain against independently accepted
authority evidence, actor/device identity, signed lease and trusted time
before installing keys. The SDK does not authorize the application. The read
changes no lifecycle, transport, keyring, units or rows.

The direct Bun/SQLite client and worker handle expose the same policy and
result shape. Importing the policy is opt-in; ordinary clients do not ship
its reader. Update npm packages and native crates together and rebuild the app.

## Privacy-safe diagnostics

`diagnosticsSnapshot()` and `onDiagnostics(listener)` carry the native Rust
core's version 2 support evidence through the Tauri event channel: registered
units counted per state (`units`), `activeUnits` and the `replicaCursor`. A unit
id never enters the snapshot. The bridge marks the host as
`{ kind: 'tauri', role: 'single' }`; it does not infer state from IPC commands.

The snapshot is suitable for a redacted “copy diagnostics” workflow: it omits
rows, clinical row counts, scopes, SQL, paths, client/actor/lease ids, auth,
keys, mutations, stack traces, and arbitrary prose. Do not supplement it with
the SQLite file, WebView console dump, or application state. Diagnostics stays
blocked during security preflight because unit and table evidence is
protected. See SPEC §7.6 and `@syncular/react`'s `useDiagnostics`.

## React availability guard

The Tauri bridge carries `currentSchemaVersion`, `schemaFloor`, and migration
status through the same public React boundary as the browser worker. Guard the
application once instead of parsing native error strings:

```tsx
<SyncProvider
  client={clientResource}
  renderBoundary={(state, actions) => (
    <SyncBlockedScreen state={state} onRetry={actions.retry} />
  )}
>
  <App />
</SyncProvider>
```

The state is a discriminated union covering startup, migration,
`client-upgrade-required`, `server-behind`, and `incompatible-schema`.
Compatibility recovery automatically restores the provider's children. Live
queries report `phase === 'blocked'` with `isLoading === false` while retaining
previously safe rows for an explicitly read-only view.

Part of [Syncular](https://syncular.dev) — an offline-first sync framework.
See the [Syncular repository](https://github.com/syncular/syncular) for docs.

## License

Apache-2.0

The snapshot API revision removes the individual `schemaFloor`, `leaseState`,
`upgrading`, and `syncNeeded` methods. Read those fields from
`await client.statusSnapshot()`. Collection and outcome reads remain methods.
React accepts the bridge directly. See the
[client migration](https://syncular.dev/platform-web-reads-writes/#reading-local-state).


## Atomic sparse writes and retained conflicts

The native client accepts mixed `patch`, `upsert` and `delete` operations in one
`mutate` call. Sparse patches include the primary key and supplied columns.
Omitted encrypted columns require no key and retain their ciphertext.

Set `retainFailedCommits: true` to preserve rejected aggregate intent across
pulls and restart. A `known` `commitDelivery(id)` outcome's `retainedRows` exposes intended rows and the
latest authorized server base. Resolve with `resolved_keep_server`, or create a
reviewed replacement and link it with `superseded`. Scope revocation and local
security purge remove whole retained aggregates.

A retained insert whose unique key belongs to another server primary key remains
journal intent while reads show the server winner. `retainedRows[].uniqueConflicts`
contains each matching index, its columns, competing `rowId`, authorized
`serverRow` and `serverVersion`. Keep-mine patches that competing ID at its
current version and links the replacement through `superseded`. Edit can choose
a free unique key. Take-server uses `resolved_keep_server`. Revocation and local
security purge erase the retained aggregate's protected journal payloads.
