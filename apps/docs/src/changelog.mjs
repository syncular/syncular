/**
 * The changelog manifest: one entry per shipped feature, newest first.
 * Plain .mjs because it has two consumers: the changelog page
 * (src/pages/changelog.astro) and the node-run asset generator
 * (scripts/agent-assets.mjs), which emits /changelog.md from it.
 *
 * @typedef {{ readonly href: string; readonly label: string }} ChangelogLink
 * @typedef {{
 *   readonly date: string;
 *   readonly title: string;
 *   readonly body: string;
 *   readonly links: readonly ChangelogLink[];
 * }} ChangelogEntry
 */

/** @type {readonly ChangelogEntry[]} */
export const changelog = [
  {
    date: '2026-09-26',
    title: 'Query identity changes before the first read keep the snapshot',
    body: "A live query that has no successful read now publishes a shared, frozen snapshot per phase and availability. When a query's parameters or coverage change before its first read completes, the new query returns the same snapshot object and `rows` array, and React does not re-render for the switch.",
    links: [
      {
        href: '/platform-react/#changes-windows-and-other-hooks',
        label: 'React hooks',
      },
    ],
  },
  {
    date: '2026-09-26',
    title: 'Unchanged live results no longer re-render React',
    body: 'A live query that reads an empty result again now keeps its previous `rows` array and does not notify subscribers. `useSyncStatus`, `useConflicts`, and `useCommitOutcomes` compare each new snapshot by value and skip the notification when it is equal, so a sync batch with an unchanged status no longer re-renders every status subscriber. Row reconciliation compares mapped `Date` values by time and class instances by identity.',
    links: [
      {
        href: '/platform-react/#changes-windows-and-other-hooks',
        label: 'React hooks',
      },
    ],
  },
  {
    date: '2026-09-25',
    title: 'Local unique constraint failures roll back the commit',
    body: 'TypeScript and Rust clients now fail a local commit with `sync.constraint_violation` when its optimistic writes conflict with a declared secondary unique index. The client rolls back every sibling write and the outbox append in the same SQLite transaction, and the local revision does not advance. Rust previously ignored the failed overlay write and queued a commit whose optimistic row was absent.',
    links: [
      {
        href: '/concepts-commits/#local-constraint-failures',
        label: 'Commits, cursors & idempotency',
      },
    ],
  },
  {
    date: '2026-09-25',
    title: 'Failed local query reads expose bounded diagnostics',
    body: 'Generated TypeScript and Rust queries now identify their snapshot reads with a stable query id and generated table dependencies. A failed owned read adds a privacy-safe `queryFailures` entry to client diagnostics until the query reads successfully. The list retains 256 entries and contains no SQL, parameters, rows, paths, or driver prose. SQLite corruption and I/O failures raise the stable non-retryable codes `client.storage_corrupt` and `client.storage_io`; other read failures keep their existing application error and use `client.query_failed` only in diagnostics. React live queries now enter `error` after a failed refresh while retaining the last successful rows and revision.',
    links: [
      {
        href: '/platform-react/#generated-live-queries',
        label: 'React live queries',
      },
      {
        href: '/platform-rust/#generated-queries',
        label: 'Rust generated queries',
      },
    ],
  },
  {
    date: '2026-09-25',
    title: 'A sync query can join a table to itself',
    body: '`syncular generate` now accepts a `sync query` that reads one table through several aliases when every alias binds the same declared scopes with the same operator and parameters, for example two `catalogue_codes` instances each constrained by `catalogue_set_id = :catalogueSetId`. Identical proofs select the same window base and units, so the descriptor holds one coverage entry and one dependency for that table, and the TypeScript and Rust clients report the query ready when that one window completes. An unconstrained alias, or aliases that differ in a parameter, operator, unit dimension, or fixed scope, still fail with `SYQL6005_INVALID_SYNC_QUERY`. An ordinary `query` over a self-join with identical proofs now gets an exact dependency in place of table-wide invalidation. A self-join has no inferred row identity.',
    links: [
      {
        href: '/syql/#query-and-sync-query',
        label: 'SYQL: query and sync query',
      },
    ],
  },
  {
    date: '2026-09-25',
    title: 'Push hooks run generated authority reads on the push transaction',
    body: "Row validators, the whole-commit validator, the reaction planner, and remote command callbacks run inside the push transaction, and each now receives a transaction-bound `queryAuthoritative` (`context.queryAuthoritative`, or `read.queryAuthoritative` on the candidate-state reader). It takes the request `storage.queryAuthoritative` takes, built from a generated query descriptor; the storage binds every relation to the commit's partition and runs the statement on the push transaction's connection. On SQLite and PostgreSQL the read returns the rows staged earlier in the commit, and a push completes on a one-connection pool. Calling `storage.queryAuthoritative` from these hooks still waits forever on SQLite and PGlite and reads committed state on a pool. D1 refuses a read over a table the commit has already written with `sync.storage.query_over_staged_writes`, and a custom storage transaction without the capability fails with `sync.storage.transaction_query_unsupported`.",
    links: [
      {
        href: '/guide-remote-operations/#read-a-generated-query-inside-a-push-transaction',
        label: 'Read a generated query inside a push transaction',
      },
    ],
  },
  {
    date: '2026-09-25',
    title:
      'Same-version readiness checks storage-internal columns on every backend',
    body: 'At a matching schema version, `ensureSchema` on SQLite, PostgreSQL, and D1 now checks each synced table against the storage layout: a missing table or column, a `_sync_*` column whose type or nullability differs from what the storage creates, or a primary key other than `(_sync_partition, _sync_row_id)` refuses the open with `StorageQueryError` code `sync.storage.physical_layout_mismatch`. The stored-layout comparison now fails with `sync.storage.stored_layout_mismatch`. Both carry the table and column in `details` and keep them out of the message. D1 previously trusted a matching version marker without either check, so a replica whose internal columns drifted answered healthy and failed at the first write. D1 also refuses a same-version database missing a core table its request path reads or writes, such as `sync_tombstones`, with `reason: missing_table`, because D1 creates those tables only in `migrate()` or during a schema upgrade. On D1 the check reads `sqlite_master` once plus one `PRAGMA table_info` per synced table the first time a storage instance opens.',
    links: [
      {
        href: '/server-storage/#materialized-app-tables',
        label: 'Storage backends',
      },
      { href: '/guide-schema/', label: 'Schema & typegen' },
    ],
  },
  {
    date: '2026-09-19',
    title: 'The server refuses to serve until a declared backfill is activated',
    body: 'A schema change that needs a backfill can now be declared so the storage refuses requests until it is activated. SQLite and PostgreSQL expose a serve gate that answers `sync.schema_not_ready` (retryable, HTTP 503) while a declared checkpoint for the running schema version is incomplete, or when the stored schema version is newer than the running build. D1 keeps its existing host readiness failure and the client recovery protocol does not change. On PostgreSQL the migration transaction takes an exclusive lock on `sync_partitions` as its first statement, so an old binary blocks at its first statement without its cooperation, and a `BEFORE INSERT` trigger on `sync_commits` rejects an append below the required writer version for the partition. Custom storage adapters must implement the new `Storage` members named in the release notes.',
    links: [
      { href: '/server-storage/', label: 'Storage backends' },
      { href: '/concepts-schema-upgrades/', label: 'Schema upgrades' },
    ],
  },
  {
    date: '2026-09-19',
    title: 'Optional protected values are documented as an encrypted sidecar',
    body: 'When a row mixes shared operational columns with an optional non-NULL protected value, the supported shape is a plaintext primary table beside a sidecar table that carries the protected value with its own scope and subscription, keyed by the primary row id. The sidecar resolves its key through the normal selection order, and a client without that key must not subscribe to it: decrypt-on-apply runs at the whole-row boundary, so an undecryptable sidecar row aborts the remainder of the sync round and starves unrelated frames. A presence signal for a no-key client belongs on the plaintext primary, and there is no generate-time diagnostic for an encrypted column that shares a row with plaintext columns. Two conformance scenarios pin the no-key primary read and the fail-closed subscription case.',
    links: [{ href: '/concepts-encryption/', label: 'Encryption' }],
  },
  {
    date: '2026-09-19',
    title: 'An opt-in cache of the rows a schema bump wipes',
    body: 'A schema bump wipes the local replica before the replacement bootstrap restores anything, so an app can briefly see none of its own rows. `previousVersionContext` is a new opt-in, default-off feature that keeps a bounded, typed, read-only copy of the pre-bump rows in a second database file beside the replica, and exposes `previousVersionSnapshot`, `previousVersionAudit` and `previousVersionDiscard`, with `statusSnapshot().previousVersionContext` reporting presence. The capture is measured before any row is materialized and is all-or-nothing; its semantic types come from a persisted schema descriptor, never from SQLite affinity. The guarantee is narrow: the normal replica query connection does not attach the file, which is not confidentiality against same-origin or filesystem access. An unaware rollback leaves the file in place, the aware-only TTL does not bound that residue, and the supported downgrade procedure calls `previousVersionDiscard()` first.',
    links: [
      {
        href: '/concepts-previous-version-context/',
        label: 'Previous-version context',
      },
      { href: '/concepts-schema-upgrades/', label: 'Schema upgrades' },
    ],
  },
  {
    date: '2026-09-19',
    title: 'Version-only schema bumps are documented and fail closed',
    body: 'A Syncular release can change only engine-internal storage, with no application column change, and the application schema version still has to advance because that version is what makes the server apply the storage change. The schema guide now gives the verbatim procedure — append an empty `up.sql`, point `schemaVersions` at it, regenerate, and confirm the bump landed by reading `sync_schema_meta.schema_version` — and states that a marker at the new version whose synced tables are missing an internal column now fails closed at startup rather than at the first write.',
    links: [{ href: '/guide-schema/', label: 'Schema & typegen' }],
  },
  {
    date: '2026-09-19',
    title: 'Generated query aliases keep their case on PostgreSQL',
    body: 'Projection lowering emits every result alias double-quoted. An unquoted alias keeps its case on SQLite and folds to lower case on PostgreSQL, so a generated query selecting `membership_id` reached a PostgreSQL authority as `membershipid` and every read of the camelCase field returned undefined while the same query passed on SQLite. A cross-backend test runs one generated plan through `queryAuthoritative` on PGlite and SQLite and asserts the result keys agree.',
    links: [{ href: '/tooling-queries/', label: 'Queries' }],
  },
  {
    date: '2026-09-19',
    title: 'Server storage refuses a same-version layout mismatch',
    body: 'The SQLite and PostgreSQL storages compare the stored column layouts with the configured schema when the version marker matches, and refuse to serve a database whose layouts disagree, naming the table and column. Version equality was previously taken as layout equality, so a database written by another build at the same version reached serving startup and failed later at a write. At the same version both storages also read the physical tables and refuse a synced table that is missing a storage-internal column, which is the shape a version-only bump whose storage change never applied leaves behind; that check proves the columns exist, and stored types, nullability, and non-column storage internals stay outside it. Two further storage changes ship with it: `sync_row_scopes` gains a `(partition, tbl, row_id)` index, because the per-row scope replacement predicate could not narrow the inverted primary key on PostgreSQL; and one pinned PostgreSQL transaction client serializes its statements, so a commit validator issuing independent reads with `Promise.all` no longer overlaps queries on one connection.',
    links: [{ href: '/server-storage/', label: 'Storage backends' }],
  },
  {
    date: '2026-09-19',
    title: 'A segment records every publication of its content address',
    body: "Two scopes whose rows are byte-identical produce one content address, so the store keeps one entry. It now retains every publication of that entry with the full context (partition, log epoch, table, schema version, media type, scope digest, pin, page cursors) and each publication's own TTL. Download, a signed-URL token, and the §5.3 reuse lookup select the publication matching the caller's partition, live log epoch, and freshly computed digest. A digest recorded under a different partition, epoch, table, or pin never authorizes, and one publication's refresh never extends another's expiry. Byte-identical content published from two partitions is one entry that both partitions can download; a descriptor minted under a rotated epoch is denied. The SEGMENT_REF frame still reports the digest the caller holds. The S3 store keeps the mutable record in its own object, so the merge is conditional on the record body and a concurrent publication cannot drop another publication; the bytes object stays immutable and content-addressed. Custom SegmentStore implementations must return `publications`; a store reading a pre-0.22 record materializes one publication per recorded digest under the stored context, so an in-flight object keeps working. Segment bytes, the content address, and the wire frames are unchanged.",
    links: [{ href: '/concepts-bootstrap/', label: 'Bootstrap' }],
  },
  {
    date: '2026-09-19',
    title: 'Realtime hosts can drain acknowledgements and refresh grants',
    body: '`RealtimeSession.drain()` resolves when the queued acknowledgement-cursor writes have settled and throws a persistence failure instead of dropping it, so a host can await its control-plane storage work before closing storage or ending a hibernatable Worker event. `RealtimeHub.refreshScopes(partition, actorId?)` re-resolves matching sessions through the original resolver and empties a session it cannot resolve: commit fanout filters through the registrations resolved at connect and at round end, so an idle connected recipient kept revoked grants until its next round. Hosts call it after changing a membership or connection.',
    links: [{ href: '/concepts-realtime/', label: 'Realtime' }],
  },
  {
    date: '2026-09-19',
    title: 'patch accepts a scope column equal to the stored row',
    body: 'Both cores drop a present scope column from a patch when its value equals the stored local row, matching the server, which applies a value-equal scope column as a no-op and rejects only a differing value. A patch that round-tripped a decoded envelope previously failed on the client although the server would have accepted the commit. A differing value, and a row with nothing local to compare against, still fail closed. A primary key that is also a scope column needs no comparison: the key in a sparse payload is the row id being patched. Composed reactive queries also keep their coverage: several coverage entries on one window base claim the union of their units, and every dependency on a changed table is consulted.',
    links: [{ href: '/concepts-scopes/', label: 'Scopes' }],
  },
  {
    date: '2026-09-18',
    title: 'Primary keys must have one string form',
    body: 'A primary key must be TEXT, INTEGER, BOOLEAN, or JSON. Syncular addresses a row by a string form of its primary key, and a REAL key has no single form: the shortest round-trip decimal differs between the TypeScript and Rust renderers, and a local lookup resolves the row id through the text rules of the SQLite build inside each core, so one row id could reach different rows per core. REAL, FLOAT, and DOUBLE keys are rejected by typegen, the server, and both client cores, alongside BLOB, crdt, and blob_ref keys, with an error naming the table and column.',
    links: [{ href: '/guide-schema/', label: 'Schema & typegen' }],
  },
  {
    date: '2026-09-17',
    title: 'Sparse-patch key resolution without sync abort',
    body: 'A sparse patch that omits the key-id column resolves the key from the stored local row: present columns first, then the stored row for absent slots only, never for a present NULL. A patch with no encrypted column needs no key. An unresolvable key records one durable client.encrypt_failed rejection instead of aborting sync(), identically in both cores; the code is client-local and never on the wire. The conformance catalog pins keyless, present-NULL, fallback, and ghost-row cases on both cores.',
    links: [
      { href: '/concepts-encryption-keys/', label: 'Encryption keys' },
      { href: '/troubleshooting/', label: 'Troubleshooting' },
    ],
  },
  {
    date: '2026-09-16',
    title: 'Column-granular writes and delete precedence',
    body: 'A push payload is a sparse row: a presence bitmap names the columns the operation writes, and the server tracks a column_version per column. Two edits to disjoint columns both apply, with or without baseVersion; a conflict reports conflictColumns naming the contended columns. A delete records a tombstone that beats a concurrent unversioned upsert until the pruning horizon, and an explicit insert recreates the row. changedFields is removed because the values map is the presence set. Wire version 3.',
    links: [
      { href: '/concepts-conflicts/', label: 'Column-granular conflicts' },
      {
        href: '/guide-concurrency-correction/',
        label: 'Concurrency and correction',
      },
    ],
  },
  {
    date: '2026-09-16',
    title: 'Declared references',
    body: 'A migration column may declare REFERENCES parent(pk) with ON DELETE RESTRICT, CASCADE, or SET NULL. typegen validates the subset, records the reference in the schema IR, and emits the child index. The server enforces the reference once per commit over candidate state, appends CASCADE deletes and SET NULL updates to the same commit, and rejects a violation with sync.reference_violation and structured recovery details. The local replica DDL omits the clause.',
    links: [
      {
        href: '/guide-schema/#declared-references',
        label: 'Declared references',
      },
      {
        href: '/concepts-conflicts/#declared-reference-outcomes',
        label: 'Reference outcomes',
      },
    ],
  },
  {
    date: '2026-09-13',
    title: 'Cached reads during sync and cooperative imports',
    body: 'Reactive queries read cached snapshots while window registration runs, and additional owners reuse acknowledged windows immediately. Both cores commit SQLite images in chunks of at most 1,024 rows and yield between import and eviction chunks automatically. Interrupted cleanup resumes from durable state. Rust image imports reconcile pending writes under unique constraints without rebuilding the full replica per chunk. Managed FTS projections delete through an indexed identity mapping. Coverage and registration errors remain observable throughout.',
    links: [
      { href: '/concepts-windowing/', label: 'Window ownership and eviction' },
      { href: '/concepts-bootstrap/', label: 'Import chunks and recovery' },
      { href: '/tooling-local-search/', label: 'Search index maintenance' },
    ],
  },
  {
    date: '2026-09-12',
    title: 'Live download and import progress',
    body: 'Both client cores expose live sync progress with per-attempt identities, byte and row counters, and terminal failures. Worker, Tauri, and FFI events deliver updates while sync is running. JavaScript clients provide onProgress and progressSnapshot; React adds useSyncProgress(client), and Rust provides a cloneable observer with subscription guards. SQLite image imports retain their atomic transaction.',
    links: [
      {
        href: '/platform-web/#live-sync-progress',
        label: 'JavaScript progress',
      },
      { href: '/platform-rust/#live-sync-progress', label: 'Rust progress' },
    ],
  },
  {
    date: '2026-09-12',
    title: 'Browser SQLite crash recovery',
    body: 'The persistent browser client corrects the OPFS SAH-pool reserved-lock callback before the first SQL statement, allowing SQLite to roll back interrupted writes on reopen. Bounded startup retries handle transient storage_busy errors while retaining leadership. Seven Chromium cases verify crash recovery within the same browser session, database and FTS integrity, checkpoint recovery, and contention without losing pending writes.',
    links: [
      {
        href: '/platform-web/#interrupted-writes',
        label: 'Browser crash recovery',
      },
    ],
  },
  {
    date: '2026-09-11',
    title: 'Syncular 0.19.0',
    body: 'The TS and Rust clients write blob dependencies directly with the outbox and keep mutable upload state outside immutable blob rows. They remove stored refcounts, SQLite triggers, startup dependency backfill, cache-hit metadata writes, and reconciliation passes. Two independent paired 500 MB collections reduced upload time by 21.1% and 24.9% in TS and by 9.0% and 6.8% in Rust. Clients reject the 0.18 local blob-table layout and require a fresh local database after upgrading.',
    links: [
      { href: '/concepts-blobs/', label: 'Blob lifecycle' },
      { href: '/benchmarks/', label: 'Benchmark evidence' },
    ],
  },
  {
    date: '2026-09-11',
    title: 'Simplified SQLite blob state',
    body: 'The TS and Rust clients write commit dependencies directly with the outbox and keep mutable upload state outside immutable blob rows. They no longer maintain stored refcounts, blob triggers, startup backfill, or cache-hit metadata. Two independent paired 500 MB collections reduced upload time by 21.1% and 24.9% in TS and by 9.0% and 6.8% in Rust. Older local blob-table layouts fail with sync.schema_mismatch and require a fresh local database.',
    links: [
      { href: '/concepts-blobs/', label: 'Blob lifecycle' },
      { href: '/benchmarks/', label: 'Benchmark protocol' },
    ],
  },
  {
    date: '2026-09-11',
    title: 'Syncular 0.18.0',
    body: 'Blob staging and upload recovery now preserve pending work across storage and transfer failures in both client cores. Fresh downloads reconcile only the downloaded body before cache-cap enforcement; two independent paired collections at 100,000 references reduced 64 KiB download time by 61.6% in TypeScript and 60.1% in Rust. The direct Rust client exposes fetch_blob_bytes as its single blob fetch method. The SSP2 wire protocol and native JSON command remain unchanged.',
    links: [
      { href: '/concepts-blobs/', label: 'Blob lifecycle' },
      { href: '/platform-rust/', label: 'Rust blob API' },
      { href: '/benchmarks/', label: 'Benchmark evidence' },
    ],
  },
  {
    date: '2026-09-11',
    title: 'Targeted blob download reconciliation',
    body: 'After a cache miss, both client cores ask SQLite to count visible references for the downloaded body and update only that cache row before enforcing the size cap. Full reconciliation remains on row changes, purge, revocation, replay, and rebootstrap. Two independent paired collections at 100,000 references reduced 64 KiB fresh-download time by 61.6% in TypeScript and 60.1% in Rust.',
    links: [
      { href: '/concepts-blobs/', label: 'Blob cache behavior' },
      { href: '/benchmarks/', label: 'Blob benchmark controls' },
    ],
  },
  {
    date: '2026-09-11',
    title: 'Owned blob bytes for Rust hosts',
    body: 'Rust hosts call fetch_blob_bytes to receive an owned Vec<u8> after authorization, hash verification, cache insertion, reference retention, and cache-cap work. This is the Rust client’s single blob fetch method. The shared command router encodes bytes only at the JSON boundary used by the C ABI and native bindings.',
    links: [{ href: '/platform-rust/', label: 'Rust blob API' }],
  },
  {
    date: '2026-09-11',
    title: 'Durable blob upload recovery',
    body: 'Both client cores commit a staged body and its upload pin atomically. TypeScript snapshots the exact supplied byte view at call time, so later caller mutation cannot change the staged body or content address. Queued uploads validate their stored length and SHA-256 before transfer, and local storage failures retain the original outbox commit for retry. A durable commit-to-blob index keeps successfully uploaded bodies pinned until every referencing commit reaches a terminal outcome, including after restart, lost acknowledgements, rejection, and scope revocation.',
    links: [{ href: '/concepts-blobs/', label: 'Blob upload lifecycle' }],
  },
  {
    date: '2026-09-08',
    title: 'Syncular 0.17.0',
    body: 'Offline replay performs less repeated storage and pending-row work in both cores. Native transport and blob paths reduce allocation and copying. Repository benchmarks now measure replay, recovery, delivery, reads, and native boundaries. This release also includes resumable D1 migrations, pruning-race resets, and partition-scoped server indexes. Custom storage adapters must implement both cursor-update contracts; existing servers must bump their application schema version and regenerate to rebuild declared indexes.',
    links: [
      { href: '/benchmarks/', label: 'Engine performance and benchmarks' },
      { href: '/server-storage/', label: 'Storage migration guidance' },
    ],
  },
  {
    date: '2026-09-08',
    title: 'TS benchmark sampling profiles',
    body: 'TS socket replay and observation workloads can capture opt-in Bun sampling profiles for each isolated client. Artifacts retain compressed raw call stacks alongside SQL and transport measurements. Explicit start/stop intervals exclude setup and final validation, and profile formatting and compression run outside delivery timers. Public client APIs remain unchanged.',
    links: [{ href: '/benchmarks/', label: 'Sampling profiles' }],
  },
  {
    date: '2026-09-08',
    title: 'Benchmark database metadata for every client',
    body: 'Repository replay, restart, observation, blob, purge and read artifacts record SQLite version and durability for every client, including reopened processes. Server metadata records SQLite configuration or Postgres version and allowlisted durability settings. Metadata queries run outside operation timers, and legacy artifact fields retain their formats.',
    links: [{ href: '/benchmarks/', label: 'Database metadata' }],
  },
  {
    date: '2026-09-08',
    title: 'Native row-ID lookups use existing primary keys',
    body: 'Rust scope lookups, row deletes, and CRDT row reads reuse prepared statements and seek existing primary-key indexes for string, JSON, integer, and boolean keys. Exact text matching remains unchanged, including the text predicate for floating-point keys whose string conversion can round distinct values.',
    links: [{ href: '/benchmarks/', label: 'Native lookup behavior' }],
  },
  {
    date: '2026-09-08',
    title: 'Private native phase diagnostics',
    body: 'Repository socket benchmarks can collect opt-in Rust wall-time and calling-thread CPU phases for replay, observation, and blob download/cache work. Artifacts retain per-client intervals, failed calls, and attempted pending-operation counts. The recorder is absent from normal builds and public diagnostics. SQL counters also cover replay, restart, and commit-boundary workloads.',
    links: [{ href: '/benchmarks/', label: 'Phase boundaries and overhead' }],
  },
  {
    date: '2026-09-08',
    title: 'Incremental native pending-row reconciliation',
    body: 'Incoming Rust commit frames reconcile changed rows and their pending operations when the affected tables have no secondary unique constraints. Other pending rows keep their optimistic values without a full overlay rebuild. Tables with secondary unique constraints retain complete FIFO replay, and every frame keeps its durable revision and rollback boundary.',
    links: [{ href: '/benchmarks/', label: 'Native replay measurements' }],
  },
  {
    date: '2026-09-08',
    title: 'Native incoming transaction boundaries',
    body: 'The Rust client now commits each incoming COMMIT frame and rows-segment block independently, matching the TypeScript client. A later failed frame preserves earlier rows and revisions while leaving the subscription cursor unchanged for retry. Pull and realtime delivery share the same frame transaction, and failed cursor persistence restores the previous subscription state.',
    links: [
      { href: '/benchmarks/', label: 'Transaction parity and measurements' },
    ],
  },
  {
    date: '2026-09-08',
    title: 'Comparable socket observation processes',
    body: 'Fanout and reconnect benchmarks run every TS and Rust client in its own process through one runner. Artifacts record client identity, resources, SQLite durability, and explicit reconnect sync timing. Opt-in Rust SQL counters distinguish statements and commit hooks. Independent fixture and durable outcome checks cover both cores.',
    links: [{ href: '/benchmarks/', label: 'Observation benchmarks' }],
  },
  {
    date: '2026-09-08',
    title: 'Rust engine replay benchmarks',
    body: 'Repository benchmarks can run Rust clients and the real server in one process through a private transport. Replay retains independent readers, durable SQLite, and FIFO commit checks, with direct and shared-command timings. Artifacts distinguish callback work and shared process resources from shipping socket and FFI measurements.',
    links: [{ href: '/benchmarks/', label: 'Performance workloads' }],
  },
  {
    date: '2026-09-08',
    title: 'Atomic realtime cursor persistence',
    body: 'Realtime acknowledgements update the client cursor and activity timestamp in one storage statement, preserving concurrent subscription registration. The update requires the session actor and current partition log epoch and cannot recreate a deleted client record. Custom storage adapters must implement advanceClientCursor.',
    links: [{ href: '/server-storage/', label: 'Storage adapter contract' }],
  },
  {
    date: '2026-09-08',
    title: 'Batched acknowledgements with durable failure recovery',
    body: 'Both client cores persist consecutive successful acknowledgements in one local transaction and publish one revisioned change batch with its final outbox count. Rejections retain their own transaction boundary. Both client cores report client.outcome_persistence_failed when a final outcome cannot commit locally. Failed acknowledgements preserve pending IDs and optimistic state without publishing an uncommitted conflict or rejection. Rust restores its in-memory outbox after a failed revision or commit write. TypeScript conflict callbacks run after local durability, so callback exceptions cannot undo the outcome.',
    links: [
      {
        href: '/concepts-conflicts/',
        label: 'Local outcome persistence failures',
      },
    ],
  },
  {
    date: '2026-09-08',
    title: 'Persistent SQLite performance and diagnostic benchmarks',
    body: 'Bun and Node clients use WAL with FULL durability for persistent SQLite databases. Late callbacks from disconnected realtime connections cannot mutate a replacement or closed client. The repository benchmark runner adds replay, fanout, reconnect, and Rust byte-envelope diagnostics with raw artifacts and isolated Postgres schemas. Postgres diagnostics attribute SQL shapes and awaited local realtime notifications. An explicit WAL I/O profile records whole-attempt PostgreSQL 18 counters and durability settings without resetting statistics or changing configuration. Async benchmark measurements also record pending calls, peak overlap, and starts that overlap an earlier call. A macOS Swift profile measures the shipped query and querySnapshot methods through Foundation and the release FFI, verifying loaded-library provenance. Fixed-schema TS and Rust read workloads compare database, query, and snapshot costs at 1k, 10k, and 100k rows; Rust also measures the shared command router and traces statement counts outside timing. Rust replicas with no pending writes update changed visible rows within the existing transaction. Local Rust appends apply only the new commit to a current overlay; failed outbox or revision writes roll back the durable queue and in-memory state. Native realtime I/O uses socket readiness instead of timed reads sharing a send lock. Native replay, reconnect, fanout, and process-restart diagnostics separate core and command timing. TS and Rust restart workloads share SIGKILL, preserved-identity, FIFO acknowledgement, and independent-reader checks. Mixed-commit workloads verify 499/2/1 and 500/2/1 request boundaries, atomic middle-commit rejection, and later independent writes. TS and Rust blob lifecycle diagnostics measure staging, upload, download, interrupted recovery, and cache hits. TS records per-phase SQL and transport attribution; Rust separates native operations from stdio delivery, parsing, and byte decoding. Native FFI and Tauri diagnostic observers compare typed snapshots before serializing changed evidence, retaining fresh storage observations and capture times. Rust diagnostic storage aggregates reuse compiled SQLite statements while reading current values on every call. C ABI blob and fixed-schema read diagnostics separately measure the exported call, host response copying, deallocation, and JSON parsing. TS and Rust socket replay share isolated writer/reader processes and all-round acknowledgement validation. TS process replay records returned-row counts, SQL shapes, and actual SQLite transaction-control calls. Process-backed workloads retain per-client lifetime CPU and peak memory, including both writers in restart cases. The native command and C ABI envelopes move owned blob results and borrow input parameters, removing payload-sized JSON copies without changing the command format. Native query and snapshot commands also borrow bind parameters and move owned rows into their replies, preserving typed cells and snapshot coverage metadata. Permission-purge diagnostics revoke one project while retaining another, then verify the purge after persistent process reopen in TS and Rust. Both cores refresh downloaded-body reference counts before trimming; Rust counts visible optimistic references. The Rust byte encoder and decoder avoid per-byte formatting and radix parsing while retaining the hexadecimal command format and decoder input/error behavior. Postgres pushes avoid repeating partition initialization after the partition exists. Sequence allocation and commit metadata insertion share one Postgres statement. Each change and its inverted scope entries also share one statement, with consistent JSONB parameter typing. SQLite and D1 server row writes remove exact old scope entries through existing primary keys.',
    links: [
      {
        href: '/benchmarks/',
        label: 'Benchmark workloads and storage behavior',
      },
      { href: '/server-storage/', label: 'Postgres partition locking' },
    ],
  },
  {
    date: '2026-09-05',
    title: 'D1 schema upgrades resume across requests',
    body: 'D1ServerStorage.migrateSchema limits statements per invocation and saves row-rewrite progress. Interrupted upgrades resume with the same schema, and competing requests cannot apply the same batch twice. The storage rejects row reads and transaction commits until migration finishes. Run migration requests before admitting sync traffic; ensureSchema reports when another invocation is needed.',
    links: [
      {
        href: '/server-workers/#schema-migration',
        label: 'D1 migration setup',
      },
    ],
  },
  {
    date: '2026-09-05',
    title: 'Concurrent pull recovery and partition-scoped server indexes',
    body: 'Pulls reset before emitting an active section when pruning crosses their commit-window read. Realtime notifications that break sequence trigger catch-up, and acknowledgment persistence preserves concurrent subscription updates. Declared server indexes include the partition column; existing databases require an application schema-version bump to rebuild them. Table retirement removes stale blob references. Includes focused contributions from Chase Pursley in PR #47.',
    links: [
      {
        href: '/server-storage/#concurrent-pulls-and-storage-upgrades',
        label: 'Storage upgrade instructions',
      },
    ],
  },
  {
    date: '2026-09-05',
    title: 'Generated Rust decoder compatibility',
    body: 'Typegen emits byte decoders that pass Rust 1.98 Clippy while retaining strict envelope validation. Regenerate Rust query modules with typegen 0.16.1 to receive the updated helper.',
    links: [{ href: '/tooling-queries/', label: 'Generated queries' }],
  },
  {
    date: '2026-09-05',
    title: 'Canonical client snapshots and bounded sync work',
    body: 'React mutation callbacks now use onEnqueued for durable local acceptance. Client state reads use statusSnapshot across direct, worker, and native hosts; getter normalization and individual state commands are removed. Outbox status reads avoid decoding pending bodies, request encoding reads bounded pages, and concurrent SQLite bootstrap misses share one batched image build. Custom image builders must accept rowBatches and return a promise.',
    links: [
      { href: '/platform-react/', label: 'Mutation callback migration' },
      {
        href: '/platform-web/#snapshot-api-migration',
        label: 'Client snapshot migration',
      },
      { href: '/server-storage/', label: 'Image builder migration' },
    ],
  },
  {
    date: '2026-09-05',
    title: 'Query isolation, FIFO batching, and observation ordering',
    body: 'Generated relation plans bind every registered query table occurrence to its authenticated partition. Existing query modules require regeneration. Outbox request batches preserve commit creation order when the next commit exceeds the remaining operation budget, including retries and restarts. Unexpected validator and CRDT failures expose static public messages. Presence and shared status, conflict, and outcome observations discard stale asynchronous results. Commit-log pruning atomically advances the horizon and deletes history with restore-epoch fencing; custom storage adapters require the updated pruning contract and active-cursor aggregate. Inactive reactive observations release their cached rows after a microtask and leave change dispatch immediately.',
    links: [
      { href: '/guide-remote-operations/', label: 'Remote query regeneration' },
      { href: '/concepts-conflicts/', label: 'Outbox ordering' },
      { href: '/server-storage/', label: 'Storage adapter migration' },
    ],
  },
  {
    date: '2026-09-05',
    title: 'Existing-project schema setup',
    body: 'The schema guide documents installing typegen, initializing schema inputs, and generating the client schema inside an existing app. The Tauri guide starts with a framework-independent client and introduces React bindings as an optional step.',
    links: [
      {
        href: '/guide-schema/#add-syncular-to-an-existing-project',
        label: 'Existing-project setup',
      },
      { href: '/platform-tauri/', label: 'Tauri' },
    ],
  },
  {
    date: '2026-08-09',
    title: 'Hosted demo repair and graphical console',
    body: 'The hosted two-pane demo seeds through the epoch-aware server helper and opens the existing graphical SyncularAdmin console against its embedded server worker. The console reads horizon status, metrics, store stats, clients, commits, rows, scope activity, and events without sending demo data to a remote server.',
    links: [{ href: '/demos/', label: 'Live demos' }],
  },
  {
    date: '2026-08-08',
    title: 'Restore fencing and host lifecycle controls',
    body: 'Wire version 2 fences restored partition timelines with log epochs while preserving each client outbox. The client package adds a shared sync scheduler and UTC month-window helpers. Native bindings add runtime header rotation and connectivity adapters. The server adds an authenticated partition registry, and typegen publishes a diagnostic remedy catalog.',
    links: [
      { href: '/server-backup-restore/', label: 'Backup and restore' },
      { href: '/guide-server-clients/', label: 'Server-side sync clients' },
      { href: '/concepts-windowing/', label: 'Windowed sync' },
      { href: '/syql/', label: 'SYQL language' },
    ],
  },
  {
    date: '2026-08-08',
    title: 'Docs restructure',
    body: 'One example domain per audience across the site, a dependency-ordered concepts arc, template-locked platform pages, and new pages for subscriptions and the outbox, schema upgrades, partitions, realtime tickets, encryption keys, and the CLI.',
    links: [
      { href: '/concepts-subscriptions/', label: 'Subscriptions & the outbox' },
      { href: '/concepts-schema-upgrades/', label: 'Schema upgrades' },
      { href: '/server-partitions/', label: 'Partitions & multi-tenancy' },
    ],
  },
  {
    date: '2026-08-08',
    title: 'Server-side sync clients on built-in SQLite',
    body: 'SyncClient runs in a CLI, background worker, or long-running service. The SQLite export selects built-in node:sqlite or bun:sqlite, and the server storage package uses the same runtime-selected import.',
    links: [
      { href: '/guide-server-clients/', label: 'Server-side sync clients' },
      { href: '/server-storage/', label: 'Storage backends' },
    ],
  },
  {
    date: '2026-08-07',
    title: 'Remote server operations',
    body: 'SyncRemoteClient is the database-less client for ordinary commits, registered authoritative queries, server-authoritative commands, and live query snapshots, for jobs, webhooks, and machine-to-machine integrations.',
    links: [
      { href: '/guide-remote-operations/', label: 'Remote server operations' },
    ],
  },
  {
    date: '2026-08-07',
    title: 'Durable server reactions',
    body: 'Reactions run application work (email, webhooks, projections) after the server accepts a commit: a planner records bounded JSON inside the authoritative transaction, and a runner delivers it at least once outside it.',
    links: [{ href: '/server-reactions/', label: 'Durable reactions' }],
  },
  {
    date: '2026-08-07',
    title: 'Domain actions and event rows',
    body: 'A documented pattern for recording why state changed: update the affected domain rows and insert one immutable event row in the same mutate() call.',
    links: [
      { href: '/guide-domain-events/', label: 'Domain actions & event rows' },
    ],
  },
  {
    date: '2026-08-03',
    title: 'Storage persistence status',
    body: 'The browser client exposes whether persistent storage has been granted, so an app can request persistence and warn about eviction risk at startup.',
    links: [{ href: '/platform-web/', label: 'Web (browser)' }],
  },
  {
    date: '2026-07-20',
    title: 'Supervised realtime lifecycle',
    body: 'The client core owns the WebSocket loop end to end: reconnects, backoff, and resubscription run inside the sync engine and surface as observable connection state.',
    links: [{ href: '/concepts-realtime/', label: 'Realtime & the WS loop' }],
  },
  {
    date: '2026-07-19',
    title: 'SYQL playground',
    body: 'A browser playground compiles editable SYQL with the same parser, semantic analysis, and lowerer as typegen, and shows the physical SQLite plan, typed inputs, dependencies, and coverage.',
    links: [{ href: '/playground/', label: 'SYQL playground' }],
  },
  {
    date: '2026-07-19',
    title: 'Safe local rebootstrap',
    body: 'A client can discard its local replica and rebuild it from a fresh server bootstrap in one guarded operation.',
    links: [{ href: '/concepts-bootstrap/', label: 'Bootstrap & segments' }],
  },
  {
    date: '2026-07-18',
    title: 'Locked migration history',
    body: 'Typegen records deployed migrations in a compact immutable lock and rejects regenerated output that rewrites history.',
    links: [{ href: '/guide-schema/', label: 'Schema & typegen' }],
  },
  {
    date: '2026-07-18',
    title: 'Rust named-query target',
    body: 'Named queries generate typed Rust functions, joining the TypeScript, Swift, Kotlin, and Dart targets.',
    links: [
      { href: '/tooling-queries/', label: 'Named queries' },
      { href: '/platform-rust/', label: 'Rust' },
    ],
  },
  {
    date: '2026-07-17',
    title: 'Authorized local purge',
    body: 'purgeLocalData() removes synced rows and unsafe pending writes after the application has validated a server-side device, membership, or key revocation.',
    links: [
      { href: '/concepts-local-data-purge/', label: 'Authorized local purge' },
    ],
  },
  {
    date: '2026-07-16',
    title: 'Local full-text search',
    body: 'Typegen can maintain an FTS5 projection beside a synced table, so every client gets full-text search that works offline.',
    links: [
      { href: '/tooling-local-search/', label: 'Local full-text search' },
    ],
  },
  {
    date: '2026-07-15',
    title: 'Durable commit outcomes',
    body: 'The server validates whole commits atomically and stores their outcomes, so a retried push returns the original result and rejections carry structured recovery metadata.',
    links: [
      { href: '/concepts-commits/', label: 'Commits, cursors, idempotency' },
    ],
  },
  {
    date: '2026-07-14',
    title: 'SYQL',
    body: 'A checked query language for named, typed, reactive reads: SQLite plus a small amount of sugar for optional filters, reusable predicates, finite sort choices, bounded limits, and synchronization coverage.',
    links: [{ href: '/syql/', label: 'SYQL language' }],
  },
  {
    date: '2026-07-14',
    title: 'One codebase, web and desktop',
    body: 'The Tauri template scaffolds one React tree that runs over the browser worker on the web and a native Rust core on desktop.',
    links: [{ href: '/platform-tauri/', label: 'Tauri' }],
  },
  {
    date: '2026-07-07',
    title: 'Named queries',
    body: '.sql and .syql files compile to typed query functions, with a formatter, a VS Code grammar, and a language server.',
    links: [{ href: '/tooling-queries/', label: 'Named queries' }],
  },
  {
    date: '2026-07-06',
    title: 'Relational server storage',
    body: 'Server storage lays every synced table out as a real relational table per app, so operators can inspect and index data with plain SQL.',
    links: [{ href: '/server-storage/', label: 'Storage backends' }],
  },
  {
    date: '2026-07-05',
    title: 'Client-side encryption',
    body: 'Designated columns encrypt on the client before upload, symmetric and asymmetric, implemented in both cores with one wire format.',
    links: [{ href: '/concepts-encryption/', label: 'Client-side encryption' }],
  },
  {
    date: '2026-07-05',
    title: 'CRDT columns',
    body: 'A column can be declared CRDT: concurrent edits merge on the server through Yjs-compatible documents supported by both cores.',
    links: [{ href: '/concepts-crdt/', label: 'CRDT columns' }],
  },
  {
    date: '2026-07-05',
    title: 'Blobs',
    body: 'File attachments are content-addressed blobs with presigned upload and download, stored on S3 or R2 with orphan garbage collection.',
    links: [{ href: '/concepts-blobs/', label: 'Blobs' }],
  },
  {
    date: '2026-07-05',
    title: 'Write-validation hooks',
    body: 'The server runs application business rules over every pushed commit before it is accepted.',
    links: [{ href: '/guide-server/', label: 'Server setup' }],
  },
  {
    date: '2026-07-05',
    title: 'Test kit',
    body: '@syncular/testkit stands up a whole backend and N real clients in memory, as plain function calls, so app tests assert what users actually see.',
    links: [{ href: '/tooling-testing/', label: 'Testing your app' }],
  },
  {
    date: '2026-07-04',
    title: 'Windowed sync',
    body: 'A client can hold a partial local replica (the hot projects, the recent months) with per-unit completeness reporting, while the server keeps the full history.',
    links: [{ href: '/concepts-windowing/', label: 'Windowed sync' }],
  },
  {
    date: '2026-07-04',
    title: 'Native platform bindings',
    body: 'Swift, Kotlin, Flutter, React Native, and Tauri bindings run over the Rust core, with generated schema and query code for each language.',
    links: [
      { href: '/platform-swift/', label: 'Swift' },
      { href: '/platform-kotlin/', label: 'Kotlin' },
      { href: '/platform-flutter/', label: 'Flutter' },
      { href: '/platform-react-native/', label: 'React Native' },
      { href: '/platform-tauri/', label: 'Tauri' },
    ],
  },
  {
    date: '2026-07-03',
    title: 'Cloudflare Workers server',
    body: "The sync server runs on Cloudflare's edge: D1 for storage, R2 for segment and blob bytes, and one Durable Object per partition for push serialization and realtime.",
    links: [{ href: '/server-workers/', label: 'Cloudflare Workers' }],
  },
  {
    date: '2026-07-03',
    title: 'Persistent browser client',
    body: 'The whole client core runs in a Web Worker on SQLite (WASM) over OPFS, and multiple tabs share one core and one socket through a leader tab.',
    links: [{ href: '/platform-web/', label: 'Web (browser)' }],
  },
  {
    date: '2026-07-03',
    title: 'React bindings',
    body: 'One hook surface with fine-grained live queries over the browser worker, the direct TypeScript core, the Tauri bridge, and the React Native bridge.',
    links: [{ href: '/platform-react/', label: 'React' }],
  },
  {
    date: '2026-07-03',
    title: 'Postgres storage',
    body: 'Postgres server storage with LISTEN/NOTIFY realtime fanout.',
    links: [{ href: '/server-storage/', label: 'Storage backends' }],
  },
  {
    date: '2026-07-03',
    title: 'Two cores, one conformance catalog',
    body: 'The Rust client core passes the same conformance catalog as the TypeScript core; golden vectors and shared scenarios hold both to SPEC.md.',
    links: [{ href: '/guide-conformance/', label: 'Protocol & conformance' }],
  },
];
