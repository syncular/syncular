# Authorized local purge

`purgeLocalData()` is the narrow local-storage primitive for an application
that has already validated a server-authoritative device, membership, or
encryption-key revocation. It removes matching synced data and unsafe pending
writes from one client without inventing a remote-erasure protocol.

The host owns authority. Syncular owns the atomic SQLite consequences.

## Authority workflow

Use this order:

1. authenticate and validate a fresh directive, including its device, subject,
   key version, expiry, and replay/idempotency id;
2. quarantine the affected feature and gate or remove subscriptions that could
   download the protected rows again;
3. call `purgeLocalData()` with exact plaintext routing selectors;
4. delete app-owned drafts/files and remove relevant keys from the OS secure
   store;
5. acknowledge the directive only after every local stage succeeds.

The method does not authenticate the directive, revoke server authority,
delete arbitrary files, or erase an offline device remotely. A device that has
not acknowledged the directive is unconfirmed, not erased.

## Call the client

```ts
const result = await client.purgeLocalData({
  purgeId: directive.id,
  targets: [
    {
      table: 'patient_notes',
      selectors: {
        facility_id: [directive.facilityId],
        encryption_key_id: [directive.keyVersionId],
      },
    },
  ],
});

// Counts only: no row ids or selector values leave the local engine.
console.log(result.alreadyApplied, result.purgedRows, result.droppedCommits);
```

Selectors inside one target use AND semantics; targets use OR semantics. The
example deletes `patient_notes` rows matching both the facility and key
version. A selector must name a plaintext string schema column and contain one
or more exact, code-like values. There is intentionally no empty target,
wildcard, expression, encrypted selector, or full-table mode.

Inputs are bounded: at most 64 targets, 8 selectors per target, and 128 values
per selector. `purgeId` is a 1–128 character code-like id; routing values are
1–256 characters. Plans are canonicalized, so selector order and duplicate
values do not change identity.

## Atomic effects

One local SQLite transaction:

- deletes matching visible and confirmed synced rows;
- lets generated FTS5 maintenance remove matching search documents;
- rejects each whole pending commit that touches a target with
  `client.local_data_purged`—an atomic multi-row commit is never split;
- restores the last confirmed rows and replays safe later optimistic edits;
- reconciles cached blob references;
- records the purge id and canonical plan durably;
- journals the dropped commit outcomes and emits one revisioned change batch.

Retrying the same id and plan returns `alreadyApplied: true` with zero new
counts. Reusing an id with a different plan fails closed. This makes a host
retry safe after a crash or ambiguous bridge response.

## Host coverage

| Host | Call |
| --- | --- |
| Direct TypeScript client | `client.purgeLocalData(input)` |
| Browser worker / multi-tab handle | `await handle.purgeLocalData(input)` |
| React | `await useSyncClient().purgeLocalData(input)` |
| Tauri | `await client.purgeLocalData(input)` |
| React Native | `await client.purgeLocalData(input)` |
| Rust | `client.purge_local_data(&input)` |
| C FFI and other native bindings | `purgeLocalData` through `syncular_client_command` |

The async bridges return the same counts-only shape. Direct TypeScript and Rust
use their native naming conventions but apply the same validation and atomic
behavior.

## Subscription gating is mandatory

Purging while the old subscription is still active is temporary: the next
sync may download the rows again. Gate authorization and subscription intent
first, then purge. For a revoked encryption key, delete the OS-secure-store key
only after SQLite cleanup succeeds, otherwise the app may be unable to inspect
or clean its remaining protected local data.

For the key lifecycle, see [Client-side encryption](/concepts-encryption/).
For the durable evidence left by rejected pending work, see
[Conflicts & optimistic writes](/concepts-conflicts/).

## Race-free security bootstrap

Use the shared client lifecycle when the purge decision must happen before any
protected data can be queried or synced:

```ts
const client = await createClient({
  ...config,
  securityPreflight: true,
});

// Validate and durably journal the signed directive in application code.
await client.purgeLocalData(directive.plan);
await client.activateSecurity({ encryption: acceptedKeyring });
```

`preflight` permits lifecycle/status/local-revision inspection and the exact
purge only. Queries, mutations, subscription changes, outbox access, sync,
realtime/presence, blobs, and automatic host-loop work fail with
`client.security_preflight_required`. `beginSecurityPreflight()` provides the
same barrier for a live revocation: it gates new work immediately and waits for
already-started database/network/native-sidecar work before releasing the old
keyring. Activation cannot overtake that barrier.
