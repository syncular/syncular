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
    date: '2026-10-06',
    title: 'syncUntilIdle reports budget exhaustion as a partial success',
    body: 'A round budget that runs out no longer discards the aggregate report or surfaces sync.invalid_request. syncUntilIdle returns the report with budgetExhausted: true, aggregating counters and outcomes across every round while readiness fields (bootstrapping, deferredCommits, schemaFloor) describe the latest round, so an empty bootstrapping list alone does not establish readiness. A real transport or protocol failure still fails. The round limit must be an integer in 1..=4294967295.',
    links: [
      {
        href: '/concepts-bootstrap/#reads-during-import',
        label: 'Reads during import and the round budget',
      },
    ],
  },
  {
    date: '2026-10-06',
    title: 'Storage contention and authoring errors are typed',
    body: 'SQLite BUSY/LOCKED (5/6), including extended codes, now classify as retryable client.storage_busy in both cores, and both cores preserve the classified code, retryable flag, and SQLite details on authoring. The native Rust mutate and patch return a structured failure with a stable code, a static message, optional details, and retryable, instead of a string callers must parse. Each authoring call classifies its own failure, so a retained storage failure cannot classify a later unrelated one. The command, shim, FFI, and Tauri boundaries forward code, message, retryable, and details. Legacy cause strings with dynamic values move to details.legacyCause.',
    links: [
      {
        href: '/platform-rust/#structured-authoring-failures',
        label: 'Structured authoring failures',
      },
    ],
  },
  {
    date: '2026-10-06',
    title: 'Push retry binds to the commit ID alone',
    body: 'A push replayed under the same (partition, clientId, clientCommitId) returns the persisted result when its operations changed. Host authentication, request-envelope validation, and the clientId-actor binding run first; the server then skips buildOperations, the commit and write validators, and the apply transaction. Clients must not reuse a clientCommitId for changed intent, including after the result is pruned. Idempotency keys on the ID: client-side encryption re-encodes with a fresh nonce on every send and schema upgrades re-encode pending commits, so a payload fingerprint would reject legitimate lost-ack retries. Per-device namespacing and content binding are documented as unimplemented.',
    links: [
      {
        href: '/concepts-commits/#idempotency',
        label: 'Idempotency and retries',
      },
    ],
  },
  {
    date: '2026-10-06',
    title: 'Neutral server bundles use explicit SQLite image builders',
    body: 'The neutral server entry no longer auto-loads bun:sqlite during bootstrap. Bun and Node hosts opt into image construction through sqliteImageBuilder. Hosts without a builder retain rows delivery and reuse of matching stored images. Unminified browser bundles and installed package exports guard runtime neutrality.',
    links: [
      {
        href: '/concepts-bootstrap/#opting-into-image-construction',
        label: 'SQLite image construction',
      },
    ],
  },
  {
    date: '2026-10-06',
    title: 'Transfer errors protect signed capabilities',
    body: 'Native and browser transports use static local error messages and allowlisted cause metadata without request URLs or raw exceptions. Blob downloads classify only HTTP 404 as blob.not_found; network and TLS failures retain transport semantics. Browser HTTP bindings preserve authenticated server catalog errors while rejecting blob.not_found on non-404 responses.',
    links: [
      {
        href: '/concepts-blobs/#transfer-failures',
        label: 'Transfer failures',
      },
    ],
  },
  {
    date: '2026-10-06',
    title: 'Overlay replay failures roll back local apply',
    body: 'Rust propagates replay read, decode, write, savepoint and FTS failures. Both clients reconcile acknowledgements before committing their local apply transaction and refuse failed startup replay. Failed apply retains durable intent and publishes no successful apply revision. Failed native purge and rebootstrap preserve the in-flight round. Incompatible commits lose their blob dependencies before upload collection. Server rejections of removed-table deletes drain the queue. Confirmed secondary unique conflicts remain deferred during replay.',
    links: [
      {
        href: '/concepts-conflicts/#the-optimistic-outbox',
        label: 'Optimistic outbox and replay failures',
      },
    ],
  },
  {
    date: '2026-10-06',
    title: 'Replica opens refuse schema downgrades',
    body: 'TypeScript and Rust clients refuse a newer persisted schema with client.schema_downgrade before bookkeeping writes or reset. The replica, outbox and previous-version context remain intact. Unreadable, corrupt or missing paired markers fail with sync.local_corrupt. Startup writes are transactional. Previous-version reads discard captures for an uncommitted schema; capture remains a separate-file operation.',
    links: [
      {
        href: '/concepts-schema-upgrades/',
        label: 'Schema upgrades and downgrade refusal',
      },
    ],
  },
  {
    date: '2026-10-04',
    title: 'Authority readers require an explicit bundle opt-in',
    body: 'Released in 0.30.16. Ordinary workers exclude the authority reader. Authority-enabled workers inject the factory from @syncular/client/authority. Native apps use @syncular/tauri/authority for the snapshot bridge. Missing worker opt-in fails before storage opens. Accepted-base evidence and independent Rust enforcement retain their 0.30.15 semantics; bundle caps are unchanged.',
    links: [
      {
        href: '/platform-tauri/#authority-evidence-before-activation',
        label: 'Authority opt-in and native policy',
      },
    ],
  },
  {
    date: '2026-10-04',
    title: 'Declared authority snapshots during security preflight',
    body: 'Released in 0.30.15. A static plain-column policy exposes accepted authority bases, local revision and persisted scope coverage before key activation. Local intent remains separate. Rust enforces the native app column ceiling and rejects forged IPC. The snapshot changes no lifecycle, keys, transport or data.',
    links: [
      {
        href: '/platform-tauri/#authority-evidence-before-activation',
        label: 'Authority evidence and native policy',
      },
    ],
  },
  {
    date: '2026-10-04',
    title: 'Bounded ACK replay and epoch acquisition without migration',
    body: 'Released in 0.30.14. Imports restore and replay only affected rows or tables. Empty unrelated bootstraps leave protected ACK intent untouched. First-epoch acquisition preserves ready readers and subscription progress without raising upgrading. A differing stored epoch still resets the replica.',
    links: [
      {
        href: '/concepts-conflicts/#the-optimistic-outbox',
        label: 'Protected intent reconciliation',
      },
      {
        href: '/server-backup-restore/',
        label: 'Epoch acquisition and resets',
      },
    ],
  },
  {
    date: '2026-10-03',
    title: 'Native local activation with transport closed',
    body: 'Released in 0.30.13. Both cores have an explicit transport gate. Tauri can activate security, read its replica and queue local commits before a fresh bearer is available. Pausing suppresses new HTTP, realtime and retry work; captured replies retain atomic apply and revocation checks. Resume wakes the existing scheduler and flushes queued commits in order.',
    links: [
      {
        href: '/platform-tauri/#local-activation-with-transport-closed',
        label: 'Offline activation and resume',
      },
    ],
  },
  {
    date: '2026-10-03',
    title: 'Acknowledged writes remain visible until row delivery',
    body: 'Released in 0.30.12. Both cores preserve accepted local intent through empty pulls and restart, stack later edits above it, and request an immediate following pull. Matching server delivery retires the intent atomically. Revocation and purge remove it. Servers detect a pull maximum behind their accepted push; sync storage and authorization require uncached reads.',
    links: [
      {
        href: '/concepts-conflicts/#the-optimistic-outbox',
        label: 'Acknowledgements and local reads',
      },
      { href: '/server-storage/#read-freshness', label: 'Storage freshness' },
    ],
  },
  {
    date: '2026-10-03',
    title: 'Native sync keeps local writes responsive',
    body: 'Released in 0.30.11. Tauri runs sync network I/O outside the mutable owner. New mutations and queries finish while replies are pending; their commits enter the next round. The Rust overlay rebuilds only changed tables and FTS indexes, leaving unrelated catalogues untouched.',
    links: [
      {
        href: '/platform-tauri/#local-commands-during-sync',
        label: 'Native local-first commands',
      },
    ],
  },
  {
    date: '2026-10-03',
    title: 'Schema bumps remove incompatible scope registrations',
    body: 'Released in 0.30.11. Both cores prune subscriptions and windows when a scope variable, pattern prefix or mapped column changes. Compatible registrations re-bootstrap, and same-version opens preserve cursors. Applications register their current subscriptions after opening the replica.',
    links: [
      {
        href: '/concepts-schema-upgrades/#what-the-reset-touches',
        label: 'Subscription migration',
      },
    ],
  },
  {
    date: '2026-10-03',
    title: 'OPFS workers release handles across reloads',
    body: 'Released in 0.30.11. Closing a persistent database pauses its access-handle pool before releasing its Web Lock. Page teardown terminates the worker, and the next opener waits for the physical holder. Live second tabs retain leader/follower behavior.',
    links: [
      {
        href: '/platform-web/#persistent-worker-lifecycle',
        label: 'Persistent worker lifecycle',
      },
    ],
  },
  {
    date: '2026-10-03',
    title: 'Retained unique-key insert conflicts preserve the server winner',
    body: 'Released in 0.30.11. Both client cores retain a rejected distinct-ID insert as protected journal intent when another server row owns its unique key. Recovery exposes the matching index and competing row with its current version. Restart and explicit resolution preserve replica consistency; revocation removes protected conflict payloads.',
    links: [
      {
        href: '/concepts-conflicts/#retain-failed-local-intent',
        label: 'Unique-key conflict recovery',
      },
    ],
  },
  {
    date: '2026-10-03',
    title: 'Sparse writes require a local base',
    body: 'Released in 0.30.10. Both client cores reject a sparse patch with sync.row_missing before enqueueing when its local row is absent. Mixed batches remain atomic. A retained sparse conflict keeps its evidence after the base disappears without creating an incomplete local row.',
    links: [
      {
        href: '/concepts-conflicts/',
        label: 'Sparse writes and retained conflicts',
      },
    ],
  },
  {
    date: '2026-10-02',
    title: 'Atomic sparse aggregates and retained local conflicts',
    body: 'Released in 0.30.9. v0.30.8 tagged, not published; superseded by 0.30.9. A mutation batch mixes sparse patches, full rows and deletes in one atomic commit. Plain-column patches leave encrypted ciphertext untouched without keys. Clients can retain rejected aggregate intent across pulls and restart, expose current server rows, and resolve it explicitly. Scope revocation and security purge remove retained intent.',
    links: [
      {
        href: '/concepts-conflicts/',
        label: 'Atomic writes and conflict resolution',
      },
    ],
  },
  {
    date: '2026-10-02',
    title: 'SQLite imports preserve the first storage failure',
    body: 'A full local database reports client.storage_full with its numeric SQLite code. A failed rollback stays secondary. Browser, Bun, Node and native clients accept another import after capacity returns. Server cleanup also retains its original exception.',
    links: [
      {
        href: '/platform-web/#local-storage-failures',
        label: 'Local storage failures',
      },
    ],
  },
  {
    date: '2026-10-02',
    title: 'Host headers and named transport errors survive segment downloads',
    body: 'Web and Tauri forward host headers when fetching segments. The HTTP transport reports segment failures with their status and static code. The Hono host authorizes requested CORS headers. Closed worker and native clients reject calls with client.closed.',
    links: [
      { href: '/guide-server/', label: 'Server transport' },
      { href: '/platform-tauri/', label: 'Tauri' },
    ],
  },
  {
    date: '2026-10-02',
    title: 'Older clients sync through a reviewed schema window',
    body: 'The host supplies current and prior compiled schemas. Old pushes decode with their codec and pass current server rules; pulls, segments, conflicts and realtime omit new columns. Unsafe structural changes refuse the window. A schema floor keeps local reactive reads available, including newly opened queries.',
    links: [
      {
        href: '/concepts-schema-upgrades/#serving-a-compatibility-window',
        label: 'Schema upgrades',
      },
    ],
  },
  {
    date: '2026-10-02',
    title: 'A closed leader tab posts no late answer',
    body: 'A follower call that the leader tab settled after its `LeaderBridge` closed, for example while the app signed out, posted the answer on the closed BroadcastChannel, and the browser threw an uncaught `InvalidStateError`. The leader now drops answers after close.',
    links: [
      {
        href: '/platform-web/#multi-tab',
        label: 'Web (browser)',
      },
    ],
  },
  {
    date: '2026-10-02',
    title: 'The Tauri plugin opens one named database per actor',
    body: '`SyncularConfig.database_dir` and `createTauriSyncClient({ database })` open `<database_dir>/<database>.db`, so an app opens one replica, and one client id, per signed-in actor. The plugin refuses names that could leave the directory and a `dbPath` supplied by the webview with `sync.invalid_request`; the snapshot reader follows the database the last successful `create` opened.',
    links: [
      {
        href: '/platform-tauri/#one-replica-per-actor',
        label: 'Tauri',
      },
    ],
  },
  {
    date: '2026-10-01',
    title: 'A schema migration fences writers of the previous schema',
    body: 'A SQLite or PostgreSQL schema migration now raises the writer fence of every existing partition to the new schema version in the migration transaction. A server process still running the previous schema had its pushes refused by the serve gate, but its server-side writes through `storage.begin()` and `appendCommit` read no gate and stored payloads in the previous layout. They now fail with `sync.storage.writer_fence_rejected`.',
    links: [
      {
        href: '/server-storage/',
        label: 'Storage backends',
      },
    ],
  },
  {
    date: '2026-10-01',
    title: 'PostgreSQL stores commits of any size',
    body: "`PostgresServerStorage` appended a commit's changes in one statement with seven bound parameters per change, so a commit above about 9,360 changes overflowed the 16-bit parameter count of PostgreSQL's Bind message and failed. It now appends 4,096 changes per statement inside the same transaction and under the same `commit_seq`; a 150,015-change commit appends in 1.48 s on PostgreSQL 18 (SYNCULAR-PG-BIND-LIMIT-001).",
    links: [
      {
        href: '/guide-server/',
        label: 'Server guide',
      },
    ],
  },
  {
    date: '2026-10-01',
    title: 'A rejected window claim is claimed again',
    body: "A live query whose window claim was rejected for a reason other than leader loss, for example a transport failure, stayed in `error` until its last subscriber left. The reactive store now claims again on a committed row change of one of the query's tables, once per sync attempt, when a leader serves the tab, and on `refresh()` (SYNCULAR-CLAIM-STICKY-001).",
    links: [
      {
        href: '/concepts-windowing/',
        label: 'Windowing',
      },
    ],
  },
  {
    date: '2026-10-01',
    title: 'A promoted tab runs the calls it queued during the handover',
    body: 'A follower that won the Web Lock rejected the calls it had queued for the next leader with `client.worker_failed` when it installed its own core, and its live queries kept that rejection. The new core now runs them, and the reactive store claims a rejected coverage claim again whenever a leader serves the tab.',
    links: [
      {
        href: '/platform-web/#multi-tab',
        label: 'Web (browser)',
      },
    ],
  },
  {
    date: '2026-10-01',
    title:
      'Multi-tab followers wait for a busy leader and never follow another build',
    body: "A follower's forwarded call no longer fails after `followerCallTimeoutMs` while the leader answers probes, so a `setWindow` that waits behind a long bootstrap download completes. Calls reject when the link blocks or another leader takes over (`client.leader_handover`). Every cross-tab message carries `MULTI_TAB_PROTOCOL_VERSION` and the schema version: a follower whose leader runs another build is `blocked` with reason `leader-incompatible`, and a leader steps down for a newer tab (SYNCULAR-FOLLOWER-CALL-DEADLINE-001, SYNCULAR-MULTI-TAB-VERSION-001).",
    links: [
      {
        href: '/platform-web/#multi-tab',
        label: 'Web (browser)',
      },
    ],
  },
  {
    date: '2026-10-01',
    title: 'Streamed segments reach Workers clients encoded once',
    body: "`GET /segments/:id` on Cloudflare Workers gzipped a segment above 16 MiB itself and declared `Content-Encoding: gzip`; workerd then gzipped the response again, so a client that decoded it once failed content-address verification and retried without end. The route now marks every body it encodes with `encodeBody: 'manual'`, and a workerd test verifies the content address of a streamed segment after one decode (SYNCULAR-WORKERS-SEGMENT-ENCODING-001).",
    links: [
      {
        href: '/concepts-bootstrap/#setting-it-up',
        label: 'Bootstrap',
      },
    ],
  },
  {
    date: '2026-10-01',
    title: 'FTS queries read source ids without a content row per match',
    body: "Typegen emits FTS joins that read `_syncular_source_id` through the client's source-id mapping table on the projection rowid, so FTS5 no longer fetches the content row of every match. The authored SQL, its types, its identity, and its rows stay the same; a 50,000-match search took 53.9 ms against 73.6 ms. Both client cores keep one mapping row per projection row, pinned by a conformance scenario (SYNCULAR-FTS-SOURCE-ID-001).",
    links: [
      {
        href: '/tooling-local-search/#query-it',
        label: 'Local search',
      },
    ],
  },
  {
    date: '2026-10-01',
    title: 'A ranked top-N CTE can keep only its page',
    body: 'A top-level CTE body may end in `LIMIT <n>` when its `ORDER BY` ends with the CTE identity, so a search ranks narrow rows and SQLite keeps only the page in its sort. The unbounded materialized form sorts every match and costs about 30 % more on narrow rows; the guidance now says so (SYNCULAR-SYQL-TOPN-001).',
    links: [
      {
        href: '/syql/#ranked-top-n',
        label: 'Ranked top-N',
      },
    ],
  },
  {
    date: '2026-10-01',
    title: 'A failed-round query error says whether a retry follows',
    body: '`SyncRoundFailedError` carries `retryable` and `retryDelayMs`. A retryable failure names the delay of the background retry the client scheduled (250 ms, doubling per consecutive failure up to 30 s); a non-retryable failure has no automatic next attempt. Failed sync progress carries the same `retryDelayMs` in the TypeScript and Rust cores. The Rust core now re-pulls after a segment content-address mismatch, as the TypeScript core does (SYNCULAR-ROUND-FAILURE-RETRY-001).',
    links: [
      {
        href: '/platform-react/#generated-live-queries',
        label: 'Query phases',
      },
    ],
  },
  {
    date: '2026-10-01',
    title: 'A failed sync round ends a waiting query in `error`',
    body: "A live query whose required coverage is incomplete publishes phase `error` when the latest sync attempt fails, with a `SyncRoundFailedError` carrying the attempt's stable code (for example `sync.transport_failed`) and number. It keeps its rows and revision, stays `error` across local re-reads, and returns to `loading` or `partial` when the next attempt starts. `useQuery` and `useRawSql` show the same phase, so an interrupted bootstrap no longer renders as an endless `loading` (SYNCULAR-QUERY-PHASE-STALL-001).",
    links: [
      {
        href: '/platform-react/#generated-live-queries',
        label: 'Query phases',
      },
    ],
  },
  {
    date: '2026-10-01',
    title: 'Ranked top-N queries read wide rows after the limit',
    body: 'SYQL accepts `AS [NOT] MATERIALIZED` on a CTE and proves scope coverage, column lineage, and row identity per SELECT scope: the outer statement and each top-level CTE body. A bounded query can rank narrow rows in a materialized CTE and join the wide table by `ON t.pk = cte.key`; SQLite 3.51 and later sort only the CTE rows and read a wide row only for a returned row (SYNCULAR-SYQL-TOPN-001). An outer scope predicate no longer proves a subquery instance that reuses its alias; such a sync query now fails with `SYQL6005_INVALID_SYNC_QUERY`.',
    links: [
      {
        href: '/syql/#ranked-top-n',
        label: 'Ranked top-N',
      },
    ],
  },
  {
    date: '2026-09-30',
    title: 'Publish SQLite images for hosts without a SQLite engine',
    body: 'A bootstrap on the sqlite-image lane pins at the newest change in its scope, so a stored image stays current across commits to other tables and scopes. `publishSqliteImage` stores the image a pull for a table and scope set looks up, from a Bun process with the production storage, and a Workers host serves it. `GET /segments/:id` streams segments above 16 MiB from a segment store that implements `open` (`S3SegmentStore` does), gzip-encoded when accepted. `writeSqliteImage` is exported for custom builders.',
    links: [
      {
        href: '/concepts-bootstrap/#publishing-images-from-another-host',
        label: 'Publishing images',
      },
    ],
  },
  {
    date: '2026-09-30',
    title: 'Unexpected server exceptions are retryable and reported',
    body: 'An exception that is not a `SyncError` answers HTTP 500 with the new retryable `sync.internal_error`, and a fixed message that never contains the exception text. The sync config takes `onError(error, { route })`, which receives the original exception from every adapter route, socket round, and remote operation. The Rust core now schedules a background retry after any catalog-retryable server code, as the TypeScript core does.',
    links: [
      {
        href: '/guide-server/#reporting-server-errors',
        label: 'Reporting server errors',
      },
    ],
  },
  {
    date: '2026-09-30',
    title: 'PostgreSQL push commits cost fewer statements',
    body: 'A push commit on `PostgresServerStorage` reads every row its operations target, with the delete tombstones, in one statement per table, writes each row and its scope-index entries in one statement, and appends all of its changes in one statement. A first realtime round carrying 10 three-row commits and 68 subscriptions issues 141 statements in 10 transactions, down from 400 (SYNCULAR-PULL-ROUNDTRIPS-001). HTTP `POST /sync` and realtime socket rounds share the path.',
    links: [
      {
        href: '/server-storage/#postgres-postgresserverstorage',
        label: 'Postgres storage',
      },
    ],
  },
  {
    date: '2026-09-30',
    title: 'Pull statements grow with tables, not subscriptions',
    body: 'A pull starts the commit-window read or first snapshot page of every subscription before awaiting any of them and re-reads the pruning horizon once. `PostgresServerStorage` answers the page reads of one table with one statement, and `D1ServerStorage` sends them as one `db.batch` round trip. A 68-subscription PostgreSQL pull over two tables issues 11 statements to catch up and 10 to bootstrap, down from 146 and 79 (SYNCULAR-PULL-ROUNDTRIPS-001). The PostgreSQL serve gate reads its three parts in one statement. Response frames do not change.',
    links: [
      {
        href: '/server-storage/#postgres-postgresserverstorage',
        label: 'Postgres storage',
      },
    ],
  },
  {
    date: '2026-09-30',
    title: 'Local native builds prune old Rust intermediates',
    body: 'The development checks, native packaging and binding gates now prune stale Cargo caches before building on macOS/Linux. The cleanup keeps recent artifacts and skips target folders locked by another Cargo build. Use bun run rust for Rust-core commands and bun run rust:clean --dry-run to preview the policy.',
    links: [
      {
        href: '/contributing/#local-rust-build-caches',
        label: 'Build cache policy',
      },
    ],
  },
  {
    date: '2026-09-29',
    title: 'A hidden leader tab no longer blocks its followers',
    body: 'Follower tabs now check leader liveness by probing: after a third of `followerCallTimeoutMs` without hearing from the leader, a follower posts a probe that the leader tab answers from its message handler, and the follower goes `blocked` with `client.follower_timeout` only when that probe stays unanswered. The leader runs no heartbeat timer, so browser timer throttling in a hidden leader tab no longer blocks visible followers. A hung leader still blocks its followers within `followerCallTimeoutMs`, a blocked follower rebinds when the leader answers again, and one slow call rejects on its own deadline without blocking the handle. Remove any raised `followerCallTimeoutMs` that worked around background-tab throttling. Upgrade note: after upgrading, reload every open tab of the origin. A tab running 0.26.0 or older as a follower next to a leader on this release waits for the removed leader heartbeat and reports the leader unreachable (`client.follower_timeout`) until it reloads; a current follower next to an older leader works.',
    links: [{ href: '/platform-web/#multi-tab', label: 'Multi-tab' }],
  },
  {
    date: '2026-09-28',
    title: 'Realtime connectivity is an explicit policy and state',
    body: "`realtimePolicy: 'required'` designates the socket as the sync path: while it is not connected, `sync()` raises `RealtimeUnavailableError` with the availability state, an optional reason code, and the next retry delay, and no HTTP round runs. The default `optional` keeps today's behavior and still reports the explicit states. Diagnostics carry `realtime` (`connected`, `connecting`, `disconnected`, `lost`, `refused`, `disabled`, or `unsupported`), `realtimePolicy`, `realtimeReasonCode`, and `realtimeRetryDelayMs`. The Rust core exposes the same states through `set_realtime_policy`, `realtime_state()`, and `SyncOutcome::RealtimeUnavailable`. The worker handle and the Tauri and React Native create configs forward the policy.",
    links: [
      { href: '/concepts-realtime/#required-realtime', label: 'Realtime' },
    ],
  },
  {
    date: '2026-09-26',
    title: 'Docs search',
    body: 'The documentation site now has a search dialog. Press ⌘K (Ctrl+K on Windows and Linux) or `/` on any docs, blog, or landing page, or use the search button in the sidebar. Results link to the matching section of each page, and API names inside code blocks are searchable.',
    links: [{ href: '/what-is/', label: 'Documentation' }],
  },
  {
    date: '2026-09-26',
    title: 'Browser handles send and rotate auth headers',
    body: '`createSyncClientHandle` accepts `headers`, which the worker attaches to every sync, segment, and blob request, and `handle.setHeaders(...)` replaces them at runtime. A follower tab forwards the call to the leader and starts a promoted worker with its latest set. The HTTP transports also accept `headers` as a function read on every request, and `startSyncWorker({ createRealtime })` receives the current headers so a custom connector can mint a realtime ticket per attempt. A new Authentication page shows the server `authenticate` callback and the client wiring on every platform.',
    links: [{ href: '/guide-auth/', label: 'Authentication' }],
  },
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
