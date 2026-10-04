# @syncular/tauri

Tauri integration for the Syncular client.

Install the bridge together with its required Tauri JavaScript API peer:

```sh
bun add @syncular/tauri @tauri-apps/api
```

The bridge works with any frontend framework. Generate the schema module using
the [existing-project setup](https://syncular.dev/guide-schema/#add-syncular-to-an-existing-project),
then create one shared client in the webview:

```ts
// src/sync.ts
import { createTauriSyncClient } from '@syncular/tauri';
import { schema } from './syncular.generated';

export const client = await createTauriSyncClient({ schema });
```

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
`commitOutcome`, `commitOutcomes`, and `resolveCommitOutcome`. Final results
and explicit conflict resolutions survive process restarts; active failures
are never silently removed by retention. Failed outcomes retain their complete
ordered local operation envelope for authorized aggregate recovery with the
same protected-storage and retention contract as the core client.

The bridge also exposes `purgeLocalData({ purgeId, targets })` with the same
idempotent transaction as the browser worker: exact synced-row and generated
FTS deletion, whole-commit outbox rejection, optimistic replay, blob-reference
reconciliation, and counts-only acknowledgement. The app remains responsible
for validating the server-authoritative directive, gating subscriptions before
the purge, deleting app-owned drafts/files, and removing the corresponding key
from the OS secure store after SQLite cleanup succeeds.

For support-directed projection recovery, the bridge also exposes
`rebootstrapLocalData({ rebootstrapId })`. It atomically recreates only synced
projection tables, rewinds retained subscriptions, replays the complete
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

Create with `transportEnabled: false` to open the replica without starting
network work. Keep `SyncularConfig.auto_sync: true`; the native owner continues
handling local reads and commits, and resumes its existing scheduler when the
gate opens. The gate is independent of security preflight and encryption keys.

```ts
const client = await createTauriSyncClient({
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

## Secure preflight and native disposal

Create with `securityPreflight: true` when authentication, signed device
quarantine, or crash-resumed cleanup must finish before clinical data is
available. The native database opens and migrates, but query/snapshot, mutation,
subscription, sync, realtime, presence, blob, and automatic retry work fails
with `client.security_preflight_required`. Status, local revision, lifecycle,
and `purgeLocalData` remain available. A creation-time `defineAuthorityReads`
policy on `createTauriAuthoritySyncClient` enables the read-only
`authoritySnapshot()` described below.

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

Runtime `setHeaders()` is an active-session operation and is rejected during
preflight at both the JavaScript and native command boundaries. Supply bootstrap
headers through trusted plugin configuration or `activateSecurity({ headers })`;
the latter installs the current bearer before the startup round. Rotate them
with `setHeaders()` only after successful activation. Closed clients reject data
and control calls with `client.closed` before testing preflight; listener
registration and local progress reads throw that code. `close()` is idempotent.

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

## Privacy-safe diagnostics

`diagnosticsSnapshot({ expectedSubscriptions })` and `onDiagnostics(listener)`
carry the native Rust core's versioned support evidence through the Tauri event
channel. The bridge marks the host as `{ kind: 'tauri', role: 'single' }`; it
does not infer state from IPC commands. Expected subscriptions accept only
stable PHI-free ids and generated table names, never scope values.

The snapshot is suitable for a redacted “copy diagnostics” workflow: it omits
rows, clinical row counts, scopes, SQL, paths, client/actor/lease ids, auth,
keys, mutations, stack traces, and arbitrary prose. Do not supplement it with
the SQLite file, WebView console dump, or application state. Diagnostics stays
blocked during security preflight because subscription/table evidence is
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
[client migration](https://syncular.dev/platform-web/#snapshot-api-migration).


## Atomic sparse writes and retained conflicts

The native client accepts mixed `patch`, `upsert` and `delete` operations in one
`mutate` call. Sparse patches include the primary key and supplied columns.
Omitted encrypted columns require no key and retain their ciphertext.

Set `retainFailedCommits: true` to preserve rejected aggregate intent across
pulls and restart. `commitOutcome(id).retainedRows` exposes intended rows and the
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
