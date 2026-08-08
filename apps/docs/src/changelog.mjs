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
    date: '2026-08-08',
    title: 'Server-side sync clients',
    body: 'The same SyncClient that runs in a browser runs in a CLI, background worker, or long-running Node or Bun service, holding a local synchronized read model over native SQLite.',
    links: [
      { href: '/guide-server-clients/', label: 'Server-side sync clients' },
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
    links: [
      { href: '/guide-web-desktop/', label: 'One codebase: web + desktop' },
    ],
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
