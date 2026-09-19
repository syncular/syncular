# Previous-version context

A schema bump wipes the local tables and re-bootstraps them from the server
([Schema upgrades](/concepts-schema-upgrades/), SPEC §7.4.3). While that
bootstrap is in flight the app can see a moment where its own rows are
gone. **Previous-version context** is an opt-in feature that keeps a
bounded, typed, read-only copy of the pre-bump rows so the app can answer
"what did this look like before the upgrade" until the replacement data
arrives.

It is **off by default**. Absent or `enabled: false`, a schema bump behaves
exactly as before, apart from two small bookkeeping writes that always run
(the schema descriptor and the container sweep). It is a feature flag, not
a security control.

The normative contract is SPEC §7.4.6.

## Turn it on

```ts
const client = await createClient({
  ...config,
  previousVersionContext: {
    enabled: true,
    // All optional; the defaults are shown.
    maxBytes: 8 * 1024 * 1024,
    maxRows: 20_000,
    maxTables: 32,
    maxRowBytes: 1024 * 1024,
    maxAgeMs: 24 * 60 * 60 * 1000,
  },
});
```

The capture happens during the reset, before the wipe. It is measured
against every bound **before** any row is materialized, and it is
all-or-nothing: if any bound is exceeded nothing is captured, no container
file is left behind, and the read surface reports
`reason: 'capture-exceeded-budget'` with the measured totals (counts only).

The capture is typed by the **schema descriptor** the client persists
beside its schema-version marker. Semantic types are never inferred from
SQLite column affinity — `boolean` and `integer` are both `INTEGER`, and
`string`, `json` and `blob_ref` are all `TEXT`, so affinity cannot recover
them. A database written by a build that predates this feature has no
descriptor: bumping straight from it refuses the capture with
`reason: 'no-previous-descriptor'`. One boot on the new build at the
unchanged schema version backfills the descriptor, and the next bump
captures.

## Read it

```ts
const snapshot = client.previousVersionSnapshot({
  table: 'tasks',
  rowIds: ['t1', 't2'], // optional
  limit: 50, // optional, default 50, max 200
});

if (snapshot.available) {
  // snapshot.state is always 'previousVersion'
  // snapshot.previousVersion, snapshot.rows, snapshot.truncated
} else {
  // snapshot.reason names why there is nothing to read
}
```

`state` is always `'previousVersion'`, and the cache never makes
`querySnapshot().coverage` complete. When nothing is available, `reason`
is one of `not-configured`, `no-previous-descriptor`,
`capture-exceeded-budget`, `coverage-complete`, `expired`,
`lease-inactive`, `scope-revoked`.

Two more surfaces:

- `previousVersionAudit()` — the pre-reset compatibility audit, written
  before the wipe. It classifies each pending outbox commit against the new
  schema and names the ones that cannot re-encode, with a typed reason
  (`unknown-table` / `unknown-column`) and the offending column. It carries
  no operations, row values or commit envelope, and it is advisory: it
  drops nothing. The §7.4.4 send-time drop is still the only path that
  removes a commit.
- `statusSnapshot().previousVersionContext` — `{ present, createdAtMs? }`,
  so an update or rollback path can require the discard below.

## When it is dropped

The cache is discarded — the file removed and both bookkeeping records
deleted — as soon as any of these is true:

- replacement coverage is complete (every active subscription has caught
  up);
- the auth lease stops or expires, or a scope is revoked;
- `purgeLocalData()` runs, unconditionally;
- the TTL (`maxAgeMs`, default 24h) passes, checked at boot and at read;
- the cache is orphaned or stale (missing metadata, or captured for a
  different schema version), discarded at boot;
- the app calls `previousVersionDiscard()`.

`previousVersionDiscard()` returns `{ present, discarded }` and is
idempotent: discarding nothing succeeds.

## Hosts

The cache lives in a **second database file** beside the replica, opened
through the host's sibling-database capability — a sibling file in the
replica's directory, not a table on the replica connection. The Bun, Node
and browser OPFS adapters and the Rust core (and the Tauri and React
Native bridges that use it) provide this. A host that does not resolves
the feature as `not-configured` rather than pretending to capture.

## Limitations

Read these before enabling the feature.

**The read guarantee is narrow.** The normal replica query connection does
not attach the cache file, so no SQL an unaware client runs on that
connection reaches it. That is all it is. It is **not** confidentiality
against same-origin storage access and **not** protection against native
filesystem access — anyone with the OPFS root or the file path can read
the file, and the filename is not a secret.

**There is no unaware purge path.** A code rollback to a build without
this feature leaves the cache file in place in both cases:

- a rollback that does not change the schema runs no reset at all, so the
  old build never touches the file, cannot purge it (its purge selector
  rejects a name that is not in its schema) and never opens it;
- a rollback that changes the schema runs its normal reset, but that reset
  drops replica tables only and cannot see a file it does not know about.

So the residue is **unbounded in time**: nothing removes it until a
feature-aware build discards it, or the host's own storage GC eventually
reclaims the directory — which is neither prompt nor promised. The TTL is
enforced by an aware build only, at boot and at read; it does **not** bound
this residue. Nothing here is confidentiality or secrecy, and no downgrade
is claimed to be safe.

**A straight bump from an older build captures nothing** until the
descriptor has been backfilled (see above).

## Rolling a build back

The supported procedure is executable, not a checkbox: before rolling a
build back, call `previousVersionDiscard()` and verify the returned
`{ present, discarded }`; a rollback path that cannot run it must call
`purgeLocalData()` instead. A build that enables the feature is expected
to wire this into its own update/rollback path, or to refuse the rollback
while `statusSnapshot().previousVersionContext.present` is true.

Replacing the binary by hand and skipping that step is unsupported, and it
must not be described as safe or bounded. For the removal primitive
itself, see [Authorized local purge](/concepts-local-data-purge/).
