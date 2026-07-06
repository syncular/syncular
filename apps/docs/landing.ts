/**
 * The landing page — a transmission printout with a live ASCII singularity.
 * Same generator stance as the docs (static HTML, one stylesheet, no
 * framework), with two deliberate exceptions, both inline: the hero's ASCII
 * black-hole simulation and its commit-log ticker. They are the page's whole
 * design language; everything else (including syntax highlighting, done at
 * build time via highlight.ts) ships as plain markup.
 *
 * Every code snippet below is transcribed from a binding README or the
 * quickstart example — if an API changes, change it here too (the snippets
 * are the most-read code in the project).
 */
import { highlight } from './highlight';

interface Tab {
  readonly id: string;
  readonly label: string;
  readonly lang: string;
  readonly code: string;
}

/** One flow, six languages: create → subscribe → write → sync → read. */
const TABS: readonly Tab[] = [
  {
    id: 'ts',
    label: 'TS',
    lang: 'ts',
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
    label: 'REACT',
    lang: 'tsx',
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
    label: 'SWIFT',
    lang: 'swift',
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
    label: 'KOTLIN',
    lang: 'kotlin',
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
    label: 'FLUTTER',
    lang: 'dart',
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
    label: 'RUST',
    lang: 'rust',
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

const FEATURES: readonly { title: string; body: string; href: string }[] = [
  {
    title: 'scopes-as-code',
    body: 'one resolveScopes(actor) in your backend gates every read and write',
    href: '/concepts-scopes/',
  },
  {
    title: 'offline outbox',
    body: 'writes queue while out of range, replay in order on reconnect',
    href: '/concepts-conflicts/',
  },
  {
    title: 'honest conflicts',
    body: 'surfaced with the server row attached, never silently merged',
    href: '/concepts-conflicts/',
  },
  {
    title: 'realtime',
    body: 'verified deltas over one WebSocket loop — no polling, no fallback ladder',
    href: '/concepts-realtime/',
  },
  {
    title: 'fast bootstrap',
    body: 'precomputed sqlite-image segments; 100k rows in ~30 ms',
    href: '/concepts-bootstrap/',
  },
  {
    title: 'CRDT columns',
    body: 'collaborative text per column, byte-identical across both cores',
    href: '/concepts-crdt/',
  },
  {
    title: 'blobs',
    body: 'content-addressed attachments on S3/R2, re-authorized per download',
    href: '/concepts-blobs/',
  },
  {
    title: 'optional E2EE',
    body: 'per-column AES-256-GCM — the well does not need to read your matter',
    href: '/concepts-encryption/',
  },
  {
    title: 'windowed sync',
    body: 'partial replicas with atomic eviction and a completeness oracle',
    href: '/concepts-windowing/',
  },
  {
    title: 'testkit',
    body: 'in-process server, fault injection, virtual clock — real tests, no mocks',
    href: '/tooling-testing/',
  },
];

const PLATFORM_LINKS: readonly { label: string; href: string }[] = [
  { label: 'WEB', href: '/platform-web/' },
  { label: 'REACT', href: '/platform-react/' },
  { label: 'SWIFT', href: '/platform-swift/' },
  { label: 'KOTLIN', href: '/platform-kotlin/' },
  { label: 'FLUTTER', href: '/platform-flutter/' },
  { label: 'REACT NATIVE', href: '/platform-react-native/' },
  { label: 'TAURI', href: '/platform-tauri/' },
  { label: 'RUST', href: '/platform-rust/' },
  { label: 'C FFI', href: '/platform-ffi/' },
];

const RULE_EQ = '='.repeat(160);
const RULE_DASH = '-'.repeat(160);

function renderTabs(): string {
  const inputs = TABS.map(
    (tab, i) =>
      `<input type="radio" name="platform-tab" id="tab-${tab.id}" class="tab-input tab-input-${tab.id}"${i === 0 ? ' checked' : ''}>`,
  ).join('\n');
  const labels = TABS.map(
    (tab) => `<label for="tab-${tab.id}">[ ${tab.label} ]</label>`,
  ).join('\n');
  const panels = TABS.map(
    (tab) =>
      `<div class="tab-panel tab-panel-${tab.id}"><pre><code>${highlight(tab.code, tab.lang)}</code></pre></div>`,
  ).join('\n');
  return `<div class="tabs">
${inputs}
<div class="tab-labels">${labels}</div>
<div class="tab-panels">${panels}</div>
</div>`;
}

export function renderLanding(): string {
  const features = FEATURES.map(
    (f) => `<p><a href="${f.href}">${f.title}</a> <span>— ${f.body}</span></p>`,
  ).join('\n');
  const platformLinks = PLATFORM_LINKS.map(
    (p) => `<a class="chip" href="${p.href}">${p.label}</a>`,
  ).join('\n');

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
<div class="wrap">
<div class="statusbar">
  <span>SYNCULAR TRANSMISSION // OFFLINE-FIRST SQL SYNC</span>
  <span>SYNC: <span class="ok">NOMINAL</span> · OUTBOX: 0 · LINK: <span class="ok">WS/OK</span></span>
</div>
<header class="topnav">
  <a class="brand" href="/">SYNCULAR<span class="blink">_</span></a>
  <nav>
    <a href="/what-is/">DOCS</a>
    <a href="/demos/">DEMOS</a>
    <a href="https://github.com/syncular/syncular">GITHUB</a>
    <a class="accent" href="/quickstart/">QUICKSTART</a>
  </nav>
</header>
<div class="rule" aria-hidden="true">${RULE_EQ}</div>

<main class="landing">

<section class="hero">
  <div id="hole-wrap" aria-label="Animated ASCII rendering of a black hole accretion disk; labeled commits spiral into the event horizon">
    <pre id="hole"></pre>
    <pre id="hole-glow" aria-hidden="true"></pre>
  </div>
  <div class="fig-row">
    <span>FIG. 1 — SERVER-AUTHORITATIVE COMMIT LOG (LIVE SIMULATION)</span>
    <span><span id="sim-status"></span> <button id="sim-toggle" type="button">[ PAUSE ]</button></span>
  </div>
  <h1>ALL YOUR DATA, DRAWN TO A<br>SINGLE POINT OF TRUTH<span>.</span></h1>
  <p class="sub">syncular is offline-first SQL sync. Local SQLite on every client,
  a server-authoritative commit log at the center, scope-based authorization at
  the horizon. Nothing escapes validation; commits cross in order — on the web
  and natively on iOS, Android, Flutter, React Native, Tauri, and Rust.</p>
  <div class="cta-row">
    <a class="btn primary" href="/quickstart/">[ QUICKSTART — 5 MIN ]</a>
    <a class="btn" href="/demos/">[ LIVE DEMOS ]</a>
  </div>
  <div class="install"><span class="p">$</span> bun create syncular-app my-app <span class="p"># Apache-2.0</span></div>
</section>

<div class="rule" aria-hidden="true">${RULE_DASH}</div>
<section>
  <p class="kicker">TELEMETRY — MEASURED, NOT PROMISED</p>
  <div class="receipt"><pre>BOOTSTRAP 100,000 ROWS ..................... <span class="v">30 ms</span>
REALTIME PROPAGATION (p95) ................. <span class="v">0.2 ms</span>
WEB CLIENT, GZIPPED ........................ <span class="v">19.6 KB</span>
CONFORMANCE SCENARIOS ...................... <span class="v">74 × 2 cores</span></pre></div>
  <p class="lead">Methodology and caveats in the <a href="/benchmarks/">benchmarks</a>.</p>
</section>

<div class="rule" aria-hidden="true">${RULE_EQ}</div>
<section>
  <p class="kicker">SECTION 01</p>
  <h2>ONE ENGINE, YOUR LANGUAGE<span>.</span></h2>
  <p class="lead">The same flow everywhere — create a client, subscribe to a
  scope, write locally, sync. Web clients run the TypeScript core; everything
  else runs the Rust core. Both implement one written protocol and pass the
  same conformance suite.</p>
  ${renderTabs()}
  <div class="chip-row">${platformLinks}</div>
</section>

<div class="rule" aria-hidden="true">${RULE_DASH}</div>
<section>
  <p class="kicker">SECTION 02</p>
  <h2>THE SERVER IS THE GRAVITY WELL<span>.</span></h2>
  <p class="lead">Clients orbit with their own local SQLite — reads and writes
  stay local and instant. Pushes fall toward the commit log, where every change
  is ordered, validated against your scopes, and delivered back to exactly the
  clients allowed to see it. Drift out of contact and the
  <a href="/concepts-conflicts/">outbox</a> holds your writes; re-enter range
  and they replay, in order, against the same log everyone else sees.</p>
  <div class="diagram"><pre>   [ client / sqlite ]          [ client / sqlite ]
             \\  push                    /  pull
              \\                        /
               v                      v
   +----------------------------------------------+
   |  <span class="hi">COMMIT LOG — ordered · validated · scoped</span>   |
   |  <span class="am" id="logticker">c41  c42  c43  c44  c45  c46  c47  &gt;&gt;</span>        |
   +----------------------------------------------+
               ^                      \\
              /  pull                  v  push
   [ client / sqlite ]          [ client / sqlite ]</pre></div>
  <p class="lead">The log is the spine of the protocol:
  <a href="/concepts-commits/">commits, cursors &amp; idempotency</a> ·
  <a href="/concepts-bootstrap/">bootstrap &amp; segments</a> ·
  <a href="/concepts-realtime/">realtime</a>.</p>
</section>

<div class="rule" aria-hidden="true">${RULE_DASH}</div>
<section>
  <p class="kicker">SECTION 03</p>
  <h2>CAPABILITIES, TYPEWRITTEN<span>.</span></h2>
  <div class="feature-list">
${features}
  </div>
</section>

<div class="rule" aria-hidden="true">${RULE_DASH}</div>
<section>
  <p class="kicker">SECTION 04</p>
  <h2>TWO CORES. ONE PHYSICS<span>.</span></h2>
  <p class="lead">One <a href="https://github.com/syncular/syncular/blob/main/SPEC.md">written
  protocol</a> is the law. Two independent cores obey it, held identical by
  golden byte-level vectors and 74 conformance scenarios run against both in
  CI. Divergence is a bug you can point at; a third implementation joins
  against the <a href="/guide-conformance/">spec</a>, not a binary.</p>
  <div class="cores">
    <div class="core">
      <p class="t">CORE A — TYPESCRIPT</p>
      <p class="d">Web (worker + OPFS sqlite-wasm) · React · 19.6 KB gzipped of its own code</p>
    </div>
    <div class="core">
      <p class="t">CORE B — RUST <span style="font-weight:400">(C FFI)</span></p>
      <p class="d">Swift · Kotlin · Flutter · React Native · Tauri · Rust — one JSON command surface</p>
    </div>
  </div>
  <p class="lead">Servers run on <a href="/guide-server/">Bun/Node via Hono</a>
  or <a href="/server-workers/">Cloudflare Workers</a>, storage on
  <a href="/server-storage/">SQLite, Postgres, or D1</a>, segments and blobs on
  S3-compatible stores. Pruning, blob GC, events, and an admin surface are
  <a href="/server-operations/">part of the product</a>.</p>
</section>

<div class="rule" aria-hidden="true">${RULE_EQ}</div>
<section class="fin">
  <p class="big">EVERY WRITE FALLS INTO ONE LOG<span style="color:var(--amber)">.</span></p>
  <div class="install"><span class="p">$</span> bun create syncular-app my-app</div>
  <div class="cta-row">
    <a class="btn primary" href="/quickstart/">[ QUICKSTART ]</a>
    <a class="btn" href="/what-is/">[ READ THE DOCS ]</a>
  </div>
</section>

</main>

<footer class="footer">
  <div class="rule" aria-hidden="true">${RULE_EQ}</div>
  <div class="row">
    <nav>
      <a href="https://github.com/syncular/syncular">GITHUB</a>
      <a href="https://www.npmjs.com/org/syncular">NPM</a>
      <a href="https://crates.io/crates/syncular-client">CRATES.IO</a>
      <a href="/what-is/">DOCS</a>
    </nav>
    <span class="end">SYNCULAR · APACHE-2.0 · END OF TRANSMISSION <span class="sq">■</span></span>
  </div>
</footer>
</div>

<script>
// The one script on the site: the hero's ASCII singularity. Everything else
// on this page — including syntax highlighting — is static, built markup.
(() => {
  const W = 90, H = 40, CX = W / 2, CY = H / 2, ASPECT = 0.55;
  const RAMP = ' .,:;+*#@';
  const main = document.getElementById('hole');
  const glow = document.getElementById('hole-glow');
  const status = document.getElementById('sim-status');
  const toggle = document.getElementById('sim-toggle');
  const hash = (x, y) => {
    const s = Math.sin(x * 127.1 + y * 311.7) * 43758.5453;
    return s - Math.floor(s);
  };

  // Infalling writes: labeled commits spiral across the disk into the log.
  let seq = 41;
  let commits = [];
  let nextSpawn = 0;
  const spawn = (t) => {
    commits.push({
      label: 'c' + seq++,
      a: Math.random() * Math.PI * 2,
      r: 24 + Math.random() * 8,
      born: t,
      speed: 2.4 + Math.random() * 1.6,
    });
  };

  function frame(t) {
    const cell = new Array(W * H).fill(' ');
    const amb = new Array(W * H).fill(' ');
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const dx = (x - CX) * ASPECT, dy = y - CY;
        const r = Math.hypot(dx, dy), a = Math.atan2(dy, dx);
        const i = y * W + x;
        if (r < 5.0) {
          // event horizon: darkness
        } else if (r < 6.6) {
          const p = 0.5 + 0.5 * Math.sin(a * 3 - t * 3.6 + r);
          amb[i] = p > 0.66 ? '@' : p > 0.33 ? '#' : '*';
        } else if (r < 19) {
          const band = (r - 6.6) / 12.4;
          let b = (0.5 + 0.5 * Math.sin(2 * a - r * 1.35 + t * 2.4)) * (1 - band * 0.85);
          b += 0.3 * Math.cos(a - t * 0.9) * (1 - band);
          b += (hash(x, y) - 0.5) * 0.18;
          cell[i] = RAMP[Math.max(0, Math.min(8, Math.floor(b * 9)))];
        } else {
          const h = hash(x * 3.1, y * 7.7);
          if (h > 0.972) cell[i] = Math.sin(t * 1.7 + h * 90) > -0.3 ? (h > 0.994 ? '+' : '.') : ' ';
        }
      }
    }
    for (const c of commits) {
      const age = t - c.born;
      c.rNow = c.r - c.speed * age * (1 + 0.06 * age);
      c.aNow = c.a + 1.7 * Math.log(c.r / Math.max(c.rNow, 1));
      for (let k = 0; k <= 6; k++) {
        const rr = c.rNow + k * 0.8, aa = c.aNow - k * 0.1;
        if (rr < 5 || rr > 34) continue;
        const px = Math.round(CX + (rr * Math.cos(aa)) / ASPECT);
        const py = Math.round(CY + rr * Math.sin(aa));
        if (px < 0 || px >= W || py < 0 || py >= H) continue;
        if (k === 0) {
          amb[py * W + px] = '@';
          for (let l = 0; l < c.label.length; l++) {
            if (px + 2 + l < W) amb[py * W + px + 2 + l] = c.label[l];
          }
        } else {
          cell[py * W + px] = k < 3 ? '*' : k < 5 ? ':' : '.';
        }
      }
    }
    commits = commits.filter((c) => c.rNow > 5.2);
    if (t > nextSpawn) { spawn(t); nextSpawn = t + 1.1 + Math.random() * 1.6; }

    let out = '', amber = '';
    for (let y = 0; y < H; y++) {
      out += cell.slice(y * W, (y + 1) * W).join('') + '\\n';
      amber += amb.slice(y * W, (y + 1) * W).join('') + '\\n';
    }
    main.textContent = out;
    glow.textContent = amber;
    if (status) {
      status.textContent = 'INFALL ' + commits.length +
        ' WRITE' + (commits.length === 1 ? '' : 'S') + ' · NEXT c' + seq;
    }
  }

  let running = true;
  let tick = 0;
  toggle?.addEventListener('click', () => {
    running = !running;
    toggle.textContent = running ? '[ PAUSE ]' : '[ RUN ]';
  });
  frame(0);
  const loop = (now) => {
    if (running && tick++ % 2 === 0) frame(now / 1000);
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
  // Embedded webviews report the page hidden and never fire rAF — a timer
  // keeps the singularity turning wherever it is watched.
  setInterval(() => {
    if (running && document.hidden) frame(performance.now() / 1000);
  }, 66);

  // The commit-log figure ticks forward too — the log only ever appends.
  const ticker = document.getElementById('logticker');
  if (ticker) {
    let n = 47;
    setInterval(() => {
      n++;
      const xs = [];
      for (let k = 6; k >= 0; k--) xs.push('c' + (n - k));
      ticker.textContent = xs.join('  ') + '  >>';
    }, 1300);
  }
})();
</script>
</body>
</html>`;
}
