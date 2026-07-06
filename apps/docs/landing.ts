/**
 * The landing page — the one page that sells; every other page informs.
 * Same boring stance as the rest of the site: static HTML, no client-side
 * JS (the platform tabs are CSS-only radio inputs), one stylesheet.
 *
 * Every code snippet below is transcribed from a binding README or the
 * quickstart example — if an API changes, change it here too (the snippets
 * are the most-read code in the project).
 */

function esc(code: string): string {
  return code
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

interface Tab {
  readonly id: string;
  readonly label: string;
  readonly code: string;
}

/** One flow, six languages: create → subscribe → write → sync → read. */
const TABS: readonly Tab[] = [
  {
    id: 'ts',
    label: 'TypeScript',
    code: `import { SyncClient, httpSyncTransport, httpSegmentDownloader } from '@syncular/client';
import { openBunDatabase } from '@syncular/client/bun';
import { schema } from './syncular.generated';

const client = new SyncClient({
  database: openBunDatabase(),           // browser: sqlite-wasm on OPFS
  schema,
  clientId: 'device-1',
  transport: httpSyncTransport('https://your.server/sync'),
  segments: httpSegmentDownloader('https://your.server/segments'),
});
await client.start();

client.subscribe({ id: 'todos', table: 'todos', scopes: { list_id: ['inbox'] } });

client.mutate([{
  table: 'todos',
  op: 'upsert',
  values: { id: 't1', list_id: 'inbox', title: 'Ship it', done: 0 },
}]);
await client.syncUntilIdle();

client.query('SELECT * FROM todos WHERE done = 0');`,
  },
  {
    id: 'react',
    label: 'React',
    code: `import { useMutation, useSyncQuery } from '@syncular/react';

function Todos() {
  const { rows } = useSyncQuery(
    'SELECT * FROM todos WHERE done = 0 ORDER BY position',
  );
  const { mutate } = useMutation();

  return (
    <ul>
      {rows.map((todo) => (
        <li key={todo.id}>
          <button onClick={() => mutate([{
            table: 'todos',
            op: 'upsert',
            values: { ...todo, done: 1 },
          }])}>
            {todo.title}
          </button>
        </li>
      ))}
    </ul>
  );
  // Re-renders only when the todos table changes — offline or online.
}`,
  },
  {
    id: 'swift',
    label: 'Swift',
    code: `import Syncular

let client = try SyncularClient(
    clientId: "device-1",
    schema: schemaJSON,
    config: SyncularConfig(
        baseUrl: "https://your.server/sync",
        dbPath: "\\(appSupport)/syncular.db"
    )
)

try client.subscribe(id: "todos", table: "todos", scopes: ["list_id": ["inbox"]])

try client.mutate([.object([
    "op": "upsert", "table": "todos",
    "values": .object(["id": "t1", "list_id": "inbox", "title": "Ship it"]),
])])
let outcome = try client.sync()

let rows = try client.query("SELECT * FROM todos WHERE done = ?", params: [.bool(false)])

client.onEvent = { event in
    if event.type == "sync-needed" { scheduleSync() }
}`,
  },
  {
    id: 'kotlin',
    label: 'Kotlin',
    code: `import dev.syncular.*

val client = SyncularClient.create(
    clientId = "device-1",
    schema = schemaJson,
    config = SyncularConfig(
        baseUrl = "https://your.server/sync",
        dbPath = "$appData/syncular.db",
    ),
)

client.subscribe(id = "todos", table = "todos", scopes = mapOf("list_id" to listOf("inbox")))

client.mutate(listOf(JsonValue.obj(
    "op" to JsonValue.of("upsert"), "table" to JsonValue.of("todos"),
    "values" to JsonValue.obj("id" to JsonValue.of("t1"),
        "list_id" to JsonValue.of("inbox"), "title" to JsonValue.of("Ship it")),
)))
val outcome = client.sync()

val rows = client.query("SELECT * FROM todos WHERE done = ?", listOf(JsonValue.of(false)))

client.listener = SyncularEventListener { event ->
    if (event.type == "sync-needed") scheduleSync()
}`,
  },
  {
    id: 'dart',
    label: 'Flutter',
    code: `import 'package:syncular/syncular.dart';

final client = SyncularClient.create(
  clientId: 'device-1',
  schema: todoSchema,
  config: SyncularConfig(
    baseUrl: 'https://your.server',
    dbPath: '/path/to/todos.db',
  ),
);

client.subscribe('todos', 'todos', scopes: {'list_id': ['inbox']});

client.mutate([
  {'op': 'upsert', 'table': 'todos',
   'values': {'id': 't1', 'list_id': 'inbox', 'title': 'Ship it'}},
]);
client.syncUntilIdle();

final rows = client.query(
  'SELECT * FROM todos WHERE done = ?', params: [false]);

client.events.listen((e) {
  if (e.type == 'sync-needed') client.sync();
});`,
  },
  {
    id: 'rust',
    label: 'Rust',
    code: `use syncular_client::{ClientLimits, Mutation, SyncClient};

let mut client = SyncClient::open_path(
    "device-1".into(), &schema_json, ClientLimits::default(), "todos.db")?;

client.subscribe(
    "todos".into(), "todos".into(),
    vec![("list_id".into(), vec!["inbox".into()])], None)?;

client.mutate(vec![Mutation::Upsert {
    table: "todos".into(),
    values: serde_json::json!({
        "id": "t1", "list_id": "inbox", "title": "Ship it"
    }).as_object().cloned().unwrap(),
    base_version: None,
}])?;

client.sync_until_idle(&mut transport, None);

let rows = client.query("SELECT * FROM todos WHERE done = 0", &[])?;`,
  },
];

function renderTabs(): string {
  const inputs = TABS.map(
    (tab, i) =>
      `<input type="radio" name="platform-tab" id="tab-${tab.id}" class="tab-input tab-input-${tab.id}"${i === 0 ? ' checked' : ''}>`,
  ).join('\n');
  const labels = TABS.map(
    (tab) => `<label for="tab-${tab.id}">${tab.label}</label>`,
  ).join('\n');
  const panels = TABS.map(
    (tab) =>
      `<div class="tab-panel tab-panel-${tab.id}"><pre><code>${esc(tab.code)}</code></pre></div>`,
  ).join('\n');
  // CSS-only tabs: the checked radio shows its panel and highlights its label
  // via sibling selectors — no JavaScript.
  return `<div class="tabs">
${inputs}
<div class="tab-labels">${labels}</div>
<div class="tab-panels">${panels}</div>
</div>`;
}

interface Card {
  readonly title: string;
  readonly body: string;
  readonly href?: string;
}

const FEATURES: readonly Card[] = [
  {
    title: 'Scopes are your auth',
    body: 'One <code>resolveScopes(actor)</code> function in <em>your</em> backend decides what every client may see and write. Sync never becomes a second authorization system.',
    href: '/concepts-scopes/',
  },
  {
    title: 'Offline-first writes',
    body: 'Mutations apply to local SQLite instantly and queue in a durable outbox. Reconnect and they replay — idempotently, in order.',
    href: '/concepts-conflicts/',
  },
  {
    title: 'Honest conflicts',
    body: 'Version-based detection with the server row attached. Conflicts are surfaced to your app, never silently merged.',
    href: '/concepts-conflicts/',
  },
  {
    title: 'Realtime over WebSocket',
    body: 'One sync loop over the socket — verified binary deltas, no polling, no degraded fallback path.',
    href: '/concepts-realtime/',
  },
  {
    title: 'Fast bootstrap',
    body: 'Content-addressed segments with a precomputed SQLite-image lane: a fresh client loads 100k rows in ~30 ms.',
    href: '/concepts-bootstrap/',
  },
  {
    title: 'CRDT columns',
    body: 'Opt-in collaborative text per column (Yjs on the web, yrs natively) — byte-identical convergence across cores, proven in conformance.',
    href: '/concepts-crdt/',
  },
  {
    title: 'Blobs & E2EE',
    body: 'Content-addressed file attachments on S3/R2, and opt-in per-column end-to-end encryption (AES-256-GCM).',
    href: '/concepts-blobs/',
  },
  {
    title: 'Windowed sync',
    body: 'Keep a partial replica — “only hot projects, last 90 days” — with atomic eviction and an honest completeness oracle.',
    href: '/concepts-windowing/',
  },
  {
    title: 'Testable by design',
    body: 'An in-process testkit: real clients against an in-memory server, offline toggles, fault injection, and a virtual clock.',
    href: '/tooling-testing/',
  },
];

const STEPS: readonly Card[] = [
  {
    title: '1 · Local SQL',
    body: 'Your app reads and writes a real SQLite database on the device. Queries, joins, aggregates — all local, all instant.',
  },
  {
    title: '2 · Outbox push',
    body: 'Writes queue in a durable outbox and push as idempotent commits. Offline just means the queue gets longer.',
  },
  {
    title: '3 · Commit log',
    body: 'The server validates every commit against your scopes and appends it to an ordered, auditable log.',
  },
  {
    title: '4 · Scoped delivery',
    body: 'Clients bootstrap from precomputed segments, then follow realtime deltas — only ever the rows they are authorized for.',
  },
];

const NUMBERS: readonly { value: string; label: string }[] = [
  { value: '30 ms', label: 'to bootstrap 100k rows on a fresh client' },
  { value: '0.2 ms', label: 'p95 realtime propagation between clients' },
  { value: '19.6 KB', label: 'gzipped web client (syncular’s own code)' },
  { value: '74 × 2', label: 'conformance scenarios, run on both cores' },
  { value: '6', label: 'platform bindings over one written protocol' },
];

const PLATFORM_LINKS: readonly { label: string; href: string }[] = [
  { label: 'Web', href: '/platform-web/' },
  { label: 'React', href: '/platform-react/' },
  { label: 'Swift', href: '/platform-swift/' },
  { label: 'Kotlin', href: '/platform-kotlin/' },
  { label: 'Flutter', href: '/platform-flutter/' },
  { label: 'React Native', href: '/platform-react-native/' },
  { label: 'Tauri', href: '/platform-tauri/' },
  { label: 'Rust', href: '/platform-rust/' },
  { label: 'C FFI', href: '/platform-ffi/' },
];

function cards(items: readonly Card[], className: string): string {
  return `<div class="${className}">${items
    .map((card) => {
      const title = card.href
        ? `<a href="${card.href}">${card.title}</a>`
        : card.title;
      return `<div class="card"><h3>${title}</h3><p>${card.body}</p></div>`;
    })
    .join('')}</div>`;
}

export function renderLanding(): string {
  const numbers = NUMBERS.map(
    (n) =>
      `<div class="number"><div class="value">${n.value}</div><div class="label">${n.label}</div></div>`,
  ).join('');
  const platformLinks = PLATFORM_LINKS.map(
    (p) => `<a class="chip" href="${p.href}">${p.label}</a>`,
  ).join('');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>syncular — offline-first SQL sync for every platform</title>
<meta name="description" content="Local SQLite on every client, kept in sync through a server-authoritative commit log. One written protocol, two conformance-locked cores (TypeScript and Rust), bindings for web, React, Swift, Kotlin, Flutter, React Native, and Tauri.">
<link rel="stylesheet" href="/style.css">
</head>
<body class="landing-body">
<header class="topnav">
  <a class="brand" href="/">syncular</a>
  <nav>
    <a href="/what-is/">Docs</a>
    <a href="/quickstart/">Quickstart</a>
    <a href="/demos/">Demos</a>
    <a href="https://github.com/syncular/syncular">GitHub</a>
  </nav>
</header>
<main class="landing">

<section class="hero">
  <h1>Local SQLite on every client.<br>One protocol. Every platform.</h1>
  <p class="sub">Syncular gives your app a real SQLite database that stays in sync
  through a server-authoritative commit log — scoped to exactly the data each user
  is allowed to see. Optimistic writes, offline replay, realtime deltas, and honest
  conflicts, on the web and natively on iOS, Android, Flutter, React Native,
  Tauri, and Rust.</p>
  <div class="cta-row">
    <a class="btn primary" href="/quickstart/">Quickstart — 5 minutes</a>
    <a class="btn" href="/demos/">See the live demos</a>
  </div>
  <pre class="install"><code>bun create syncular-app my-app</code></pre>
</section>

<section>
  <h2>One engine, your language</h2>
  <p class="section-sub">The same flow everywhere — create a client, subscribe to a
  scope, write locally, sync. Web clients run the TypeScript core; everything else
  runs the Rust core. Both implement one written protocol and pass the same
  conformance suite.</p>
  ${renderTabs()}
  <div class="chip-row">${platformLinks}</div>
</section>

<section>
  <h2>How it works</h2>
  ${cards(STEPS, 'grid steps')}
  <p class="section-sub">The server stays authoritative: every commit is validated,
  scoped, idempotent, and auditable. Clients are optimistic: every write lands
  locally first. <a href="/concepts-commits/">Commits, cursors &amp; idempotency →</a></p>
</section>

<section class="numbers-band">
  <div class="numbers">${numbers}</div>
  <p class="fineprint">Measured, not promised — methodology and caveats in the
  <a href="/benchmarks/">benchmarks</a>.</p>
</section>

<section>
  <h2>What you get</h2>
  ${cards(FEATURES, 'grid features')}
</section>

<section class="spec-band">
  <h2>Spec-first, two cores, zero drift</h2>
  <p class="section-sub">Syncular is not one binary bridged everywhere. It is a
  <a href="https://github.com/syncular/syncular/blob/main/SPEC.md">written protocol</a>
  with two independent implementations — TypeScript for the web, Rust for native —
  kept in lockstep by golden byte-level vectors and a shared conformance catalog
  that runs every scenario against both cores in CI. Divergence is a bug you can
  point at, and a third implementation can join against the spec, not a binary.</p>
  <p class="section-sub"><a href="/guide-conformance/">Protocol &amp; conformance →</a></p>
</section>

<section>
  <h2>Runs on your stack</h2>
  <p class="section-sub">A framework-neutral server core with adapters for
  <a href="/guide-server/">Bun and Node (Hono)</a> and
  <a href="/server-workers/">Cloudflare Workers</a> — storage on
  <a href="/server-storage/">SQLite, Postgres, or D1</a>, segments and blobs on
  S3-compatible stores like R2, realtime fan-out via in-process hub, Postgres
  LISTEN/NOTIFY, or Durable Objects. Pruning, blob GC, ops events, and an admin
  surface are <a href="/server-operations/">part of the product</a>.</p>
</section>

</main>
<footer class="footer">
  <div>
    <a href="/what-is/">Docs</a>
    <a href="/quickstart/">Quickstart</a>
    <a href="/reference/">Packages</a>
    <a href="https://github.com/syncular/syncular">GitHub</a>
  </div>
  <p>Apache-2.0 · npm <code>@syncular/*</code> · crates.io <code>syncular-*</code></p>
</footer>
</body>
</html>`;
}
