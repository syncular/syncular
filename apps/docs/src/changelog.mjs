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
