# Schema upgrades

When your schema changes, you bump `schemaVersions` in the manifest and regenerate. The client has no migration engine (SPEC §7.4): it does not transform its local tables from one version to the next. On a version change it keeps the outbox, wipes its local tables, bootstraps again at the new version, and replays the outbox on top. This page is for developers who ship schema changes to installed clients; it explains what that reset does to local data and pending writes. Authoring the change (migrations, the lock, backfills) is [Schema & typegen](/guide-schema/).

::meta{for="App developers and server operators" time="10 minutes" first="concepts-bootstrap" spec="7.4"}

:::terms
- **Schema-version marker**: The schema version the client persists in its database.
- **Schema floor**: The server's `requiredSchemaVersion`: the oldest schema version it serves.
- **Reset**: Wipe local tables, bootstrap at the new version, replay the outbox.
- **`upgrading`**: The client state that is `true` from the reset until the first post-reset bootstrap round is idle.
- **Compatibility window**: The set of older schema versions a server still serves.
:::

:::figure{title="What a schema bump does to a client" note="Local, no server involvement" ticks}
<div class="d-row">
<div class="node"><span class="t">1 · Detect</span>Marker N, generated schema N+1</div>
<span class="d-arrow"></span>
<div class="node bad"><span class="t">2 · Wipe</span>Synced tables, indexes, FTS, cursors</div>
<span class="d-arrow"></span>
<div class="node cool"><span class="t">3 · Bootstrap</span>Subscribed data at version N+1, from segments</div>
<span class="d-arrow"></span>
<div class="node ok"><span class="t">4 · Replay</span>Outbox commits re-encode with the N+1 codec</div>
</div>
<div class="node hot"><span class="t">Kept through the reset</span>The outbox, the client identity (<code>clientId</code>), and the auth lease (<code>leaseState</code>)</div>

::caption[The `upgrading` state is `true` from step 2 until step 3 reaches idle. The server sees an ordinary fresh bootstrapper at the new version.]
:::

## What triggers the reset

Two triggers lead to the same reset.

| Trigger | What happens |
|---|---|
| Boot-time version increase | The client reads its schema-version marker on boot. When the generated schema is newer, the client runs the reset before its first sync round. No server involvement is needed. |
| Server schema floor | A running client whose generated schema is behind the server receives `requiredSchemaVersion` (SPEC §1.6) and stops, reporting `schemaFloor` and `stopped`. It does not reset on the floor alone, because resetting while still generating old payloads would hit the floor again. When the app updates to a new generated schema, the boot-time trigger fires. |

A schema floor pauses network transfer while local queries keep reading the retained replica, including newly opened queries. Reactive availability reports the schema stop alongside the query's local completeness. Applications can show an update notice and pause edits, because an incompatible outbox commit can be rejected during replay. Leadership and security gates still refuse local access when the owner or authorization is unavailable.

### The marker and the downgrade guard

Every replica open and recreation reads the persisted marker before it changes bookkeeping, local tables, or previous-version context. The marker guard and every write it authorizes run in one transaction, so a concurrent open that upgrades the replica refuses a stale attempt instead of recreating an older schema.

| Condition | Result |
|---|---|
| A build with schema 2 opens a schema 3 replica | `client.schema_downgrade` (non-retryable). The replica and queued writes stay intact; reopen them with a compatible build. TypeScript error details carry `persistedVersion` and `requestedVersion`, and native command errors expose the same static code. |
| The marker is unreadable or corrupt, or the metadata table holds more than one marker row | `sync.local_corrupt`. The client never picks a row. |
| A marker is missing while a schema descriptor is retained | `sync.local_corrupt` in both cores, before any write. The requested schema cannot establish which version last wrote those tables. |
| The generated schema version is outside 1 through 2147483647 | `sync.invalid_request`, before the replica is created or opened. |
| The metadata table or marker is absent and no schema descriptor is retained | Accepted, for a fresh or legacy replica. |
| Equal versions | Ordinary startup. |

Schema validation refusals leave the replica's journal mode and contents untouched. A failed schema or log-epoch reset rolls back its SQLite writes and restores the client's in-memory readiness, active round, subscriptions, outbox, and overlay state. Discarding previous-version context does not permit a schema downgrade.

## What the reset touches

The reset touches the whole local database except three things.

| Kept | Wiped and rebuilt |
|---|---|
| The outbox (schema-independent by design, §0 and §7.1) | Every synced table, secondary index, and FTS projection |
| The client identity (`clientId`) | Subscription cursors, resume tokens, effective-scope state |
| The auth lease (`leaseState`) | Incompatible registrations and their window bookkeeping |

