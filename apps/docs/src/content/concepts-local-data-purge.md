# Authorized local purge

Use `purgeLocalData()` when your application has validated a server-authoritative device, membership, or encryption-key revocation and must remove the matching data from one client. The method deletes matching synced rows and unsafe pending writes in one atomic SQLite transaction. It does not authenticate the directive, revoke server access, delete files, or erase an offline device remotely. A device that has not acknowledged the directive stays unconfirmed and may still hold its data.

::meta{for="App developers who handle revocation and key removal" time="12 minutes" first="concepts-encryption"}

:::terms
- **Directive**: The signed, server-authoritative instruction to remove data from a device.
- **Purge plan**: The `purgeId` plus the exact `targets` a purge removes.
- **Selector**: A plaintext string column and the exact values that route rows into a target.
- **Security preflight**: A client state that permits only lifecycle inspection and the exact purge until `activateSecurity`.
:::

:::figure{title="Who does what in a revocation" note="Application authority, local engine" ticks}
<div class="d-row">
<div class="node hot"><span class="t">01 · Application</span>Validates the directive: device, subject, key version, expiry, replay id</div>
<span class="d-arrow"></span>
<div class="node hot"><span class="t">02 · Application</span>Gates features and subscriptions that could re-download the rows</div>
<span class="d-arrow"></span>
<div class="node ok"><span class="t">03 · Client</span>purgeLocalData(): one atomic SQLite transaction</div>
<span class="d-arrow"></span>
<div class="node hot"><span class="t">04 · Application</span>Deletes drafts and files, removes keys, acknowledges</div>
</div>

::caption[Steps 01, 02, and 04 belong to your application. The client performs step 03 and trusts the plan it receives.]
:::

## Run a purge

::::steps
:::step{title="Validate the directive" time="2 min"}
Authenticate a fresh directive and check its device, subject, key version, expiry, and replay or idempotency id before anything else. The client treats whatever plan you pass as authorized.

::checkpoint[Your validator rejects an expired or replayed directive and accepts a fresh one.]
:::
:::step{title="Gate the subscriptions" time="3 min"}
Quarantine the affected feature and remove or gate every subscription that could download the protected rows again. Purging while the old subscription is active is temporary, because the next sync may download the rows again.

::checkpoint[No active subscription covers the rows you are about to purge.]
:::
:::step{title="Call the client" time="3 min"}
Pass a `purgeId` and exact plaintext routing selectors:

```ts title="src/revocation.ts"
const result = await client.purgeLocalData({
  purgeId: directive.id,
  targets: [
    {
      table: 'patient_notes',
      selectors: {
        clinic_id: [directive.clinicId],
        encryption_key_id: [directive.keyVersionId],
      },
    },
  ],
});

// Counts only: no row ids or selector values leave the local engine.
console.log(result.alreadyApplied, result.purgedRows, result.droppedCommits);
```

Selectors inside one target combine with AND, and targets combine with OR. The example deletes `patient_notes` rows that match both the clinic and the key version. A selector names a plaintext string schema column and holds one or more exact, code-like values. No empty target, wildcard, expression, encrypted selector, or full-table mode exists.

Inputs are bounded: at most 64 targets, 8 selectors per target, and 128 values per selector. `purgeId` is a code-like id of 1 to 128 characters, and routing values are 1 to 256 characters. The client canonicalizes the plan, so selector order and duplicate values do not change its identity.

| Host | Call |
|---|---|
| Direct TypeScript client | `client.purgeLocalData(input)` |
| Browser worker and multi-tab handle | `await handle.purgeLocalData(input)` |
| React | `await useSyncClient().purgeLocalData(input)` |
| Tauri | `await client.purgeLocalData(input)` |
| React Native | `await client.purgeLocalData(input)` |
| Rust | `client.purge_local_data(&input)` |
| C FFI and the other native bindings | `purgeLocalData` through `syncular_client_command` |

The async bridges return the same counts-only shape. Direct TypeScript and Rust use their own naming conventions and apply the same validation and atomic behavior.

::checkpoint[The call returns counts, and a second call with the same id and plan returns `alreadyApplied: true` with zero new counts.]
:::
:::step{title="Clean up and acknowledge" time="3 min"}
Delete app-owned drafts and files, then remove the relevant keys from the OS secure store. For a revoked encryption key, remove the key only after the SQLite cleanup succeeds; otherwise the app may be unable to inspect or clean its remaining protected data ([Encryption keys](/concepts-encryption/#encryption-keys)). Acknowledge the directive only after every local stage succeeds.

::checkpoint[Your acknowledgement call succeeds, and the device no longer holds the rows, drafts, or key.]
:::
::::

## What the purge does

A failed purge preserves the captured sync round, so its response can still apply after the local transaction rolls back. A successful purge invalidates the old context. One local SQLite transaction:

- deletes matching visible and confirmed synced rows;
- lets generated [FTS5 maintenance](/tooling-local-search/) remove matching search documents;
- rejects each whole pending commit that touches a target with `client.local_data_purged`, so an atomic multi-row commit is never split;
- restores the last confirmed rows and replays safe later optimistic edits;
- removes cached blob bodies that no visible row or pending commit references;
- records the purge id and canonical plan durably;
- journals the dropped commit outcomes and emits one revisioned change batch.

Retrying the same id and plan returns `alreadyApplied: true` with zero new counts. Reusing an id with a different plan fails closed. A host retry after a crash or an ambiguous bridge response is therefore safe. The durable evidence that rejected pending work leaves is described on [Conflicts & optimistic writes](/concepts-conflicts/).

## Race-free security bootstrap

Use security preflight when the purge decision must happen before any protected data can be queried or synced:

```ts title="src/startup.ts"
const client = await createClient({
  ...config,
  securityPreflight: true,
});

// Validate and durably journal the signed directive in application code.
await client.purgeLocalData(directive.plan);
await client.activateSecurity({ encryption: acceptedKeyring });
```

Preflight permits lifecycle, status, and local-revision inspection plus the exact purge. Queries, mutations, subscription changes, outbox access, sync, realtime and presence, blobs, and automatic host-loop work fail with `client.security_preflight_required`. `securityPreflight` and `encryption` in one create config are mutually exclusive.

`beginSecurityPreflight()` provides the same barrier for a live revocation. It gates new work immediately and waits for already-started database, network, and native-sidecar work before it releases the old keyring. Activation cannot overtake that barrier.
