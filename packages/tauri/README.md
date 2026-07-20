# @syncular/tauri

Tauri integration for the Syncular client.

Install the bridge together with its required Tauri JavaScript API peer:

```sh
bun add @syncular/tauri @tauri-apps/api
```

Reactive snapshots use the plugin's independent read-only SQLite path, so
local Tauri views remain responsive while the native client is syncing over
HTTP/WebSocket. Mutations, sync, and all durable writes remain serialized on
the single mutable core owner.

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
or secure-erasure API. The JavaScript bridge strictly validates the exact
acknowledgement shape and non-negative safe-integer counts; version drift or a
malformed native response fails with the sanitized, stable
`client.invalid_host_response` code before application recovery state can
persist it.

## Secure preflight and native disposal

Create with `securityPreflight: true` when authentication, signed device
quarantine, or crash-resumed cleanup must finish before clinical data is
available. The native database opens and migrates, but query/snapshot, mutation,
subscription, sync, realtime, presence, blob, and automatic retry work fails
with `client.security_preflight_required`. Status, local revision, lifecycle,
and `purgeLocalData` remain available.

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
headers through trusted plugin configuration; rotate them only after successful
activation.

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