A subscription registration survives a bump when its table and requested scope variables still exist and each variable keeps its pattern prefix and mapped column. The client drops incompatible registrations and their window and eviction bookkeeping before its first sync. The app registers its current subscriptions again, and the client never translates stored scope values. Changing `calendar:{theatre_calendar_id}` to `calendar:{calendar_theatre_id}`, for example, removes the registrations that use the old variable.

A compatible registration resets its cursor to `-1`, because the bump wipes the local rows and needs a fresh bootstrap. Reopening the same schema version keeps its cursor. A replica without stored scope declaration evidence needs re-registration at its next bump even when variable names match.

## Pending writes across the bump

The outbox replays on top of the fresh bootstrap. Entries are stored in schema-independent form and encoded at send time with the current codec (§0), so a commit written under version N pushes under N+1 by re-encoding. The server never accepts a retired encoding, and pending offline writes stay visible across the bump.

### Dropped columns and tables

Re-encoding fails when a pending commit references a column or table the new schema no longer has, because the value or operation has nowhere to go. The commit gets a rejection with the client-local code `sync.outbox_incompatible` (§7.4.4). The commit leaves the outbox and its purely optimistic rows are undone, as for a server rejection. Later commits that do encode keep replaying, so the queue moves past the one incompatible commit.

For a removed table, the local overlay has no mirror to replay into, so replay skips the operation. An upsert cannot be encoded and is classified at send time. A value-free delete stays encodable and the server validates it. A rejection of that delete drains the commit without a lookup in the removed local table.

The client classifies incompatible commits before it collects their pending blob uploads. A dropped commit no longer needs its cached bodies, while independent staging pins and surviving commit dependencies still need upload.

## What the app sees

`upgrading` is a small, queryable client state. Show an "upgrading…" affordance while it is `true`, and re-run live queries against the rebuilt tables when it ends. The worker transport emits it as an `upgrading` event on the event channel. Nothing about the flow crosses the wire.

Both client cores follow this flow, and the `schema-bump/*` conformance scenarios lock it: local-bump replay, floor-triggered convergence, dropped-column rejection, and image-lane re-bootstrap.

## What a bump costs

**Re-download volume.** The reset keeps each compatible subscription registration, including the per-unit subscriptions a [window](/concepts-windowing/) maintains, and clears only their sync state. The bootstrap covers the subscriptions and the currently windowed-in units and nothing more. A phone holding a 3-list window of a 500-list workspace downloads those 3 lists again. Data outside the window was never local.

**Apply cost.** On the wire, a bump costs one segment download of the subscribed data at the new version: the same bytes as a fresh install, with [segment compression](/concepts-bootstrap/) applied. Apply rates on the sqlite-image and rows lanes are on [Benchmarks](/benchmarks/). The server builds an image once per scope set and pin, so a fleet of clients that bump after a release deploy shares one build. For cellular-sensitive apps, size the window to the user's working set.

## Serving a compatibility window

The server keeps N-version codec support for transition windows if it chooses. Without a window it serves only its current version. A reference server accepts `schemaWindow` on `SyncServerConfig`: pass compiled schemas newest first, with `compileSchema(config.schema)` as the first entry.

Storage, authorization, validators, and the writer fence use the current schema. Old clients push with their own codec. Their pulls, conflict rows, segments, and realtime deltas contain only columns their codec knows. New nullable columns are null on old inserts and stay unchanged on old patches.

The window permits added tables and appended nullable columns. It rejects removed or renamed columns and changed codecs, primary keys, references, and scope patterns before serving. The host must also exclude older clients across semantic changes that these structural checks cannot detect. A client outside the window receives a floor naming its oldest version and the latest server version.

## Advanced: previous-version context

