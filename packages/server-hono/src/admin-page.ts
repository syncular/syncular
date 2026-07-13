/**
 * The single static console page (TODO §2.5). Zero framework, no build
 * step, ~one file: it fetches the sibling JSON endpoints (relative to its
 * own mount path), renders tables, and offers an auto-refresh toggle —
 * 5% of the code a full console app would cost, the 80% operator value.
 *
 * Styling follows docs/DESIGN.md (the teletype theme): everything
 * monospace, pure black, a single amber accent, 1px borders, sharp
 * corners, bracketed labels, inverse-video hover. The page ships as one
 * self-contained string, so it uses the system mono fallback stack.
 *
 * The HTML is a single exported string so the routes module can serve it
 * with no filesystem read (works identically on Bun, Node, and Workers).
 * All fetches are same-origin and relative ('./clients', …), so the page
 * works under whatever prefix the host mounts the routes at, and the host's
 * `authorize` guard applies to the page's own XHRs (same cookies/headers).
 *
 * Panels cover the whole read surface: horizon, store stats, clients,
 * commits (with a table filter), the row inspector (`/rows/:table/:rowId`),
 * scope activity (`/scope-activity`), and the event tail (with a type
 * filter).
 */
export const ADMIN_CONSOLE_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Syncular console</title>
<style>
  :root {
    --void: #000000; --panel: #0a0908; --ink: #f4efe4; --dim: #9a948a;
    --faint: #756f64; --border: rgba(154,148,138,.35);
    --border-strong: rgba(154,148,138,.6); --amber: #ffb000;
    --mono: 'IBM Plex Mono', ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  }
  * { box-sizing: border-box; }
  ::selection { background: var(--amber); color: #000; }
  body { margin: 0; background: var(--void); color: var(--ink); font: 14px/1.6 var(--mono); }
  @keyframes blink { 50% { opacity: 0; } }
  .blink { animation: blink 1.1s steps(1) infinite; color: var(--amber); }
  @media (prefers-reduced-motion: reduce) { .blink { animation: none; } }

  header { display: flex; align-items: center; gap: 1rem; flex-wrap: wrap;
    padding: .8rem 1.25rem; border-bottom: 1px solid var(--border); }
  header h1 { font-size: .85rem; margin: 0; font-weight: 700; letter-spacing: .18em; }
  header h1 .d { color: var(--faint); }
  header .spacer { flex: 1; }
  header label { color: var(--dim); font-size: .68rem; letter-spacing: .1em;
    text-transform: uppercase; display: inline-flex; gap: .5rem; align-items: center; }
  input[type=text] { background: var(--void); border: 1px solid var(--border); color: var(--ink);
    border-radius: 0; padding: .3rem .5rem; font: .78rem var(--mono); }
  input[type=text]:focus { outline: none; border-color: var(--amber); }
  input[type=text]::placeholder { color: var(--faint); }
  button { background: var(--void); border: 1px solid var(--ink); color: var(--ink);
    border-radius: 0; padding: .3rem .7rem; cursor: pointer;
    font: .72rem var(--mono); letter-spacing: .06em; }
  button:hover { background: var(--ink); color: #000; }
  button.primary { border-color: var(--amber); color: var(--amber); }
  button.primary:hover { background: var(--amber); color: #000; }
  button.on { background: var(--amber); border-color: var(--amber); color: #000; }
  #status { color: var(--dim); font-size: .68rem; letter-spacing: .08em; text-transform: uppercase; }
  #status.err { color: var(--amber); }

  main { padding: 1.25rem; display: grid; gap: 1.2rem;
    grid-template-columns: repeat(auto-fit, minmax(420px, 1fr)); }
  section { border: 1px solid var(--border); background: var(--void); position: relative; }
  section::before, section::after { color: var(--faint); position: absolute; font-size: .72rem; }
  section::before { content: '+'; top: -0.6em; left: -0.28em; }
  section::after { content: '+'; bottom: -0.6em; right: -0.28em; }
  section > h2 { font-size: .72rem; margin: 0; padding: .55rem .9rem;
    border-bottom: 1px solid var(--border); font-weight: 400; color: var(--faint);
    letter-spacing: .12em; text-transform: uppercase;
    display: flex; justify-content: space-between; align-items: center; gap: .6rem; }
  section > h2 .count { color: var(--dim); letter-spacing: .04em; }
  .tools { display: flex; gap: .5rem; padding: .55rem .9rem; flex-wrap: wrap;
    border-bottom: 1px solid var(--border); }
  .tools input { flex: 1; min-width: 8rem; }
  .body { max-height: 360px; overflow: auto; }

  table { width: 100%; border-collapse: collapse; font-size: .78rem; }
  th, td { text-align: left; padding: .35rem .9rem; border-bottom: 1px solid var(--border);
    white-space: nowrap; vertical-align: top; }
  th { color: var(--dim); font-weight: 700; font-size: .68rem; letter-spacing: .06em;
    text-transform: uppercase; position: sticky; top: 0; background: var(--panel); z-index: 1; }
  td.wrap, .wrap { white-space: normal; word-break: break-all; }
  tr:hover td { background: var(--panel); }

  .chip { font-size: .68rem; letter-spacing: .06em; text-transform: uppercase; color: var(--dim); }
  .chip::before { content: '[ '; color: var(--faint); }
  .chip::after { content: ' ]'; color: var(--faint); }
  .chip.ok { color: var(--amber); }
  .chip.warn { background: var(--amber); color: #000; }
  .chip.warn::before, .chip.warn::after { color: #000; }

  .kv { display: grid; grid-template-columns: auto 1fr; gap: .2rem .9rem;
    padding: .6rem .9rem; font-size: .78rem; margin: 0; }
  .kv dt { color: var(--dim); }
  .kv dd { margin: 0; }
  .kv .v { color: var(--amber); }
  .empty { color: var(--faint); padding: .8rem .9rem; font-style: italic; font-size: .78rem; }
  .evt-type { color: var(--amber); }
  .full { grid-column: 1 / -1; }

  footer { display: flex; justify-content: space-between; gap: 1rem; flex-wrap: wrap;
    padding: .8rem 1.25rem 1.4rem; color: var(--faint); font-size: .68rem; letter-spacing: .1em; }
  .rule { color: var(--faint); font-size: .72rem; white-space: nowrap; overflow: hidden;
    user-select: none; padding: 0 1.25rem; }
  footer .sq { color: var(--amber); }
</style>
</head>
<body>
<header>
  <h1>SYNCULAR<span class="d"> · </span>CONSOLE<span class="blink">_</span></h1>
  <label>partition
    <input id="partition" type="text" placeholder="(default)" />
  </label>
  <button id="refresh" class="primary">[ REFRESH ]</button>
  <button id="auto">[ AUTO OFF ]</button>
  <span class="spacer"></span>
  <span id="status">idle</span>
</header>
<main>
  <section><h2>── horizon <span class="count" id="horizon-rec"></span></h2><div class="body" id="horizon"></div></section>
  <section><h2>── store stats</h2><div class="body" id="stats"></div></section>
  <section><h2>── clients <span class="count" id="clients-count"></span></h2><div class="body" id="clients"></div></section>
  <section>
    <h2>── commits <span class="count" id="commits-count"></span></h2>
    <div class="tools"><input id="commits-filter" type="text" placeholder="filter by table" /></div>
    <div class="body" id="commits"></div>
  </section>
  <section>
    <h2>── row inspector</h2>
    <div class="tools">
      <input id="inspect-table" type="text" placeholder="table" />
      <input id="inspect-row" type="text" placeholder="rowId" />
      <button id="inspect-go">[ INSPECT ]</button>
    </div>
    <div class="body" id="inspect"></div>
  </section>
  <section>
    <h2>── scope activity <span class="count" id="scope-count"></span></h2>
    <div class="tools">
      <input id="scope-variable" type="text" placeholder="variable e.g. project" />
      <input id="scope-value" type="text" placeholder="value e.g. p1" />
      <button id="scope-go">[ QUERY ]</button>
    </div>
    <div class="body" id="scope"></div>
  </section>
  <section class="full">
    <h2>── event stream <span class="count" id="events-count"></span></h2>
    <div class="tools"><input id="events-filter" type="text" placeholder="filter by type e.g. push.applied" /></div>
    <div class="body" id="events"></div>
  </section>
</main>
<div class="rule">================================================================================================================================================================</div>
<footer>
  <span>SYNCULAR · ADMIN</span>
  <span>END OF TRANSMISSION <span class="sq">■</span></span>
</footer>
<script>
(function () {
  var el = function (id) { return document.getElementById(id); };
  var status = el('status');

  // The endpoints are siblings of the page under the SAME mount prefix. The
  // page is served at the mount root (…/admin or …/admin/); strip any
  // trailing slash so 'base + /clients' hits '…/admin/clients' regardless of
  // whether the URL had the trailing slash.
  var base = location.pathname.replace(/\\/+$/, '');
  function get(path, params) {
    var parts = [];
    var p = el('partition').value.trim();
    if (p) parts.push('partition=' + encodeURIComponent(p));
    if (params) Object.keys(params).forEach(function (k) {
      var v = params[k];
      if (v !== undefined && v !== null && v !== '') {
        parts.push(k + '=' + encodeURIComponent(v));
      }
    });
    var qs = parts.length ? '?' + parts.join('&') : '';
    return fetch(base + path + qs, { headers: { accept: 'application/json' } })
      .then(function (r) {
        if (!r.ok) return r.json().then(function (b) { throw new Error(b.code || ('HTTP ' + r.status)); });
        return r.json();
      });
  }
  function esc(v) {
    return String(v == null ? '' : v)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }
  function ago(ms) {
    var d = Date.now() - ms;
    if (d < 0) d = 0;
    if (d < 1000) return d + 'ms';
    if (d < 60000) return Math.round(d / 1000) + 's';
    if (d < 3600000) return Math.round(d / 60000) + 'm';
    return Math.round(d / 3600000) + 'h';
  }
  function bytes(n) {
    if (n == null) return '-';
    if (n < 1024) return n + ' B';
    if (n < 1048576) return (n / 1024).toFixed(1) + ' KiB';
    return (n / 1048576).toFixed(1) + ' MiB';
  }
  function empty(text) { return '<div class="empty">— ' + esc(text || 'none') + ' —</div>'; }
  function table(head, rows) {
    if (!rows.length) return empty('none');
    var h = '<table><thead><tr>' + head.map(function (c) { return '<th>' + esc(c) + '</th>'; }).join('') + '</tr></thead><tbody>';
    h += rows.map(function (r) {
      return '<tr>' + r.map(function (c) { return '<td>' + c + '</td>'; }).join('') + '</tr>';
    }).join('');
    return h + '</tbody></table>';
  }
  function chip(text, cls) { return '<span class="chip ' + cls + '">' + esc(text) + '</span>'; }

  function renderHorizon(h) {
    el('horizon').innerHTML =
      '<dl class="kv">' +
      '<dt>maxCommitSeq</dt><dd class="v">' + esc(h.maxCommitSeq) + '</dd>' +
      '<dt>horizonSeq</dt><dd class="v">' + esc(h.horizonSeq) + '</dd>' +
      '<dt>retained commits</dt><dd>' + esc(h.retainedCommits) + '</dd>' +
      '<dt>active cursor floor</dt><dd>' + esc(h.activeCursorFloor == null ? 'none' : h.activeCursorFloor) + '</dd>' +
      '<dt>recommended horizon</dt><dd>' + esc(h.recommendedHorizonSeq) + '</dd>' +
      '</dl>';
    el('horizon-rec').innerHTML = h.recommendation === 'prune-recommended'
      ? chip('prune recommended', 'warn')
      : chip('up to date', 'ok');
  }
  function renderStats(s) {
    var seg = s.segments, blob = s.blobs;
    var rows = '<dl class="kv">';
    if (seg) {
      rows += '<dt>segments</dt><dd>' + esc(seg.count) + ' (' + bytes(seg.bytes) + ')</dd>' +
        '<dt>&nbsp;rows / sqlite</dt><dd>' + esc(seg.rowsSegments) + ' / ' + esc(seg.sqliteSegments) + '</dd>';
    } else { rows += '<dt>segments</dt><dd>n/a</dd>'; }
    if (blob) {
      rows += '<dt>blobs</dt><dd>' + esc(blob.count) + ' (' + bytes(blob.bytes) + ')</dd>';
    } else { rows += '<dt>blobs</dt><dd>n/a</dd>'; }
    el('stats').innerHTML = rows + '</dl>';
  }
  function renderClients(list) {
    el('clients-count').textContent = list.length + ' known';
    el('clients').innerHTML = table(['client', 'actor', 'cursor', 'seen', 'subs', ''],
      list.map(function (c) {
        var pill = c.active ? chip('active', 'ok') : chip('idle', '');
        return [esc(c.clientId), esc(c.actorId), esc(c.cursor), ago(c.updatedAtMs), esc(c.subscriptions.length), pill];
      }));
  }
  function renderCommits(list) {
    el('commits-count').textContent = list.length + ' shown';
    el('commits').innerHTML = table(['seq', 'actor', 'client', 'changes', 'tables', 'when'],
      list.map(function (c) {
        return [esc(c.commitSeq), esc(c.actorId), esc(c.clientId), esc(c.changeCount),
          '<span class="wrap">' + esc(c.tables.join(', ')) + '</span>', ago(c.createdAtMs)];
      }));
  }
  function renderInspection(row) {
    var h = '<dl class="kv">' +
      '<dt>table</dt><dd>' + esc(row.table) + '</dd>' +
      '<dt>rowId</dt><dd>' + esc(row.rowId) + '</dd>' +
      '<dt>exists</dt><dd>' + (row.exists ? chip('yes', 'ok') : chip('no', '')) + '</dd>';
    if (row.exists) {
      h += '<dt>server_version</dt><dd class="v">' + esc(row.serverVersion) + '</dd>' +
        '<dt>scopes</dt><dd class="wrap">' + esc(JSON.stringify(row.scopes)) + '</dd>';
      if (row.referencedBlobIds) {
        h += '<dt>blob refs</dt><dd class="wrap">' + esc(row.referencedBlobIds.join(', ') || 'none') + '</dd>';
      }
    }
    el('inspect').innerHTML = h + '</dl>';
  }
  function renderScope(list) {
    el('scope-count').textContent = list.length + ' shown';
    el('scope').innerHTML = table(['seq', 'table', 'actor', 'changes', 'when'],
      list.map(function (a) {
        return [esc(a.commitSeq), esc(a.table), esc(a.actorId), esc(a.changeCount), ago(a.createdAtMs)];
      }));
  }
  function renderEvents(res) {
    el('events-count').textContent = res.hasEventStream
      ? (res.events.length + ' events')
      : 'no ring buffer wired';
    if (!res.hasEventStream) { el('events').innerHTML = empty('no RingBufferEvents wired on this admin'); return; }
    el('events').innerHTML = table(['when', 'type', 'detail'],
      res.events.map(function (e) {
        var detail = Object.keys(e)
          .filter(function (k) { return k !== 'type' && k !== 'atMs'; })
          .map(function (k) { return k + '=' + JSON.stringify(e[k]); })
          .join(' ');
        return [ago(e.atMs), '<span class="evt-type">' + esc(e.type) + '</span>',
          '<span class="wrap">' + esc(detail) + '</span>'];
      }));
  }

  var loading = false;
  function loadAll() {
    if (loading) return;
    loading = true;
    status.className = '';
    status.textContent = 'loading…';
    Promise.all([
      get('/horizon').then(function (r) { renderHorizon(r.horizon); }),
      get('/stats').then(function (r) { renderStats(r.stats); }),
      get('/clients').then(function (r) { renderClients(r.clients); }),
      get('/commits', { table: el('commits-filter').value.trim() }).then(function (r) { renderCommits(r.commits); }),
      get('/events', { type: el('events-filter').value.trim() }).then(renderEvents)
    ]).then(function () {
      status.textContent = 'updated ' + new Date().toLocaleTimeString();
    }).catch(function (err) {
      status.className = 'err';
      status.textContent = 'error: ' + err.message;
    }).finally(function () { loading = false; });
  }

  function inspect() {
    var t = el('inspect-table').value.trim();
    var id = el('inspect-row').value.trim();
    if (!t || !id) { el('inspect').innerHTML = empty('table and rowId required'); return; }
    get('/rows/' + encodeURIComponent(t) + '/' + encodeURIComponent(id))
      .then(function (r) { renderInspection(r.row); })
      .catch(function (err) { el('inspect').innerHTML = empty('error: ' + err.message); });
  }
  function scopeQuery() {
    var variable = el('scope-variable').value.trim();
    var value = el('scope-value').value.trim();
    if (!variable || !value) { el('scope').innerHTML = empty('variable and value required'); return; }
    get('/scope-activity', { variable: variable, value: value })
      .then(function (r) { renderScope(r.activity); })
      .catch(function (err) { el('scope').innerHTML = empty('error: ' + err.message); });
  }
  function onEnter(id, fn) {
    el(id).addEventListener('keydown', function (e) { if (e.key === 'Enter') fn(); });
  }

  el('refresh').addEventListener('click', loadAll);
  el('partition').addEventListener('change', loadAll);
  el('commits-filter').addEventListener('change', loadAll);
  el('events-filter').addEventListener('change', loadAll);
  el('inspect-go').addEventListener('click', inspect);
  onEnter('inspect-table', inspect);
  onEnter('inspect-row', inspect);
  el('scope-go').addEventListener('click', scopeQuery);
  onEnter('scope-variable', scopeQuery);
  onEnter('scope-value', scopeQuery);
  var timer = null;
  el('auto').addEventListener('click', function () {
    if (timer) {
      clearInterval(timer); timer = null;
      this.classList.remove('on'); this.textContent = '[ AUTO OFF ]';
    } else {
      timer = setInterval(loadAll, 2000);
      this.classList.add('on'); this.textContent = '[ AUTO ON ]';
      loadAll();
    }
  });
  loadAll();
})();
</script>
</body>
</html>`;
