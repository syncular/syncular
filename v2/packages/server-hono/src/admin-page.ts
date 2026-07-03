/**
 * The single static console page (TODO §2.5). Zero framework, no build
 * step, ~one file: it fetches the sibling JSON endpoints (relative to its
 * own mount path), renders tables, and offers an auto-refresh toggle. This
 * is the v2 answer to v1's full React console app — 5% of the code, the
 * 80% operator value.
 *
 * The HTML is a single exported string so the routes module can serve it
 * with no filesystem read (works identically on Bun, Node, and Workers).
 * All fetches are same-origin and relative ('./clients', …), so the page
 * works under whatever prefix the host mounts the routes at, and the host's
 * `authorize` guard applies to the page's own XHRs (same cookies/headers).
 */
export const ADMIN_CONSOLE_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Syncular console</title>
<style>
  :root {
    --bg: #0f1115; --panel: #171a21; --border: #262b36; --fg: #d7dce5;
    --muted: #8a93a6; --accent: #5b9dff; --ok: #43c17a; --warn: #e0a83a;
    --mono: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace;
    --sans: system-ui, -apple-system, Segoe UI, Roboto, sans-serif;
  }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--fg); font: 14px/1.5 var(--sans); }
  header { display: flex; align-items: center; gap: 16px; flex-wrap: wrap;
    padding: 14px 20px; border-bottom: 1px solid var(--border); background: var(--panel); }
  header h1 { font-size: 15px; margin: 0; font-weight: 600; letter-spacing: .02em; }
  header .spacer { flex: 1; }
  header label { color: var(--muted); font-size: 13px; display: inline-flex; gap: 6px; align-items: center; }
  header input[type=text] { background: var(--bg); border: 1px solid var(--border); color: var(--fg);
    border-radius: 6px; padding: 5px 8px; font: 13px var(--mono); width: 140px; }
  header button { background: var(--bg); border: 1px solid var(--border); color: var(--fg);
    border-radius: 6px; padding: 5px 11px; cursor: pointer; font: 13px var(--sans); }
  header button:hover { border-color: var(--accent); }
  #status { color: var(--muted); font: 12px var(--mono); }
  main { padding: 18px 20px; display: grid; gap: 18px; grid-template-columns: repeat(auto-fit, minmax(420px, 1fr)); }
  section { background: var(--panel); border: 1px solid var(--border); border-radius: 10px; overflow: hidden; }
  section > h2 { font-size: 13px; margin: 0; padding: 10px 14px; border-bottom: 1px solid var(--border);
    font-weight: 600; color: var(--fg); display: flex; justify-content: space-between; align-items: center; }
  section > h2 .count { color: var(--muted); font: 12px var(--mono); font-weight: 400; }
  .body { max-height: 360px; overflow: auto; }
  table { width: 100%; border-collapse: collapse; font: 12px var(--mono); }
  th, td { text-align: left; padding: 6px 10px; border-bottom: 1px solid var(--border); white-space: nowrap; }
  th { color: var(--muted); font-weight: 500; position: sticky; top: 0; background: var(--panel); z-index: 1; }
  td.wrap { white-space: normal; word-break: break-all; }
  tr:hover td { background: #1c212b; }
  .pill { display: inline-block; padding: 1px 7px; border-radius: 999px; font-size: 11px; }
  .pill.ok { background: rgba(67,193,122,.15); color: var(--ok); }
  .pill.warn { background: rgba(224,168,58,.15); color: var(--warn); }
  .pill.idle { background: rgba(138,147,166,.15); color: var(--muted); }
  .kv { display: grid; grid-template-columns: auto 1fr; gap: 4px 14px; padding: 10px 14px; font: 12px var(--mono); }
  .kv dt { color: var(--muted); }
  .empty { color: var(--muted); padding: 14px; font-style: italic; }
  .evt-type { color: var(--accent); }
  .full { grid-column: 1 / -1; }
</style>
</head>
<body>
<header>
  <h1>Syncular console</h1>
  <label>partition
    <input id="partition" type="text" placeholder="(default)" />
  </label>
  <button id="refresh">Refresh</button>
  <label><input id="auto" type="checkbox" /> auto</label>
  <span class="spacer"></span>
  <span id="status">idle</span>
</header>
<main>
  <section><h2>Horizon <span class="count" id="horizon-rec"></span></h2><div class="body" id="horizon"></div></section>
  <section><h2>Store stats</h2><div class="body" id="stats"></div></section>
  <section><h2>Clients <span class="count" id="clients-count"></span></h2><div class="body" id="clients"></div></section>
  <section><h2>Recent commits <span class="count" id="commits-count"></span></h2><div class="body" id="commits"></div></section>
  <section class="full"><h2>Event stream <span class="count" id="events-count"></span></h2><div class="body" id="events"></div></section>
</main>
<script>
(function () {
  var el = function (id) { return document.getElementById(id); };
  var status = el('status');

  function q() {
    var p = el('partition').value.trim();
    return p ? ('?partition=' + encodeURIComponent(p)) : '';
  }
  // The endpoints are siblings of the page under the SAME mount prefix. The
  // page is served at the mount root (…/admin or …/admin/); strip any
  // trailing slash so 'base + /clients' hits '…/admin/clients' regardless of
  // whether the URL had the trailing slash.
  var base = location.pathname.replace(/\\/+$/, '');
  function get(path) {
    return fetch(base + path + q(), { headers: { accept: 'application/json' } })
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
  function table(head, rows) {
    if (!rows.length) return '<div class="empty">none</div>';
    var h = '<table><thead><tr>' + head.map(function (c) { return '<th>' + esc(c) + '</th>'; }).join('') + '</tr></thead><tbody>';
    h += rows.map(function (r) {
      return '<tr>' + r.map(function (c) { return '<td>' + c + '</td>'; }).join('') + '</tr>';
    }).join('');
    return h + '</tbody></table>';
  }

  function renderHorizon(h) {
    el('horizon').innerHTML =
      '<dl class="kv">' +
      '<dt>maxCommitSeq</dt><dd>' + esc(h.maxCommitSeq) + '</dd>' +
      '<dt>horizonSeq</dt><dd>' + esc(h.horizonSeq) + '</dd>' +
      '<dt>retained commits</dt><dd>' + esc(h.retainedCommits) + '</dd>' +
      '<dt>active cursor floor</dt><dd>' + esc(h.activeCursorFloor == null ? 'none' : h.activeCursorFloor) + '</dd>' +
      '<dt>recommended horizon</dt><dd>' + esc(h.recommendedHorizonSeq) + '</dd>' +
      '</dl>';
    var rec = el('horizon-rec');
    if (h.recommendation === 'prune-recommended') {
      rec.innerHTML = '<span class="pill warn">prune recommended</span>';
    } else {
      rec.innerHTML = '<span class="pill ok">up to date</span>';
    }
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
        var pill = c.active ? '<span class="pill ok">active</span>' : '<span class="pill idle">idle</span>';
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
  function renderEvents(res) {
    el('events-count').textContent = res.hasEventStream
      ? (res.events.length + ' events')
      : 'no ring buffer wired';
    if (!res.hasEventStream) { el('events').innerHTML = '<div class="empty">no RingBufferEvents wired on this admin</div>'; return; }
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
    status.textContent = 'loading…';
    Promise.all([
      get('/horizon').then(function (r) { renderHorizon(r.horizon); }),
      get('/stats').then(function (r) { renderStats(r.stats); }),
      get('/clients').then(function (r) { renderClients(r.clients); }),
      get('/commits').then(function (r) { renderCommits(r.commits); }),
      get('/events').then(renderEvents)
    ]).then(function () {
      status.textContent = 'updated ' + new Date().toLocaleTimeString();
    }).catch(function (err) {
      status.textContent = 'error: ' + err.message;
    }).finally(function () { loading = false; });
  }

  el('refresh').addEventListener('click', loadAll);
  el('partition').addEventListener('change', loadAll);
  var timer = null;
  el('auto').addEventListener('change', function () {
    if (this.checked) { timer = setInterval(loadAll, 2000); loadAll(); }
    else if (timer) { clearInterval(timer); timer = null; }
  });
  loadAll();
})();
</script>
</body>
</html>`;