A bump wipes the local tables, so for a moment the app can see that its own rows are gone while the bootstrap runs. **Previous-version context** is an opt-in feature that keeps a bounded, typed, read-only copy of the pre-bump rows so the app can answer "what did this look like before the upgrade" until the replacement data arrives ([SPEC §7.4.6](https://github.com/syncular/syncular/blob/main/docs/SPEC.md)).

The feature is off by default. With it absent or `enabled: false`, a bump behaves as described above, apart from two small bookkeeping writes that always run: the schema descriptor and the container sweep. It is a feature flag and not a security control.

### Turn it on

```ts title="src/client.ts"
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

The capture happens during the reset, before the wipe. The client measures it against every bound before it materializes any row, and the capture is all-or-nothing. If any bound is exceeded, nothing is captured, no container file is left behind, and the read surface reports `reason: 'capture-exceeded-budget'` with the measured totals (counts only).

The **schema descriptor** the client persists beside its marker types the capture. The client never infers semantic types from SQLite column affinity: `boolean` and `integer` are both `INTEGER`, and `string`, `json`, and `blob_ref` are all `TEXT`. A replica with no stored descriptor refuses the capture with `reason: 'no-previous-descriptor'`. One boot on the new build at the unchanged schema version stores the descriptor, and the next bump captures.

The cache lives in a **second database file** beside the replica, opened through the host's sibling-database capability. It is a sibling file in the replica's directory and not a table on the replica connection. The Bun, Node, and browser OPFS adapters and the Rust core (with the Tauri and React Native bridges that use it) provide the capability. A host without it resolves the feature as `not-configured` and captures nothing. The pre-reset sweep discards an older capture before it creates the replacement, so a failed replica transaction does not restore the older capture. A read or boot discards a replacement whose recorded version differs from the active schema. The replica transaction still preserves its queued writes and local tables on failure.

### Read it

```ts title="src/upgrade.ts"
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

`state` is always `'previousVersion'`, and the cache never makes `querySnapshot().coverage` complete. When nothing is available, `reason` is one of `not-configured`, `no-previous-descriptor`, `capture-exceeded-budget`, `coverage-complete`, `expired`, `lease-inactive`, or `scope-revoked`.

Two more surfaces:

- `previousVersionAudit()` returns the pre-reset compatibility audit, written before the wipe. It classifies each pending outbox commit against the new schema and names the commits that cannot re-encode, with a typed reason (`unknown-table` or `unknown-column`) and the offending column. It carries no operations, row values, or commit envelope. It is advisory and drops nothing; the §7.4.4 send-time drop remains the only path that removes a commit.
- `statusSnapshot().previousVersionContext` returns `{ present, createdAtMs? }`, so an update or rollback path can require the discard below.

### When the cache is discarded

The client removes the file and deletes both bookkeeping records as soon as any of these holds:

- replacement coverage is complete: every active subscription has caught up;
- the auth lease stops or expires, or a scope is revoked;
- `purgeLocalData()` runs, unconditionally ([Authorized local purge](/concepts-local-data-purge/));
- the TTL (`maxAgeMs`, default 24 hours) passes, checked at boot and at read;
- the cache is orphaned or stale (missing metadata, or captured for a different schema version), discarded at boot;
- the app calls `previousVersionDiscard()`.

`previousVersionDiscard()` returns `{ present, discarded }` and is idempotent: discarding nothing succeeds. It is cleanup and not a read. An update path can run it while the replica is quiesced in security preflight (after the `beginSecurityPreflight()` barrier and before reactivation), where it never activates the client. `previousVersionSnapshot()` and `previousVersionAudit()` stay read-gated and are refused during preflight.

### Limits

:::warning{title="The read guarantee is narrow"}
The normal replica query connection does not attach the cache file, so no SQL an unaware client runs on that connection reaches it. That is the whole guarantee. It is not confidentiality against same-origin storage access and not protection against native filesystem access. Anyone with the OPFS root or the file path can read the file, and the filename is not a secret.
:::

A code rollback to a build without this feature leaves the cache file in place, and no unaware purge path exists. Two cases cover it:

- A rollback that does not change the schema runs no reset, so the old build never opens the file and cannot purge it. Its purge selector rejects a name that is not in its schema.
- A rollback to a binary without the downgrade guard runs a reset that drops replica tables only and cannot see a file it does not know.

The residue is therefore unbounded in time. Nothing removes it until a feature-aware build discards it or the host's own storage cleanup reclaims the directory, which is neither prompt nor promised. The TTL is enforced by an aware build only, at boot and at read, so it does not bound this residue.

### Rolling a build back

A client refuses to open a newer replica with an older schema through `client.schema_downgrade`, and discarding the cache does not bypass that guard. Keep a compatible build, or discard the replica through the host's storage lifecycle before you use an older schema.

Before a rollback, call `previousVersionDiscard()` and check the returned `{ present, discarded }`. A rollback path that cannot run it must call `purgeLocalData()` instead. A build that enables the feature wires this into its own update and rollback path, or refuses the rollback while `statusSnapshot().previousVersionContext.present` is `true`. Replacing the binary by hand and skipping the discard is unsupported.
