/**
 * The single static console page: no framework, no build step, one file.
 * It fetches the sibling JSON endpoints (relative to its own mount path)
 * and renders them in eight views: Overview, Clients, Commits, Rows,
 * Scopes, Events, Reactions, and Storage. Each view loads only the
 * endpoints it shows, so a refresh on one view costs one to five reads.
 *
 * Styling follows docs/STYLE.md and the docs shell: pure black, one amber
 * accent with phosphor/red status colors, hairline borders, square corners.
 * The page ships as one self-contained string with no network fetches, so
 * it uses the system font stacks (monospace for data, sans for prose); a
 * host with IBM Plex installed renders in Plex.
 *
 * The HTML is a single exported string so the routes module can serve it
 * with no filesystem read (works identically on Bun, Node, and Workers).
 * All fetches are same-origin and relative ('./clients', …), so the page
 * works under whatever prefix the host mounts the routes at, and the host's
 * `authorize` guard applies to the page's own XHRs (same cookies/headers).
 * `?transport=parent` sends the same route paths to a same-origin parent
 * frame. Static demos can reuse this page while their admin routes run in a
 * Web Worker.
 *
 * The event tail is live over SSE (`/events/stream`) when the ring is wired.
 * The parent transport carries no stream, and an SSE failure closes the
 * stream for good; both states poll `/events` on every refresh and say so
 * in the header and the Events view.
 */
export const ADMIN_CONSOLE_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="color-scheme" content="dark" />
<title>Syncular console</title>
<link rel="icon" href="data:," />
<style>
:root{--void:#000;--panel:#0a0908;--raised:#12110f;--ink:#f4efe4;--dim:#9a948a;--faint:#756f64;--line:rgba(154,148,138,.22);--line-strong:rgba(154,148,138,.45);--amber:#ffb000;--phos:#a9bf6e;--cyan:#6fb3c0;--sand:#e3d3a2;--red:#ff7a59;
--mono:'IBM Plex Mono',ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;--sans:'IBM Plex Sans',ui-sans-serif,system-ui,-apple-system,'Segoe UI',sans-serif;color-scheme:dark}
*{box-sizing:border-box}
body{margin:0;height:100vh;display:flex;flex-direction:column;background:var(--void);color:var(--ink);font:13px/1.5 var(--mono);-webkit-font-smoothing:antialiased}
::selection{background:var(--amber);color:#000}
:focus-visible{outline:2px solid var(--amber);outline-offset:2px}
button,input,select{font:inherit;color:inherit}
button{cursor:pointer}
[hidden]{display:none!important}
.field label,.btn,.pill,.side a,.kicker,.ph h2,.kpi .l,.verdict b,.kv dt,h3,.dt th,.st,.empty b,.banner b,.sugg,.seg button,.dt td::before{text-transform:uppercase}
code{font-family:var(--mono);font-size:.92em;color:var(--sand)}
.sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
.skip{position:absolute;left:8px;top:-40px;z-index:50;background:var(--amber);color:#000;padding:6px 10px}
.skip:focus{top:8px}
.dim{color:var(--dim)}

.top{flex:none;display:flex;align-items:center;flex-wrap:wrap;gap:8px 12px;min-height:56px;padding:8px 20px;border-bottom:1px solid var(--line);background:var(--void)}
.brand{display:flex;align-items:center;gap:10px;font-weight:600;font-size:13px;letter-spacing:.22em;white-space:nowrap;margin-right:6px}
.brand svg{width:20px;height:20px;flex:none}
.brand .sl{color:var(--faint);font-weight:400;letter-spacing:0}
.brand .sub{color:var(--amber);font-weight:500;letter-spacing:.14em}
.field{display:flex;align-items:stretch;height:32px;border:1px solid var(--line-strong);background:var(--void)}
.field:focus-within{border-color:var(--amber)}
.field label{display:flex;align-items:center;padding:0 9px;border-right:1px solid var(--line);font-size:10.5px;letter-spacing:.16em;color:var(--dim)}
.field input{width:13rem;min-width:0;border:0;outline:0;background:none;padding:0 10px;font-size:12px}
input::placeholder{color:var(--faint)}
.grow{flex:1}
.btn{height:32px;padding:0 12px;border:1px solid var(--line-strong);background:var(--void);font-size:11px;letter-spacing:.12em;white-space:nowrap;transition:border-color .15s,background .15s,color .15s}
.btn:hover{border-color:var(--ink)}
.btn.amber{background:var(--amber);border-color:var(--amber);color:#000;font-weight:600}
.btn.amber:hover{background:#ffc233;border-color:#ffc233}
.btn.on{border-color:var(--amber);color:var(--amber)}
.btn.sm{height:26px;padding:0 9px;font-size:10.5px}
.btn.sq{width:32px;padding:0}
.pill{display:inline-flex;align-items:center;gap:7px;height:26px;padding:0 9px;border:1px solid var(--line);font-size:10.5px;letter-spacing:.14em;color:var(--dim);white-space:nowrap}
.pill i{width:7px;height:7px;background:currentColor}
.pill.ok{color:var(--phos);border-color:rgba(169,191,110,.45)}
.pill.ok i{animation:pulse 1.6s ease-in-out infinite}
.pill.warn{color:var(--amber);border-color:rgba(255,176,0,.6)}
.pill.err{color:var(--red);border-color:var(--red)}
@keyframes pulse{50%{opacity:.25}}
#updated{font-size:11px;color:var(--dim);white-space:nowrap}
#updated.err{color:var(--red)}

.shell{flex:1;min-height:0;display:grid;grid-template-columns:208px minmax(0,1fr)}
.side{overflow:auto;border-right:1px solid var(--line);padding:12px 0}
.side a{display:flex;align-items:center;gap:10px;padding:9px 16px;border-left:2px solid transparent;color:var(--dim);text-decoration:none;font-size:11.5px;letter-spacing:.14em;white-space:nowrap}
.side a b{font-weight:400;font-size:10.5px;color:var(--faint)}
.side a .n{margin-left:auto;font-size:10.5px;letter-spacing:0;color:var(--faint)}
.side a:hover{color:var(--ink)}
.side a[aria-current=page]{color:var(--ink);border-left-color:var(--amber);background:linear-gradient(90deg,rgba(255,176,0,.09),transparent)}
.side a[aria-current=page] b{color:var(--amber)}
.side .foot{margin-top:12px;padding:12px 16px;border-top:1px solid var(--line);font-size:10.5px;letter-spacing:.06em;color:var(--faint);line-height:1.8}
kbd{display:inline-block;min-width:18px;padding:0 4px;border:1px solid var(--line-strong);font:10.5px/16px var(--mono);text-align:center;color:var(--ink)}
main{min-width:0;overflow:auto;padding:20px 24px 40px}
main:focus{outline:0}

.vh{margin-bottom:16px}
.kicker{margin:0;font-size:10.5px;letter-spacing:.18em;color:var(--amber)}
h1{margin:4px 0 0;font-size:20px;line-height:1.25;font-weight:600;letter-spacing:-.01em;overflow-wrap:anywhere}
h1 .dot{color:var(--amber)}
.lede{margin:6px 0 0;max-width:46rem;font:13.5px/1.6 var(--sans);color:var(--dim)}
.panel{position:relative;min-width:0;border:1px solid var(--line);background:var(--panel)}
.panel+.panel{margin-top:14px}
.ph{display:flex;align-items:center;gap:10px;min-height:38px;padding:0 14px;border-bottom:1px solid var(--line)}
.ph h2{margin:0;font-size:10.5px;font-weight:500;letter-spacing:.18em;color:var(--dim);white-space:nowrap}
.ph .meta{margin-left:auto;font-size:10.5px;color:var(--faint);text-align:right;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.pb{padding:14px}
.fig::before,.fig::after{content:'';position:absolute;width:9px;height:9px;border:0 solid var(--amber);pointer-events:none}
.fig::before{top:-1px;left:-1px;border-top-width:1px;border-left-width:1px}
.fig::after{bottom:-1px;right:-1px;border-bottom-width:1px;border-right-width:1px}
.ov{display:grid;gap:14px;grid-template-columns:repeat(3,minmax(0,1fr))}
.ov .panel+.panel{margin-top:0}
.span2{grid-column:span 2}
.span3{grid-column:1/-1}
.cols{display:grid;gap:14px;grid-template-columns:repeat(auto-fit,minmax(300px,1fr))}
.cols .panel+.panel{margin-top:0}

.kpis{display:grid;grid-template-columns:repeat(6,minmax(0,1fr));border-top:1px solid var(--line);border-left:1px solid var(--line);margin-bottom:14px}
.kpi{min-width:0;padding:12px 14px 12px;border-right:1px solid var(--line);border-bottom:1px solid var(--line);background:var(--panel)}
.kpi .l{font-size:10px;letter-spacing:.16em;color:var(--dim);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.kpi .v{margin-top:6px;font-size:24px;line-height:1.15;font-weight:500;font-variant-numeric:tabular-nums;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.big{font-size:24px;line-height:1.15;font-weight:500;font-variant-numeric:tabular-nums}
.kpi .v small,.big small{margin-left:4px;font-size:11.5px;font-weight:400;color:var(--dim)}
.kpi .s{margin-top:3px;font-size:11px;color:var(--dim);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.kpi .viz{height:26px;margin-top:10px;display:flex;align-items:flex-end}
.kpi .viz svg{display:block;width:100%;height:26px}
.kpi.warn .v{color:var(--amber)}
.kpi.bad .v{color:var(--red)}
.stack{display:flex;width:100%;height:6px;background:var(--line)}
.stack b{display:block;height:100%}
.c-ok{background:var(--phos)}.c-am{background:var(--amber)}.c-err{background:var(--red)}.c-dim{background:rgba(154,148,138,.45)}.c-cy{background:var(--cyan)}
.bar{fill:var(--amber)}.bar.r{fill:var(--red)}.bar.z{fill:var(--line-strong)}

.chart{position:relative}
.chart svg{display:block;width:100%;height:190px}
.chart .grid{stroke:var(--line);stroke-width:1}
.chart g:hover .hit{fill:rgba(255,176,0,.1)}
.axis{display:flex;justify-content:space-between;margin-top:6px;font-size:10px;color:var(--faint)}
.ymax{position:absolute;top:-2px;left:0;font-size:10px;color:var(--faint);background:var(--panel);padding-right:6px}
.legend{display:flex;flex-wrap:wrap;gap:6px 16px;margin-top:12px;font-size:10.5px;letter-spacing:.06em;color:var(--dim)}
.legend i{display:inline-block;width:8px;height:8px;margin-right:6px;vertical-align:-1px}
.legend .r{margin-left:auto}

.gauge{position:relative;display:flex;height:28px;margin:24px 0 8px;border:1px solid var(--line-strong);background:var(--void)}
.gauge i{display:block;height:100%}
.g-pruned{background:repeating-linear-gradient(135deg,rgba(154,148,138,.22) 0 3px,transparent 3px 7px)}
.g-prunable{background:repeating-linear-gradient(135deg,rgba(255,176,0,.55) 0 3px,rgba(255,176,0,.12) 3px 7px)}
.g-retained{background:rgba(255,176,0,.2);box-shadow:inset 0 0 0 1px rgba(255,176,0,.45)}
.mark{position:absolute;top:-7px;bottom:-7px;width:0;border-left:1px dashed var(--cyan)}
.mark span{position:absolute;bottom:100%;margin-bottom:2px;font-size:10px;color:var(--cyan);white-space:nowrap;transform:translateX(-50%)}
.mark.l span{transform:none}.mark.e span{transform:translateX(-100%)}
.gscale{display:flex;justify-content:space-between;font-size:10.5px;color:var(--dim)}
.verdict{margin:14px 0 0;font:13px/1.55 var(--sans);color:var(--dim)}
.verdict b{font:600 10.5px var(--mono);letter-spacing:.14em;margin-right:8px}

.kv{display:grid;grid-template-columns:max-content minmax(0,1fr);gap:7px 18px;margin:0;font-size:12px}
.kv dt{padding-top:1px;font-size:10.5px;letter-spacing:.12em;color:var(--dim);white-space:nowrap}
.kv dd{margin:0;min-width:0;overflow-wrap:anywhere;font-variant-numeric:tabular-nums}
.kv+.kv,.kv+h3,.tw+h3,.empty+h3,pre+h3{margin-top:18px}
.mb h3:not(:first-child),.verdict+.kv{margin-top:20px}
h3{margin:0 0 8px;font-size:10.5px;font-weight:500;letter-spacing:.18em;color:var(--dim)}
.hist{display:grid;grid-template-columns:max-content minmax(0,1fr) max-content;gap:9px 12px;align-items:center;font-size:11.5px}
.hist .lb{color:var(--dim)}
.hist .tr{display:flex;height:12px;background:var(--void);border:1px solid var(--line)}
.hist .tr b{display:block;height:100%}
.hist .ct{text-align:right;font-variant-numeric:tabular-nums}

.tb{display:flex;flex-wrap:wrap;align-items:center;gap:8px;padding:10px 14px;border-bottom:1px solid var(--line)}
.inp{height:30px;min-width:0;padding:0 10px;border:1px solid var(--line-strong);border-radius:0;background:var(--void);font-size:12px}
.inp:focus{outline:0;border-color:var(--amber)}
select.inp{padding-right:4px}
.tb .grow{flex:1 1 12rem}
.chk{display:inline-flex;align-items:center;gap:6px;font-size:11px;letter-spacing:.06em;color:var(--dim);white-space:nowrap}
.chk input{accent-color:var(--amber)}
.count{margin-left:auto;font-size:11px;color:var(--faint);white-space:nowrap}

.tw{overflow:auto;max-height:calc(100vh - 250px)}
.tw.short{max-height:none}
.dt{width:100%;border-collapse:separate;border-spacing:0;font-size:12px;font-variant-numeric:tabular-nums}
.dt th{position:sticky;top:0;z-index:1;padding:0;background:var(--raised);border-bottom:1px solid var(--line-strong);text-align:left;font-weight:500;font-size:10.5px;letter-spacing:.12em;color:var(--dim);white-space:nowrap}
.dt th>span,.dt th>button{display:flex;align-items:center;gap:6px;width:100%;padding:8px 12px;border:0;background:none;color:inherit;font:inherit;letter-spacing:inherit;text-transform:inherit;text-align:inherit}
.dt th.num>button,.dt th.num>span{justify-content:flex-end}
.dt th>button:hover{color:var(--ink)}
.dt th>button::after{content:'↕';color:var(--faint);font-size:10px}
.dt th[aria-sort=ascending]>button::after{content:'↑';color:var(--amber)}
.dt th[aria-sort=descending]>button::after{content:'↓';color:var(--amber)}
.dt td{padding:7px 12px;border-bottom:1px solid var(--line);white-space:nowrap;vertical-align:middle}
.dt tbody tr:last-child td{border-bottom:0}
.dt tr[data-i]{cursor:pointer}
.dt tbody tr:hover td{background:rgba(255,176,0,.045)}
.dt tr[data-i]:focus-visible{outline:2px solid var(--amber);outline-offset:-2px}
.dt tr.cur td{background:rgba(255,176,0,.07)}
.dt .num{text-align:right}
.dt td.fill{width:100%;max-width:0}
.trunc{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.id{display:inline-flex;align-items:center;gap:4px;max-width:100%;min-width:0;vertical-align:middle}
.id>span{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.w-id .id>span{max-width:38ch}
.w-sm .id>span{max-width:20ch}
.cp{flex:none;display:inline-grid;place-items:center;width:20px;height:20px;padding:0;border:1px solid transparent;background:none;color:var(--faint);opacity:0}
.cp svg{width:12px;height:12px}
tr:hover .cp,.cp:focus-visible,.kv .cp,.mh .cp{opacity:1}
.cp:hover{color:var(--amber);border-color:var(--line-strong)}
@media (hover:none){.cp{opacity:1}}
.tags{display:flex;flex-wrap:wrap;gap:4px;white-space:normal}
.tag{padding:0 6px;border:1px solid var(--line-strong);font-size:10.5px;line-height:18px;white-space:nowrap}
button.tag{background:none;cursor:pointer}
button.tag:hover{border-color:var(--amber);color:var(--amber)}
.st{display:inline-flex;align-items:center;gap:6px;font-size:10.5px;letter-spacing:.12em;white-space:nowrap;color:var(--dim)}
.st::before{content:'';width:6px;height:6px;background:currentColor}
.st.ok{color:var(--phos)}.st.warn{color:var(--amber)}.st.err{color:var(--red)}.st.idle{color:var(--faint)}
.lag{display:inline-flex;align-items:center;gap:8px}
.lag i{display:block;width:44px;height:4px;background:var(--line)}
.lag i b{display:block;height:100%;background:var(--amber)}
.lag.z{color:var(--dim)}
.ty{color:var(--amber)}
.ty.err{color:var(--red)}
.ty.info{color:var(--ink)}

.empty{padding:28px 18px;text-align:center;font:13px/1.6 var(--sans);color:var(--dim)}
.empty b{display:block;margin-bottom:6px;font:500 11px var(--mono);letter-spacing:.16em;color:var(--ink)}
.empty.sm{padding:16px 14px}
.errbox{margin:14px;padding:10px 12px;border:1px solid var(--red);border-left-width:3px;background:rgba(255,122,89,.06);font-size:12px}
.errbox code{color:var(--red);font-weight:600;font-size:12px}
.errbox .hs{margin-left:8px;font-size:10.5px;color:var(--dim)}
.errbox p{margin:5px 0 0;font:12.5px/1.55 var(--sans);color:var(--dim)}
.skel{padding:14px}
.skel i{display:block;height:11px;margin:9px 0;background:linear-gradient(90deg,var(--raised),#201d18,var(--raised));background-size:200% 100%;animation:shimmer 1.4s linear infinite}
.skel i:nth-child(2){width:82%}.skel i:nth-child(3){width:64%}
@keyframes shimmer{to{background-position:-200% 0}}
.banner{display:flex;flex-wrap:wrap;align-items:center;gap:8px 12px;margin-bottom:14px;padding:10px 14px;border:1px solid rgba(255,176,0,.6);border-left-width:3px;background:rgba(255,176,0,.05);font:12.5px/1.55 var(--sans);color:var(--dim)}
.banner b{font:600 10.5px var(--mono);letter-spacing:.14em;color:var(--amber)}
.banner.err{border-color:var(--red);background:rgba(255,122,89,.06)}
.banner.err b{color:var(--red)}
.banner span{flex:1 1 20rem}
.sugg{display:flex;flex-wrap:wrap;align-items:center;gap:6px;padding:10px 14px;border-bottom:1px solid var(--line);font-size:10.5px;letter-spacing:.12em;color:var(--dim)}
.sugg:empty{display:none}
.acts{display:flex;flex-wrap:wrap;justify-content:flex-end;gap:8px;margin-top:16px}
.ph .seg{margin-left:6px}
.nocov{fill:rgba(154,148,138,.1)}
.vbox{display:flex;flex-wrap:wrap;align-items:baseline;gap:6px 14px;margin:14px;padding:14px 16px;border:1px solid var(--line-strong);border-left:3px solid currentColor}
.vbox b{font:600 15px var(--mono);letter-spacing:.06em}
.vbox span{flex:1 1 22rem;font:13px/1.55 var(--sans);color:var(--dim)}
.vbox.ok{color:var(--phos)}.vbox.warn{color:var(--amber)}.vbox.err{color:var(--red)}
.row-card .ph h2{text-transform:none;letter-spacing:.02em;color:var(--ink);font-size:12px;overflow:hidden;text-overflow:ellipsis}

pre.json{margin:0;padding:12px 14px;border:1px solid var(--line);background:var(--void);font:12px/1.6 var(--mono);overflow:auto;white-space:pre;max-height:60vh}
.jk{color:var(--sand)}.js{color:var(--phos)}.jn{color:var(--cyan)}.jb{color:var(--amber)}.jz{color:var(--faint)}

dialog{width:min(880px,calc(100vw - 24px));max-width:none;max-height:calc(100vh - 48px);padding:0;border:1px solid var(--line-strong);background:var(--panel);color:var(--ink);overflow:visible}
dialog[open]{display:flex;flex-direction:column}
dialog::backdrop{background:rgba(0,0,0,.82)}
.mh{flex:none;display:flex;align-items:center;gap:10px;padding:12px 14px;border-bottom:1px solid var(--line)}
.mh .tt{min-width:0;flex:1}
.mh h2{display:flex;align-items:center;gap:6px;margin:3px 0 0;font-size:14px;font-weight:600;min-width:0}
.mh h2 span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.seg{display:inline-flex;flex:none}
.seg button{height:26px;padding:0 10px;border:1px solid var(--line-strong);background:none;color:var(--dim);font-size:10.5px;letter-spacing:.12em}
.seg button+button{border-left:0}
.seg button[aria-pressed=true]{background:var(--amber);border-color:var(--amber);color:#000}
.mb{flex:1;min-height:0;overflow:auto;padding:16px}
.keys{display:grid;grid-template-columns:max-content 1fr;gap:9px 16px;margin:0;font:13px/1.5 var(--sans);color:var(--dim)}
.keys dt{white-space:nowrap}
#toast{position:fixed;left:50%;bottom:18px;z-index:60;transform:translateX(-50%);max-width:calc(100vw - 32px);padding:8px 14px;border:1px solid var(--amber);background:var(--panel);font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}

@media (max-width:1180px){.top{gap:8px 10px;padding:8px 16px}.field input{width:9rem}}
@media (max-width:1300px){.kpis{grid-template-columns:repeat(3,minmax(0,1fr))}.ov{grid-template-columns:repeat(2,minmax(0,1fr))}}
@media (max-width:900px){
body{display:block;height:auto}
.shell{display:block}
.side{position:sticky;top:0;z-index:15;display:flex;overflow-x:auto;padding:0;border-right:0;border-bottom:1px solid var(--line);background:var(--void);scrollbar-width:none}
.side::-webkit-scrollbar{display:none}
.side a{flex:none;padding:11px 12px;border-left:0;border-bottom:2px solid transparent}
.side a[aria-current=page]{border-bottom-color:var(--amber);background:none}
.side a .n,.side .foot{display:none}
main{overflow:visible;padding:16px}
.tw{max-height:70vh}
}
@media (max-width:760px){.ov{grid-template-columns:minmax(0,1fr)}.span2{grid-column:auto}}
@media (max-width:640px){
.top{padding:8px 12px}
.field{order:9;flex:1 1 100%}
.field input{flex:1;width:auto}
#updated{display:none}
.kpis{grid-template-columns:repeat(2,minmax(0,1fr))}
.kpi .v{font-size:20px}
.tw{max-height:none;overflow:visible}
.dt,.dt tbody,.dt thead{display:block}
.dt thead tr{display:flex;flex-wrap:wrap;gap:4px;padding:8px 10px;border-bottom:1px solid var(--line)}
.dt th{position:static;border:1px solid var(--line);background:none}
.dt th>button,.dt th>span{padding:3px 8px}
.dt th.ns,.dt th:has(>span){display:none}
.dt thead:not(:has(button)){display:none}
.dt tbody tr{display:block;padding:6px 0;border-bottom:1px solid var(--line)}
.dt tbody tr:last-child{border-bottom:0}
.dt td{display:flex;align-items:center;justify-content:space-between;gap:14px;padding:3px 12px;border:0;white-space:normal;text-align:right}
.dt td::before{content:attr(data-l);flex:none;font-size:10px;letter-spacing:.12em;color:var(--dim)}
.dt td.fill{width:auto;max-width:none}
.dt td .trunc{min-width:0}
.dt .tags{justify-content:flex-end}
.w-id .id>span,.w-sm .id>span{max-width:58vw}
.mb{padding:12px}
}
@media (prefers-reduced-motion:reduce){*{animation:none!important;transition:none!important}}
</style>
</head>
<body>
<a class="skip" href="#main">Skip to content</a>
<header class="top">
  <div class="brand"><svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="10" r="2.6" fill="#ffb000"/><circle cx="10" cy="10" r="5.6" fill="none" stroke="#ffb000" stroke-width="1.2"/><circle cx="10" cy="10" r="8.6" fill="none" stroke="#9a948a" stroke-width="1" stroke-dasharray="2 2"/></svg>SYNCULAR <span class="sl">/</span> <span class="sub">CONSOLE</span></div>
  <div class="field"><label for="partition">Partition</label><input id="partition" type="text" list="partitions-list" placeholder="server default" autocomplete="off" spellcheck="false" /></div>
  <datalist id="partitions-list"></datalist><datalist id="tables-list"></datalist><datalist id="clients-list"></datalist>
  <span class="grow"></span>
  <span id="live" class="pill" title="Event stream state"><i></i><span>Connecting</span></span>
  <span id="updated"></span>
  <select id="auto" class="btn" aria-label="Auto refresh" title="Auto refresh (a)">
    <option value="0">Auto off</option><option value="2000">Every 2 s</option><option value="5000">Every 5 s</option><option value="15000">Every 15 s</option>
  </select>
  <button id="refresh" class="btn amber" type="button" title="Refresh (r)">Refresh</button>
  <button id="help-btn" class="btn sq" type="button" aria-label="Keyboard shortcuts" title="Keyboard shortcuts (?)">?</button>
</header>
<div class="shell">
  <nav class="side" aria-label="Console views">
    <a id="nav-overview" href="#/overview"><b>01</b>Overview</a>
    <a id="nav-clients" href="#/clients"><b>02</b>Clients<span class="n" id="n-clients"></span></a>
    <a id="nav-commits" href="#/commits"><b>03</b>Commits<span class="n" id="n-commits"></span></a>
    <a id="nav-rows" href="#/rows"><b>04</b>Rows</a>
    <a id="nav-trace" href="#/trace"><b>05</b>Trace</a>
    <a id="nav-scopes" href="#/scopes"><b>06</b>Scopes</a>
    <a id="nav-events" href="#/events"><b>07</b>Events<span class="n" id="n-events"></span></a>
    <a id="nav-reactions" href="#/reactions"><b>08</b>Reactions<span class="n" id="n-reactions"></span></a>
    <a id="nav-storage" href="#/storage"><b>09</b>Storage</a>
    <div class="foot">Read-only view of one partition.<br/><kbd>?</kbd> shortcuts</div>
  </nav>
  <main id="main" tabindex="-1">
    <div id="alert" class="banner err" role="alert" hidden></div>

    <section id="view-overview" class="view" aria-labelledby="h-overview">
      <div class="vh"><p class="kicker">01 · Overview</p><h1 id="h-overview">Partition <span id="ov-part">…</span><span class="dot">.</span></h1></div>
      <div class="kpis" id="kpis" aria-label="Key figures"></div>
      <div class="ov">
        <div class="panel span2"><div class="ph"><h2>Request volume</h2><span class="meta" id="vol-meta"></span></div><div class="pb" id="ov-volume" data-skel></div></div>
        <div class="panel fig"><div class="ph"><h2>Horizon and retention</h2></div><div class="pb" id="ov-horizon" data-skel></div></div>
        <div class="panel"><div class="ph"><h2>Cursor lag</h2><span class="meta" id="lag-meta"></span></div><div id="ov-lag" data-skel></div></div>
        <div class="panel span2"><div class="ph"><h2>Failing</h2><div class="seg" role="group" aria-label="Group failures"><button type="button" data-act="err-tab" data-tab="code" aria-pressed="true">By code</button><button type="button" data-act="err-tab" data-tab="client" aria-pressed="false">By client</button></div><span class="meta" id="err-meta"></span></div><div id="ov-errors" data-skel></div></div>
        <div class="panel span3"><div class="ph"><h2>Fleet</h2><span class="meta" id="fleet-meta"></span></div><div id="ov-fleet" data-skel></div></div>
      </div>
    </section>

    <section id="view-clients" class="view" aria-labelledby="h-clients" hidden>
      <div class="vh"><p class="kicker">02 · Clients</p><h1 id="h-clients">Clients<span class="dot">.</span></h1><p class="lede">Every client with a cursor record in this partition. Lag counts the commits a client has not pulled yet. Select a row for its subscriptions, lease, and recent events.</p></div>
      <div class="panel">
        <div class="tb"><input id="clients-q" data-focus class="inp grow" type="search" placeholder="Filter by client or actor" aria-label="Filter clients by client or actor" /><label class="chk"><input id="clients-active" type="checkbox" /> Active only</label><span class="count" id="clients-count"></span></div>
        <div id="clients-wire" class="sugg"></div>
        <div id="clients-table" data-skel></div>
      </div>
    </section>

    <section id="view-commits" class="view" aria-labelledby="h-commits" hidden>
      <div class="vh"><p class="kicker">03 · Commits</p><h1 id="h-commits">Commits<span class="dot">.</span></h1><p class="lede">Commit metadata from the log, newest first. The console never reads payloads. Select a commit for the ring events of its push.</p></div>
      <div class="panel">
        <div class="tb"><input id="commits-table" data-focus class="inp grow" type="search" list="tables-list" placeholder="Filter by table" aria-label="Filter commits by table" /><select id="commits-limit" class="inp" aria-label="Commits to load"><option value="50">Newest 50</option><option value="200">Newest 200</option><option value="500">Newest 500</option></select><span class="count" id="commits-count"></span></div>
        <div id="commits-list" data-skel></div>
      </div>
    </section>

    <section id="view-rows" class="view" aria-labelledby="h-rows" hidden>
      <div class="vh"><p class="kicker">04 · Rows</p><h1 id="h-rows">Row inspector<span class="dot">.</span></h1><p class="lede">Reads one row's server version, stored scopes, and referenced blobs. Payload bytes stay unread.</p></div>
      <div class="panel">
        <form id="rows-form" class="tb"><input id="rows-table" data-focus class="inp" list="tables-list" placeholder="Table" aria-label="Table" spellcheck="false" /><input id="rows-id" class="inp grow" placeholder="Row id" aria-label="Row id" spellcheck="false" /><button class="btn amber" type="submit">Inspect</button></form>
        <div id="rows-result"><div class="empty"><b>No row inspected</b>Enter a table and a row id. Tables seen in commits and subscriptions appear as suggestions.</div></div>
      </div>
      <div class="panel"><div class="ph"><h2>Recent inspections</h2></div><div id="rows-recent"><div class="empty sm">Inspections from this session appear here.</div></div></div>
    </section>

    <section id="view-trace" class="view" aria-labelledby="h-trace" hidden>
      <div class="vh"><p class="kicker">05 · Trace</p><h1 id="h-trace">Delivery trace<span class="dot">.</span></h1><p class="lede">Answers why a client does or does not see a row: the row and its last change, the client's cursor, and how each of its subscriptions matches the row's scopes.</p></div>
      <div class="panel">
        <form id="trace-form" class="tb"><input id="trace-table" data-focus class="inp" list="tables-list" placeholder="Table" aria-label="Table" spellcheck="false" /><input id="trace-row" class="inp grow" placeholder="Row id" aria-label="Row id" spellcheck="false" /><input id="trace-client" class="inp grow" list="clients-list" placeholder="Client id" aria-label="Client id" spellcheck="false" /><button class="btn amber" type="submit">Trace</button></form>
        <div id="trace-result"><div class="empty"><b>No trace yet</b>Enter a table, a row id, and a client id. The client drill-down and the row inspector prefill these fields.</div></div>
      </div>
    </section>

    <section id="view-scopes" class="view" aria-labelledby="h-scopes" hidden>
      <div class="vh"><p class="kicker">06 · Scopes</p><h1 id="h-scopes">Scope activity<span class="dot">.</span></h1><p class="lede">Recent commits that touched one scope key, read through the change-scope index.</p></div>
      <div class="panel">
        <form id="scopes-form" class="tb"><input id="scopes-var" data-focus class="inp" placeholder="Variable, e.g. project_id" aria-label="Scope variable" spellcheck="false" /><input id="scopes-val" class="inp grow" placeholder="Value, e.g. p1" aria-label="Scope value" spellcheck="false" /><button class="btn amber" type="submit">Query</button><span class="count" id="scopes-count"></span></form>
        <div id="scopes-suggest" class="sugg"></div>
        <div id="scopes-table"><div class="empty"><b>No scope queried</b>Enter a scope variable and a value, or pick a scope from the client subscriptions above.</div></div>
      </div>
    </section>

    <section id="view-events" class="view" aria-labelledby="h-events" hidden>
      <div class="vh"><p class="kicker">07 · Events</p><h1 id="h-events">Event stream<span class="dot">.</span></h1><p class="lede">Structured server events from the in-memory ring, newest first. Kind and client filter on the server; family, level, and text filter the buffered tail.</p></div>
      <div id="ev-banner"></div>
      <div class="panel">
        <div class="tb">
          <select id="ev-kind" class="inp" aria-label="Event kind"></select>
          <input id="ev-client" class="inp" type="search" placeholder="Client id" aria-label="Filter events by client id" spellcheck="false" />
          <select id="ev-level" class="inp" aria-label="Level"><option value="">All levels</option><option value="warn">Warnings and errors</option><option value="err">Errors only</option></select>
          <input id="ev-q" data-focus class="inp grow" type="search" placeholder="Search event fields" aria-label="Search event fields" />
          <button id="ev-pause" class="btn sm" type="button" title="Pause (space)">Pause</button>
          <button id="ev-clear" class="btn sm" type="button">Clear</button>
          <span class="count" id="ev-count"></span>
        </div>
        <div id="ev-table" data-skel></div>
      </div>
    </section>

    <section id="view-reactions" class="view" aria-labelledby="h-reactions" hidden>
      <div class="vh"><p class="kicker">08 · Reactions</p><h1 id="h-reactions">Durable reactions<span class="dot">.</span></h1><p class="lede">The reaction queue of this partition: pending, leased, completed, and dead-lettered work with attempts and the last failure code. Reaction rows carry application payloads.</p></div>
      <div class="panel">
        <div class="tb"><select id="rx-status" class="inp" aria-label="Reaction status"><option value="">All statuses</option><option value="pending">Pending</option><option value="leased">Leased</option><option value="completed">Completed</option><option value="dead-letter">Dead letter</option></select><input id="rx-type" data-focus class="inp grow" type="search" placeholder="Reaction type" aria-label="Filter by reaction type" spellcheck="false" /><span class="count" id="rx-count"></span></div>
        <div id="rx-table" data-skel></div>
      </div>
    </section>

    <section id="view-storage" class="view" aria-labelledby="h-storage" hidden>
      <div class="vh"><p class="kicker">09 · Storage</p><h1 id="h-storage">Storage<span class="dot">.</span></h1><p class="lede">Segment and blob store counters, and the commit log's retention state.</p></div>
      <div class="cols">
        <div class="panel"><div class="ph"><h2>Segments</h2><span class="meta" id="seg-meta"></span></div><div class="pb" id="st-seg" data-skel></div></div>
        <div class="panel"><div class="ph"><h2>Blobs</h2><span class="meta" id="blob-meta"></span></div><div class="pb" id="st-blob" data-skel></div></div>
        <div class="panel fig"><div class="ph"><h2>Commit log</h2></div><div class="pb" id="st-horizon" data-skel></div></div>
      </div>
    </section>
  </main>
</div>

<dialog id="modal" aria-labelledby="m-title">
  <div class="mh"><div class="tt"><p class="kicker" id="m-kicker"></p><h2><span id="m-title"></span><button id="m-copy" class="cp" type="button" aria-label="Copy id" title="Copy"></button></h2></div>
    <div class="seg" role="group" aria-label="Detail format"><button type="button" id="m-tab-sum" aria-pressed="true">Summary</button><button type="button" id="m-tab-json" aria-pressed="false">JSON</button></div>
    <button id="m-close" class="btn sm" type="button">Close</button></div>
  <div class="mb"><div id="m-sum"></div><div id="m-json" hidden></div></div>
</dialog>
<dialog id="help" aria-labelledby="help-title">
  <div class="mh"><div class="tt"><p class="kicker">Console</p><h2 id="help-title"><span>Keyboard shortcuts</span></h2></div><button id="help-close" class="btn sm" type="button">Close</button></div>
  <div class="mb"><dl class="keys">
    <dt><kbd>1</kbd> to <kbd>9</kbd></dt><dd>Open Overview, Clients, Commits, Rows, Trace, Scopes, Events, Reactions, Storage</dd>
    <dt><kbd>r</kbd></dt><dd>Refresh the current view</dd>
    <dt><kbd>a</kbd></dt><dd>Cycle auto refresh: off, 2 s, 5 s, 15 s</dd>
    <dt><kbd>/</kbd></dt><dd>Focus the filter of the current view</dd>
    <dt><kbd>p</kbd></dt><dd>Focus the partition picker</dd>
    <dt><kbd>space</kbd></dt><dd>Pause or resume the event stream (Events view)</dd>
    <dt><kbd>Enter</kbd></dt><dd>Open the focused table row</dd>
    <dt><kbd>Esc</kbd></dt><dd>Close a dialog or leave a field</dd>
    <dt><kbd>?</kbd></dt><dd>Show this list</dd>
  </dl></div>
</dialog>
<dialog id="confirm" aria-labelledby="c-title">
  <div class="mh"><div class="tt"><p class="kicker">Write</p><h2 id="c-title"><span id="c-text"></span></h2></div></div>
  <div class="mb"><div id="c-body"></div><div class="acts"><button id="c-cancel" class="btn sm" type="button">Cancel</button><button id="c-ok" class="btn sm amber" type="button">Confirm</button></div></div>
</dialog>
<div id="toast" role="status" hidden></div>
<script>
(() => {
  'use strict';
  var $ = id => document.getElementById(id);
  var html = (id, v) => { $(id).innerHTML = v; };
  var txt = (id, v) => { $(id).textContent = v; };
  var NL = String.fromCharCode(10);
  var VIEWS = ['overview', 'clients', 'commits', 'rows', 'trace', 'scopes', 'events', 'reactions', 'storage'];
  var EVENT_TYPES = ['request.handled', 'push.applied', 'push.rejected', 'push.conflicted', 'pull.served',
    'realtime.opened', 'realtime.closed', 'realtime.delta', 'realtime.wake', 'reaction.queued', 'reaction.started',
    'reaction.retried', 'reaction.completed', 'reaction.dead_lettered', 'reaction.prune_completed',
    'segment.downloaded', 'blob.uploaded', 'blob.downloaded', 'blob.swept', 'prune.completed',
    'scopes.resolve_failed', 'lease.issued', 'lease.revoked'];
  var MAX_TAIL = 200;
  var SKEL = '<div class="skel" aria-label="Loading"><i></i><i></i><i></i></div>';
  var COPY_SVG = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M5.5 5.5h8v8h-8zM2.5 10.5v-8h8" fill="none" stroke="currentColor"/></svg>';

  // The endpoints are siblings of the page under the SAME mount prefix. The
  // page is served at the mount root (…/admin or …/admin/); strip any
  // trailing slash so 'base + /clients' hits '…/admin/clients' regardless of
  // whether the URL had the trailing slash.
  var base = location.pathname.replace(/\\/+$/, '');
  var parentTransport = new URLSearchParams(location.search).get('transport') === 'parent';
  var nextRequestId = 1;
  var parentRequests = {};
  if (parentTransport) {
    window.addEventListener('message', event => {
      if (event.source !== window.parent || event.origin !== location.origin) return;
      var message = event.data;
      if (!message || message.kind !== 'syncular-admin-response' || typeof message.id !== 'number') return;
      var request = parentRequests[message.id];
      if (!request) return;
      delete parentRequests[message.id];
      if (message.ok) request.resolve(message.body);
      else request.reject(apiError(message.body, message.status));
    });
  }
  function apiError(body, status) {
    var b = body && typeof body === 'object' ? body : {};
    var err = new Error(typeof b.message === 'string' ? b.message : 'The endpoint answered HTTP ' + status + '.');
    err.code = typeof b.code === 'string' ? b.code : 'console.unexpected_response';
    err.status = status;
    err.action = typeof b.recommendedAction === 'string' ? b.recommendedAction : '';
    return err;
  }
  function qs(params) {
    var parts = [];
    var p = $('partition').value.trim();
    if (p) parts.push('partition=' + encodeURIComponent(p));
    if (params) Object.keys(params).forEach(k => {
      var v = params[k];
      if (v !== undefined && v !== null && v !== '') parts.push(k + '=' + encodeURIComponent(v));
    });
    return parts.length ? '?' + parts.join('&') : '';
  }
  // A partition switch bumps the epoch; answers to older requests reject
  // with STALE so they never render into the new partition's panels.
  var epoch = 0, STALE = new Error('stale');
  function get(path, params) { return call(path, qs(params), 'GET'); }
  function post(path) { return call(path, qs(), 'POST'); }
  function call(path, query, method) {
    var ep = epoch;
    return send(path, query, method).then(b => {
      if (ep !== epoch) throw STALE;
      return b;
    }, err => {
      throw ep !== epoch ? STALE : err;
    });
  }
  function send(path, query, method) {
    if (parentTransport) {
      return new Promise((resolve, reject) => {
        var id = nextRequestId++;
        parentRequests[id] = { resolve: resolve, reject: reject };
        window.parent.postMessage({ kind: 'syncular-admin-request', id: id, path: path + query, method: method }, location.origin);
      });
    }
    return fetch(base + path + query, { method: method, headers: { accept: 'application/json' } }).then(r => {
      return r.json().then(b => {
        if (!r.ok) throw apiError(b, r.status);
        return b;
      }, () => {
        throw apiError({ code: 'console.unexpected_response', message: 'The endpoint answered HTTP ' + r.status + ' with a body that is not JSON.' }, r.status);
      });
    }, () => {
      throw apiError({ code: 'console.network_error', message: 'The request did not reach the admin routes.' }, 0);
    });
  }

  // -- formatting ----------------------------------------------------------
  function esc(v) {
    return String(v == null ? '' : v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  function fmt(n) { return n == null ? '–' : Number(n).toLocaleString('en-US'); }
  function pad(n, w) { return String(n).padStart(w || 2, '0'); }
  function clock(ms, withMs) {
    var d = new Date(ms);
    return pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds()) + (withMs ? '.' + pad(d.getMilliseconds(), 3) : '');
  }
  function stamp(ms) { return new Date(ms).toISOString(); }
  function span(d) {
    d = Math.abs(d);
    if (d < 1000) return Math.round(d) + ' ms';
    if (d < 60000) return Math.round(d / 1000) + ' s';
    if (d < 3600000) return Math.round(d / 60000) + ' min';
    if (d < 86400000) return Math.round(d / 3600000) + ' h';
    return Math.round(d / 86400000) + ' d';
  }
  function ago(ms) { return Date.now() - ms < 0 ? 'now' : span(Date.now() - ms) + ' ago'; }
  function rel(ms) { return ms > Date.now() ? 'in ' + span(ms - Date.now()) : span(Date.now() - ms) + ' ago'; }
  function when(ms) { return '<span title="' + esc(stamp(ms)) + '">' + ago(ms) + '</span>'; }
  function dur(n) { return n == null ? '–' : (n < 10 ? n.toFixed(1) : String(Math.round(n))); }
  function bytes(n) {
    if (n == null) return '–';
    if (n < 1024) return n + ' B';
    if (n < 1048576) return (n / 1024).toFixed(1) + ' KiB';
    if (n < 1073741824) return (n / 1048576).toFixed(1) + ' MiB';
    return (n / 1073741824).toFixed(2) + ' GiB';
  }
  function pct(n) { return (n * 100).toFixed(n > 0 && n < 0.1 ? 1 : 0) + '%'; }
  function st(cls, text) { return '<span class="st ' + cls + '">' + esc(text) + '</span>'; }
  function idCell(v) {
    return '<span class="id"><span title="' + esc(v) + '">' + esc(v) + '</span><button type="button" class="cp" data-copy="' + esc(v) + '" aria-label="Copy ' + esc(v) + '" title="Copy">' + COPY_SVG + '</button></span>';
  }
  function idText(v) { return '<span class="id"><span title="' + esc(v) + '">' + esc(v) + '</span></span>'; }
  function trunc(text) { return '<span class="trunc" title="' + esc(text) + '">' + esc(text) + '</span>'; }
  function tags(list) {
    return '<span class="tags">' + list.map(t => '<span class="tag">' + esc(t) + '</span>').join('') + '</span>';
  }
  function empty(title, text, small) {
    return '<div class="empty' + (small ? ' sm' : '') + '"><b>' + esc(title) + '</b>' + text + '</div>';
  }
  function errBox(err) {
    return '<div class="errbox" role="alert"><code>' + esc(err.code || 'console.render_failed') + '</code>' +
      (err.status ? '<span class="hs">HTTP ' + esc(err.status) + '</span>' : '') +
      '<p>' + esc(err.message) + (err.action ? ' Recommended action: ' + esc(err.action) + '.' : '') + '</p></div>';
  }
  function kv(pairs) {
    return '<dl class="kv">' + pairs.map(p => '<dt>' + esc(p[0]) + '</dt><dd>' + p[1] + '</dd>').join('') + '</dl>';
  }
  function jhtml(v, ind) {
    ind = ind || '';
    if (v === null || v === undefined) return '<span class="jz">null</span>';
    if (typeof v === 'string') return '<span class="js">' + esc(JSON.stringify(v)) + '</span>';
    if (typeof v === 'number') return '<span class="jn">' + v + '</span>';
    if (typeof v === 'boolean') return '<span class="jb">' + v + '</span>';
    var arr = Array.isArray(v);
    var keys = arr ? v.map((_, i) => i) : Object.keys(v);
    if (!keys.length) return arr ? '[]' : '{}';
    var inner = ind + '  ';
    return (arr ? '[' : '{') + NL + keys.map(k => {
      return inner + (arr ? '' : '<span class="jk">' + esc(JSON.stringify(k)) + '</span>: ') + jhtml(v[k], inner);
    }).join(',' + NL) + NL + ind + (arr ? ']' : '}');
  }
  function json(v) { return '<pre class="json">' + jhtml(v) + '</pre>'; }

  // -- events: level, summary ----------------------------------------------
  function level(e) {
    var t = e.type;
    if (t === 'push.rejected' || t === 'reaction.dead_lettered' || t === 'scopes.resolve_failed' ||
      (t === 'request.handled' && (e.outcome === 'error' || e.outcome === 'rejected')) ||
      ((t === 'segment.downloaded' || t === 'blob.downloaded') && e.outcome === 'error')) return 'err';
    if (t === 'push.conflicted' || t === 'reaction.retried' || t === 'lease.revoked' ||
      (t === 'request.handled' && (e.outcome === 'reset' || e.outcome === 'schema_floor')) ||
      (t === 'realtime.wake' && e.reason === 'delta-too-large') ||
      (t === 'pull.served' && e.subscriptions.some(s => s.status !== 'active'))) return 'warn';
    return 'info';
  }
  var LEVEL_LABEL = { err: 'error', warn: 'warn', info: 'info' };
  var SUMMARY_KEYS = ['outcome', 'errorCode', 'code', 'commitSeq', 'operations', 'opIndex', 'reason', 'reactionType',
    'attempt', 'phase', 'message', 'previousHorizonSeq', 'horizonSeq', 'removedCommits', 'swept', 'changes', 'bytes',
    'durationMs', 'segmentId', 'blobId', 'leaseId', 'registrations'];
  function summary(e) {
    if (e.type === 'request.handled') {
      return e.outcome + (e.errorCode ? ' ' + e.errorCode : '') + ' · ' + dur(e.durationMs) + ' ms · ' + e.pushCommits +
        ' pushed · ' + (e.pulled ? 'pulled ' + e.subscriptions + ' subs' : 'no pull') + ' · ' + bytes(e.bytesIn) + ' in, ' + bytes(e.bytesOut) + ' out';
    }
    if (e.type === 'pull.served') {
      var modes = {}, commits = 0;
      e.subscriptions.forEach(s => { var k = s.status === 'active' ? s.mode : s.status; modes[k] = (modes[k] || 0) + 1; commits += s.commits; });
      return Object.keys(modes).map(k => modes[k] + ' ' + k).join(', ') + ' · ' + commits + ' commits · through ' + e.acceptedThrough;
    }
    return SUMMARY_KEYS.filter(k => e[k] !== undefined).map(k => {
      return k + ' ' + (typeof e[k] === 'string' ? e[k] : JSON.stringify(e[k]));
    }).join(' · ') + (e.replay ? ' · replay' : '');
  }

  // -- tables: sortable, pickable ------------------------------------------
  var T = {};
  function table(id, cols, rows, emptyHtml, pick, current) {
    var t = T[id] || (T[id] = { k: -1, d: 1 });
    t.cols = cols; t.rows = rows; t.empty = emptyHtml; t.pick = pick; t.current = current;
    drawTable(id);
  }
  function drawTable(id) {
    var t = T[id], host = $(id);
    host.setAttribute('data-tbl', id);
    if (!t.rows.length) { host.innerHTML = t.empty; return; }
    var order = t.rows.map((r, i) => i);
    if (t.k >= 0) {
      var col = t.cols[t.k];
      order.sort((a, b) => {
        var x = col.v(t.rows[a]), y = col.v(t.rows[b]);
        return (x < y ? -1 : x > y ? 1 : a - b) * (x === y ? 1 : t.d);
      });
    }
    host.innerHTML = '<div class="tw' + (t.rows.length < 8 ? ' short' : '') + '"><table class="dt"><thead><tr>' + t.cols.map((c, ci) => {
      var cls = (c.ns ? 'ns ' : '') + (c.c || '');
      if (c.ns || !c.v) return '<th scope="col" class="' + cls + '"><span>' + c.l + '</span></th>';
      return '<th scope="col" class="' + cls + '"' + (t.k === ci ? ' aria-sort="' + (t.d > 0 ? 'ascending' : 'descending') + '"' : '') +
        '><button type="button" data-sort="' + ci + '">' + c.l + '</button></th>';
    }).join('') + '</tr></thead><tbody>' + order.map(i => {
      var r = t.rows[i];
      return '<tr' + (t.pick ? ' tabindex="0" data-i="' + i + '"' : '') + (t.current && t.current(r) ? ' class="cur"' : '') + '>' +
        t.cols.map(c => '<td class="' + (c.c || '') + '" data-l="' + c.l + '">' + c.h(r) + '</td>').join('') + '</tr>';
    }).join('') + '</tbody></table></div>';
  }
  function numCol(label, key) { return { l: label, c: 'num', d: -1, v: r => r[key], h: r => fmt(r[key]) }; }
  function sortBy(id, ci) {
    var t = T[id];
    if (t.k === ci) t.d = -t.d; else { t.k = ci; t.d = t.cols[ci].d || 1; }
    drawTable(id);
    var b = $(id).querySelector('[data-sort="' + ci + '"]');
    if (b) b.focus();
  }

  // -- state ---------------------------------------------------------------
  // INFO is the admin's capability record from GET /info; it outlives
  // partition switches. S holds the current partition's reads.
  var INFO = null, S = {}, ERR_TAB = 'code', FLEET_PAGE = 25;
  var tail = { mode: 'idle', src: null, list: [], held: [], paused: false };
  function reset() {
    S = { view: S.view || 'overview', recentRows: S.recentRows || [], errs: {}, fleetOffset: 0 };
    document.querySelectorAll('[data-skel]').forEach(h => { h.innerHTML = SKEL; });
    ['n-clients', 'n-commits', 'n-events', 'n-reactions'].forEach(id => { $(id).textContent = ''; });
    renderKpis();
  }
  function ringOff(text) {
    return empty('No event ring wired', text + ' Pass <code>ring</code> to <code>SyncularAdmin.fromConfig</code> to record them.', true);
  }
  function partial(m) {
    return m.coverage && !m.coverage.complete;
  }

  // -- overview ------------------------------------------------------------
  function sparkBars(vals, errs, red) {
    var max = Math.max.apply(null, vals.concat([1])), H = 26;
    return '<svg viewBox="0 0 ' + vals.length * 4 + ' ' + H + '" preserveAspectRatio="none" aria-hidden="true">' + vals.map((v, i) => {
      var h = v ? Math.max(1.5, v / max * H) : 1, e = errs && errs[i] ? Math.max(1.5, errs[i] / max * H) : 0;
      return '<rect class="bar' + (v ? (red ? ' r' : '') : ' z') + '" x="' + (i * 4) + '" y="' + (H - h) + '" width="3" height="' + h + '"/>' +
        (e ? '<rect class="bar r" x="' + (i * 4) + '" y="' + (H - e) + '" width="3" height="' + e + '"/>' : '');
    }).join('') + '</svg>';
  }
  function stack(parts) {
    var total = parts.reduce((s, p) => s + p[0], 0);
    return '<div class="stack">' + (total ? parts.map(p => {
      return p[0] ? '<b class="' + p[1] + '" style="width:' + (p[0] / total * 100) + '%"></b>' : '';
    }).join('') : '') + '</div>';
  }
  function kpi(label, value, unit, sub, viz, cls) {
    return '<div class="kpi ' + (cls || '') + '"><div class="l">' + label + '</div><div class="v">' + value +
      (unit ? '<small>' + unit + '</small>' : '') + '</div><div class="s" title="' + esc(sub) + '">' + esc(sub) + '</div><div class="viz">' + (viz || '') + '</div></div>';
  }
  function renderKpis() {
    var m = S.metrics, h = S.horizon, c = S.clients, e = S.errs, out = '';
    if (m && INFO && INFO.hasEventStream) {
      var b = m.buckets, p = m.pushes, cut = partial(m);
      var scope = cut ? 'since ' + clock(m.coverage.fromMs) + ' (partial window)' : 'in the last ' + span(m.windowMs);
      out += kpi('Requests', m.requests.perMinute >= 10 ? fmt(Math.round(m.requests.perMinute)) : m.requests.perMinute.toFixed(1), '/min',
        fmt(m.requests.count) + ' ' + scope, sparkBars(b.counts, b.errors), cut ? 'warn' : '');
      out += kpi('Error rate', pct(m.requests.errorRate), '', fmt(m.requests.errorCount) + ' rejected or failed ' + scope,
        sparkBars(b.counts.map((n, i) => n ? b.errors[i] / n : 0), null, true), m.requests.errorRate > 0 ? 'bad' : cut ? 'warn' : '');
      out += kpi('Latency p95', dur(m.requests.p95Ms), 'ms', 'p50 ' + dur(m.requests.p50Ms) + ' ms ' + scope, sparkBars(b.p95Ms.map(v => v || 0)), cut ? 'warn' : '');
      out += kpi('Pushes', fmt(p.applied), 'applied', fmt(p.conflicted) + ' conflicted · ' + fmt(p.rejected) + ' rejected',
        sparkBars(b.pushes.map(x => x.applied + x.conflicted + x.rejected), b.pushes.map(x => x.conflicted + x.rejected)),
        p.conflicted + p.rejected > 0 || cut ? 'warn' : '');
    } else {
      var why = e.metrics ? e.metrics.code : INFO && !INFO.hasEventStream ? 'no event ring wired' : 'loading';
      ['Requests', 'Error rate', 'Latency p95', 'Pushes'].forEach(l => { out += kpi(l, '–', '', why, '', ''); });
    }
    if (c) {
      var active = c.filter(x => x.active).length, behind = c.filter(x => x.lag > 0).length;
      out += kpi('Clients', fmt(active), '/ ' + fmt(S.clientTotal) + ' active', fmt(behind) + ' behind the head' + (S.clientTotal > c.length ? ' among ' + fmt(c.length) + ' loaded' : ''),
        stack([[active, 'c-ok'], [c.length - active, 'c-dim']]), '');
    } else out += kpi('Clients', '–', '', e.clients ? e.clients.code : 'loading', '', '');
    if (h) {
      out += kpi('Commit log', fmt(h.maxCommitSeq), 'head', fmt(h.retainedCommits) + ' retained · horizon ' + fmt(h.horizonSeq),
        stack([[h.horizonSeq, 'c-dim'], [h.recommendedHorizonSeq - h.horizonSeq, 'c-am'], [h.maxCommitSeq - h.recommendedHorizonSeq, 'c-cy']]),
        h.recommendation === 'prune-recommended' ? 'warn' : '');
    } else out += kpi('Commit log', '–', '', e.horizon ? e.horizon.code : 'loading', '', '');
    html('kpis', out);
  }
  function renderVolume() {
    var m = S.metrics, host = $('ov-volume');
    if (!INFO.hasEventStream) { txt('vol-meta', ''); host.innerHTML = ringOff('Request metrics come from the event ring.'); return; }
    var b = m.buckets, c = b.counts, er = b.errors, n = c.length, max = Math.max.apply(null, c.concat([1])), W = n * 10, H = 100;
    var from = m.atMs - m.windowMs, cut = partial(m);
    var svg = '<svg viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="none" role="img" aria-label="Requests per ' + span(b.widthMs) + ' bucket over the last ' + span(m.windowMs) + ', peak ' + max + '">' +
      (cut ? '<rect class="nocov" x="0" y="0" height="' + H + '" width="' + Math.max(0, Math.min(W, (m.coverage.fromMs - from) / m.windowMs * W)) + '"/>' : '') +
      '<line class="grid" x1="0" x2="' + W + '" y1="0.5" y2="0.5" vector-effect="non-scaling-stroke"/><line class="grid" x1="0" x2="' + W + '" y1="50" y2="50" vector-effect="non-scaling-stroke"/><line class="grid" x1="0" x2="' + W + '" y1="99.5" y2="99.5" vector-effect="non-scaling-stroke"/>';
    for (var i = 0; i < n; i++) {
      var hOk = (c[i] - er[i]) / max * H, hErr = er[i] / max * H, x = i * 10 + 1.5, pu = b.pushes[i];
      svg += '<g><title>' + clock(from + i * b.widthMs) + ' to ' + clock(from + (i + 1) * b.widthMs) + ': ' + c[i] + ' requests, ' + er[i] + ' failed' +
        (b.p95Ms[i] != null ? ', p95 ' + dur(b.p95Ms[i]) + ' ms' : '') + ', ' + pu.applied + ' pushes applied, ' + pu.conflicted + ' conflicted, ' + pu.rejected + ' rejected</title>' +
        '<rect class="hit" x="' + (i * 10) + '" y="0" width="10" height="' + H + '" fill="transparent"/>' +
        (hOk ? '<rect class="bar" x="' + x + '" y="' + (H - hOk - hErr) + '" width="7" height="' + hOk + '"/>' : '') +
        (hErr ? '<rect class="bar r" x="' + x + '" y="' + (H - hErr) + '" width="7" height="' + hErr + '"/>' : '') + '</g>';
    }
    txt('vol-meta', span(b.widthMs) + ' buckets');
    host.innerHTML = (cut ? '<div class="banner"><b>Partial window</b><span>The event ring evicted events inside the ' + span(m.windowMs) + ' window. Every figure here covers only the last ' +
      span(m.atMs - m.coverage.fromMs) + ', since ' + clock(m.coverage.fromMs) + ' (shaded range has no data). Raise the ring capacity for a full window.</span></div>' : '') +
      '<div class="chart"><span class="ymax">' + fmt(max) + '</span>' + svg + '</svg><div class="axis"><span>' + span(m.windowMs) + ' ago</span><span>' + span(m.windowMs / 2) + ' ago</span><span>now</span></div></div>' +
      '<div class="legend"><span><i class="c-am"></i>requests</span><span><i class="c-err"></i>rejected or failed</span><span class="r">' + fmt(m.requests.count) + ' requests · p50 ' + dur(m.requests.p50Ms) + ' ms · p95 ' + dur(m.requests.p95Ms) + ' ms</span></div>';
  }
  function renderHorizon(id, h) {
    var host = $(id);
    if (h.maxCommitSeq === 0) {
      host.innerHTML = empty('Empty commit log', 'The partition has no commits yet, so there is nothing to retain or prune.', true);
      return;
    }
    var max = h.maxCommitSeq, at = n => Math.max(0, Math.min(100, n / max * 100));
    var hz = at(h.horizonSeq), rec = at(h.recommendedHorizonSeq), floor = h.activeCursorFloor;
    var marker = '';
    if (floor !== null) {
      var fp = at(Math.max(floor, 0));
      marker = '<span class="mark' + (fp < 15 ? ' l' : fp > 85 ? ' e' : '') + '" style="left:' + fp + '%"><span>cursor floor ' + fmt(floor) + '</span></span>';
    }
    var prune = h.recommendation === 'prune-recommended';
    host.innerHTML = '<div class="gauge" role="img" aria-label="Commit log from 0 to head ' + max + ': horizon ' + h.horizonSeq + ', a prune pass would reach ' + h.recommendedHorizonSeq + '">' +
      '<i class="g-pruned" style="width:' + hz + '%"></i><i class="g-prunable" style="width:' + (rec - hz) + '%"></i><i class="g-retained" style="width:' + (100 - rec) + '%"></i>' + marker + '</div>' +
      '<div class="gscale"><span>0</span><span>head ' + fmt(max) + '</span></div>' +
      '<div class="legend"><span><i class="g-pruned" style="border:1px solid var(--line-strong)"></i>pruned</span><span><i class="g-prunable"></i>prunable now</span><span><i class="g-retained"></i>retained</span></div>' +
      (INFO.writes ? '<div class="acts" style="margin:0 0 -6px"><button type="button" class="btn sm' + (prune ? ' amber' : '') + '" data-act="prune">Prune now</button></div>' : '') +
      '<p class="verdict"><b class="' + (prune ? 'ty' : 'dim') + '">' + (prune ? 'Prune recommended' : 'Up to date') + '</b>' +
      (prune ? 'A prune pass would advance the horizon from ' + fmt(h.horizonSeq) + ' to ' + fmt(h.recommendedHorizonSeq) + ' and drop ' + fmt(h.recommendedHorizonSeq - h.horizonSeq) + ' commits.'
        : 'A prune pass now would leave the horizon at ' + fmt(h.horizonSeq) + '.') + '</p>' +
      kv([['Head', fmt(h.maxCommitSeq)], ['Horizon', fmt(h.horizonSeq)], ['Prune target', fmt(h.recommendedHorizonSeq)],
        ['Retained', fmt(h.retainedCommits) + ' commits'],
        ['Cursor floor', floor === null ? '<span class="dim">no active clients</span>' : fmt(floor) + (floor < 0 ? ' <span class="dim">(an active client has not pulled yet)</span>' : '')]]);
  }
  var LAG_BUCKETS = [[0, 0, 'in sync'], [1, 9, '1 to 9'], [10, 99, '10 to 99'], [100, 999, '100 to 999'], [1000, Infinity, '1000 +']];
  function renderLag() {
    var c = S.clients;
    txt('lag-meta', c.length ? 'commits behind head' : '');
    if (!c.length) { $('ov-lag').innerHTML = empty('No clients', 'No client has synced this partition. Clients appear after their first request.', true); return; }
    var rows = LAG_BUCKETS.map(b => {
      var inB = c.filter(x => x.lag >= b[0] && x.lag <= b[1]);
      var a = inB.filter(x => x.active).length;
      return [b[2], a, inB.length - a];
    });
    var max = Math.max.apply(null, rows.map(r => r[1] + r[2]).concat([1]));
    html('ov-lag', '<div class="pb"><div class="hist">' + rows.map(r => {
      return '<span class="lb">' + r[0] + '</span><span class="tr" title="' + r[1] + ' active, ' + r[2] + ' idle" aria-hidden="true"><b class="c-am" style="width:' + (r[1] / max * 100) + '%"></b><b class="c-dim" style="width:' + (r[2] / max * 100) + '%"></b></span><span class="ct">' + (r[1] + r[2]) + '<span class="sr"> clients, ' + r[1] + ' active</span></span>';
    }).join('') + '</div><div class="legend"><span><i class="c-am"></i>active</span><span><i class="c-dim"></i>idle</span></div></div><div id="ov-lagtop"></div>');
    var top = c.filter(x => x.lag > 0).sort((a, b) => b.lag - a.lag).slice(0, 5);
    if (top.length) {
      table('ov-lagtop', [
        { l: 'Most behind', c: 'w-sm fill', h: x => idCell(x.clientId) },
        { l: 'Lag', c: 'num', h: x => fmt(x.lag) },
        { l: 'Seen', c: 'num', h: x => when(x.updatedAtMs) }
      ], top, '', x => { openClient(x.clientId); });
    }
  }
  function renderErrors() {
    var r = S.errors;
    $('ov-errors').parentElement.querySelectorAll('[data-tab]').forEach(b => { b.setAttribute('aria-pressed', String(b.getAttribute('data-tab') === ERR_TAB)); });
    if (!INFO.hasEventStream) { txt('err-meta', ''); html('ov-errors', ringOff('Failures come from the event ring.')); return; }
    var cut = r.coverage && !r.coverage.complete;
    txt('err-meta', cut ? 'since ' + clock(r.coverage.fromMs) + ' (partial)' : 'last ' + span(r.windowMs));
    var none = empty('Nothing failing', 'No rejected request, push, or failed delivery in the ' + (cut ? 'covered part of the window' : 'last ' + span(r.windowMs)) + '.', true);
    if (ERR_TAB === 'code') {
      table('ov-errors', [
        { l: 'Code', v: x => x.code, h: x => '<span class="ty err">' + esc(x.code) + '</span>' },
        { l: 'Source', v: x => x.source, h: x => esc(x.source) },
        numCol('Count', 'count'), numCol('Clients', 'clients'), numCol('Actors', 'actors'),
        { l: 'Last', c: 'num', d: -1, v: x => x.lastAtMs, h: x => when(x.lastAtMs) },
        { l: 'Sample clients', c: 'fill', ns: true, h: x => '<span class="tags">' + x.sampleClientIds.map(id => '<button type="button" class="tag" data-client="' + esc(id) + '">' + esc(id) + '</button>').join('') + '</span>' }
      ], r.byCode, none, x => { $('ev-q').value = x.code; $('ev-level').value = ''; go('events'); renderTail(); });
    } else {
      table('ov-errors', [
        { l: 'Client', c: 'w-sm', v: x => x.clientId, h: x => idCell(x.clientId) },
        { l: 'Actor', c: 'w-sm', v: x => x.actorId, h: x => idText(x.actorId) },
        numCol('Count', 'count'),
        { l: 'Last code', v: x => x.lastCode, h: x => '<span class="ty err">' + esc(x.lastCode) + '</span>' },
        { l: 'Last', c: 'num fill', d: -1, v: x => x.lastAtMs, h: x => when(x.lastAtMs) }
      ], r.byClient, none, x => { openClient(x.clientId); });
    }
  }

  // -- loaders -------------------------------------------------------------
  function fail(hosts, key) {
    return err => {
      if (err === STALE) return null;
      if (key) { S.errs[key] = err; renderKpis(); }
      hosts.forEach(id => { $(id).innerHTML = errBox(err); });
      return err;
    };
  }
  function loadMetrics() {
    if (!INFO.hasEventStream) { renderKpis(); renderVolume(); return null; }
    return get('/metrics').then(r => { S.metrics = r.metrics; renderKpis(); renderVolume(); return null; }).catch(fail(['ov-volume'], 'metrics'));
  }
  function loadErrors() {
    if (!INFO.hasEventStream) { renderErrors(); return null; }
    return get('/errors', { windowMs: 300000 }).then(r => { S.errors = r.errors; renderErrors(); return null; }).catch(err => { txt('err-meta', ''); return fail(['ov-errors'])(err); });
  }
  function loadHorizon(hosts) {
    return get('/horizon').then(r => {
      var h = r.horizon;
      S.horizon = h;
      txt('ov-part', h.partition);
      $('partition').placeholder = h.partition + ' (default)';
      hosts.forEach(id => { renderHorizon(id, h); });
      renderKpis();
      return null;
    }).catch(fail(hosts, 'horizon'));
  }
  var CLIENT_COLS = [
    { l: 'Client', c: 'w-id', v: x => x.clientId, h: x => idCell(x.clientId) },
    { l: 'Actor', c: 'w-sm', v: x => x.actorId, h: x => idText(x.actorId) },
    { l: 'Status', v: x => x.active ? 0 : 1, h: x => x.active ? st('ok', 'active') : st('idle', 'idle') },
    { l: 'Wire', c: 'num', v: x => x.wireVersion, h: x => x.wireVersion == null ? '<span class="dim">–</span>' : 'v' + x.wireVersion },
    numCol('Cursor', 'cursor'),
    { l: 'Lag', c: 'num', d: -1, v: x => x.lag, h: x => {
      var max = Math.max.apply(null, S.clients.map(y => y.lag).concat([1]));
      return '<span class="lag' + (x.lag ? '' : ' z') + '">' + fmt(x.lag) + '<i><b style="width:' + (x.lag / max * 100) + '%"></b></i></span>';
    } },
    { l: 'Last seen', c: 'num', d: -1, v: x => x.updatedAtMs, h: x => when(x.updatedAtMs) },
    { l: 'Subs', c: 'num', d: -1, v: x => x.subscriptions.length, h: x => {
      return '<span title="' + esc(x.subscriptions.map(s => s.table).join(', ')) + '">' + x.subscriptions.length + '</span>';
    } }
  ];
  function wireSpread() {
    var by = {};
    S.clients.forEach(x => { var k = x.wireVersion == null ? 'unknown' : 'v' + x.wireVersion; by[k] = (by[k] || 0) + 1; });
    return Object.keys(by).sort().map(k => k + ' · ' + by[k]);
  }
  function renderClients() {
    var c = S.clients, q = $('clients-q').value.trim().toLowerCase(), act = $('clients-active').checked;
    var rows = c.filter(x => {
      return (!act || x.active) && (!q || x.clientId.toLowerCase().indexOf(q) >= 0 || x.actorId.toLowerCase().indexOf(q) >= 0);
    });
    txt('clients-count', (rows.length === c.length ? fmt(c.length) : fmt(rows.length) + ' of ' + fmt(c.length)) + ' clients' +
      (S.clientTotal > c.length ? ' · ' + fmt(S.clientTotal) + ' known, the ' + fmt(c.length) + ' furthest behind loaded' : ''));
    html('clients-wire', c.length ? 'Wire versions ' + tags(wireSpread()) : '');
    table('clients-table', CLIENT_COLS, rows, c.length
      ? empty('No match', 'No client matches the filter.')
      : empty('No clients', 'No client has a cursor record in this partition. A client appears after its first sync request.'),
      x => { openClient(x.clientId); });
  }
  function renderSuggest() {
    var seen = {}, out = [];
    S.clients.forEach(x => {
      x.subscriptions.forEach(s => {
        Object.keys(s.scopes).forEach(k => {
          s.scopes[k].forEach(v => { var key = k + ':' + v; if (!seen[key]) { seen[key] = 1; out.push([k, v]); } });
        });
      });
    });
    $('scopes-suggest').innerHTML = out.length ? 'Subscribed scopes' + out.slice(0, 24).map(p => {
      return '<button type="button" class="tag" data-sv="' + esc(p[0]) + '" data-sval="' + esc(p[1]) + '">' + esc(p[0]) + ': ' + esc(p[1]) + '</button>';
    }).join('') : '';
  }
  function loadClients() {
    return get('/clients', { sort: 'lag', limit: 500 }).then(r => {
      S.clients = r.clients;
      S.clientTotal = r.total;
      txt('n-clients', fmt(r.total));
      html('clients-list', r.clients.map(x => '<option value="' + esc(x.clientId) + '"></option>').join(''));
      renderClients(); renderLag(); renderSuggest(); renderKpis();
      return null;
    }).catch(fail(['clients-table', 'ov-lag', 'scopes-suggest'], 'clients'));
  }
  function loadFleet() {
    return get('/partitions', { limit: FLEET_PAGE, offset: S.fleetOffset }).then(r => {
      var list = r.partitions, cur = S.horizon ? S.horizon.partition : $('partition').value.trim(), off = S.fleetOffset;
      html('partitions-list', list.map(p => '<option value="' + esc(p.partition) + '"></option>').join(''));
      var prune = list.filter(p => p.recommendation === 'prune-recommended').length;
      txt('fleet-meta', fmt(r.total) + ' partitions' + (r.total > list.length ? ' · ' + fmt(off + 1) + ' to ' + fmt(off + list.length) + ' shown' : '') + (prune ? ' · ' + prune + ' to prune' : ''));
      table('ov-fleet', [
        { l: 'Partition', c: 'w-sm', v: p => p.partition, h: p => idCell(p.partition) },
        numCol('Head', 'maxCommitSeq'),
        numCol('Horizon', 'horizonSeq'),
        numCol('Retained', 'retainedCommits'),
        { l: 'Clients', c: 'num', d: -1, v: p => p.activeClients, h: p => fmt(p.activeClients) + ' / ' + fmt(p.knownClients) },
        { l: 'State', c: 'fill', v: p => p.recommendation, h: p => p.recommendation === 'prune-recommended' ? st('warn', 'prune recommended') : st('ok', 'up to date') }
      ], list, empty('No partitions', 'The partition registry is empty.', true),
      p => { setPartition(p.partition); }, p => p.partition === cur);
      if (r.total > FLEET_PAGE) {
        $('ov-fleet').insertAdjacentHTML('beforeend', '<div class="acts" style="margin:0;padding:10px 14px;border-top:1px solid var(--line)">' +
          '<button type="button" class="btn sm" data-act="fleet-prev"' + (off ? '' : ' disabled') + '>Previous</button>' +
          '<button type="button" class="btn sm" data-act="fleet-next"' + (off + list.length < r.total ? '' : ' disabled') + '>Next</button></div>');
      }
      return null;
    }).catch(err => { txt('fleet-meta', ''); return fail(['ov-fleet'])(err); });
  }
  function loadStats() {
    return get('/stats').then(r => {
      var s = r.stats.segments, b = r.stats.blobs;
      html('seg-meta', s && s.approximate ? st('warn', 'approximate') : '');
      html('blob-meta', b && b.approximate ? st('warn', 'approximate') : '');
      var approx = '<p class="verdict">The S3 store counts through a pointer accumulator; the numbers drift under concurrent writers and after lifecycle GC.</p>';
      $('st-seg').innerHTML = s
        ? '<div class="big">' + fmt(s.count) + '<small>segments · ' + bytes(s.bytes) + '</small></div><div style="margin:14px 0 12px">' +
          stack([[s.rowsSegments, 'c-am'], [s.sqliteSegments, 'c-cy']]) + '</div>' +
          kv([['Rows segments', fmt(s.rowsSegments)], ['SQLite images', fmt(s.sqliteSegments)], ['Bytes', bytes(s.bytes)]]) + (s.approximate ? approx : '')
        : empty('No segment stats', 'No segment store is wired on this admin, or the store does not report stats.', true);
      $('st-blob').innerHTML = b
        ? '<div class="big">' + fmt(b.count) + '<small>blobs · ' + bytes(b.bytes) + '</small></div>' +
          '<div style="margin-top:14px">' + kv([['Blobs', fmt(b.count)], ['Bytes', bytes(b.bytes)], ['Average', b.count ? bytes(Math.round(b.bytes / b.count)) : '–']]) + '</div>' + (b.approximate ? approx : '')
        : empty('No blob stats', 'No blob store is wired on this admin, or the store does not report stats.', true);
      return null;
    }).catch(fail(['st-seg', 'st-blob']));
  }
  function loadCommits() {
    var before = S.commitPages ? S.commitPages[S.commitPages.length - 1] : undefined;
    return get('/commits', { table: $('commits-table').value.trim(), limit: $('commits-limit').value, beforeSeq: before }).then(r => {
      var list = r.commits, f = $('commits-table').value.trim();
      S.commitOldest = list.length ? list[list.length - 1].commitSeq : null;
      txt('n-commits', before === undefined ? fmt(list.length) : '');
      txt('commits-count', fmt(list.length) + ' commits' + (f ? ' touching ' + f : '') + (before === undefined ? '' : ' before seq ' + fmt(before)));
      table('commits-list', [
        { l: 'Seq', c: 'num', d: -1, v: c => c.commitSeq, h: c => '<span class="ty">' + fmt(c.commitSeq) + '</span>' },
        { l: 'Client', c: 'w-sm', v: c => c.clientId, h: c => idCell(c.clientId) },
        { l: 'Actor', c: 'w-sm', v: c => c.actorId, h: c => idText(c.actorId) },
        numCol('Changes', 'changeCount'),
        { l: 'Tables', c: 'fill', ns: true, h: c => tags(c.tables) },
        { l: 'When', c: 'num', d: -1, v: c => c.createdAtMs, h: c => when(c.createdAtMs) }
      ], list, f ? empty('No commits', 'No commit in the newest ' + $('commits-limit').value + ' touched table ' + esc(f) + '.')
        : empty('No commits', before === undefined ? 'The commit log of this partition is empty.' : 'No retained commit is older than seq ' + fmt(before) + '.'), c => { openCommit(c.commitSeq); });
      if (before !== undefined || list.length >= Number($('commits-limit').value)) {
        $('commits-list').insertAdjacentHTML('beforeend', '<div class="acts" style="margin:0;padding:10px 14px;border-top:1px solid var(--line)">' +
          '<button type="button" class="btn sm" data-act="commits-newest"' + (before === undefined ? ' disabled' : '') + '>Newest</button>' +
          '<button type="button" class="btn sm" data-act="commits-newer"' + (before === undefined ? ' disabled' : '') + '>Newer</button>' +
          '<button type="button" class="btn sm" data-act="commits-older"' + (list.length < Number($('commits-limit').value) ? ' disabled' : '') + '>Older</button></div>');
      }
      return null;
    }).catch(fail(['commits-list']));
  }
  var RX_STATE = { pending: 'warn', leased: 'ok', completed: 'idle', 'dead-letter': 'err' };
  function loadReactions() {
    return get('/reactions', { status: $('rx-status').value, type: $('rx-type').value.trim(), limit: 100 }).then(r => {
      var list = r.reactions, counts = {};
      list.forEach(x => { counts[x.status] = (counts[x.status] || 0) + 1; });
      txt('n-reactions', counts['dead-letter'] ? counts['dead-letter'] + ' dead' : fmt(list.length));
      txt('rx-count', Object.keys(counts).map(k => fmt(counts[k]) + ' ' + k).join(' · ') || '0 reactions');
      var order = { 'dead-letter': 0, leased: 1, pending: 2, completed: 3 };
      table('rx-table', [
        { l: 'Key', c: 'w-id', v: x => x.idempotencyKey, h: x => idCell(x.idempotencyKey) },
        { l: 'Type', v: x => x.type, h: x => esc(x.type) + ' <span class="dim">v' + x.version + '</span>' },
        { l: 'Status', v: x => order[x.status], h: x => st(RX_STATE[x.status], x.status) },
        { l: 'Attempts', c: 'num', d: -1, v: x => x.attempts, h: x => x.attempts + ' / ' + x.maxAttempts },
        { l: 'Available', c: 'num', v: x => x.availableAtMs, h: x => '<span title="' + esc(stamp(x.availableAtMs)) + '">' + rel(x.availableAtMs) + '</span>' },
        { l: 'Source', c: 'num', d: -1, v: x => x.sourceCommitSeq, h: x => 'seq ' + fmt(x.sourceCommitSeq) },
        { l: 'Last failure', c: 'fill', v: x => x.lastFailure ? x.lastFailure.code : '', h: x => x.lastFailure ? '<span class="ty err">' + esc(x.lastFailure.code) + '</span>' : '<span class="dim">none</span>' }
      ], list.slice().sort((a, b) => order[a.status] - order[b.status]), empty('No reactions', 'No durable reaction matches. A reaction planner queues reactions atomically with accepted commits.'), x => {
        openModal('Reaction', x.idempotencyKey, true, kv([['Type', esc(x.type) + ' v' + x.version], ['Status', st(RX_STATE[x.status], x.status)],
          ['Attempts', x.attempts + ' of ' + x.maxAttempts], ['Available', esc(stamp(x.availableAtMs))],
          ['Source', '<button type="button" class="tag" data-seq="' + x.sourceCommitSeq + '">commit ' + fmt(x.sourceCommitSeq) + '</button> client ' + idCell(x.sourceClientId)],
          ['Lease', x.leaseOwner ? esc(x.leaseOwner) + ' until ' + esc(stamp(x.leaseExpiresAtMs)) : 'none'],
          ['Last failure', x.lastFailure ? '<code>' + esc(x.lastFailure.code) + '</code> ' + ago(x.lastFailure.atMs) : 'none']]) +
          (INFO.writes && x.status === 'dead-letter' ? '<div class="acts"><button type="button" class="btn sm amber" data-act="retry" data-key="' + esc(x.idempotencyKey) + '">Retry reaction</button></div>' : '') +
          '<h3>Payload</h3>' + json(x.payload), x);
      });
      return null;
    }).catch(err => { txt('rx-count', ''); return fail(['rx-table'])(err); });
  }

  // -- rows, trace, scopes -------------------------------------------------
  // Values follow SPEC §11 rendering: bytes and crdt columns arrive as
  // base64 strings, json and blob_ref columns as parsed JSON.
  function cell(v, type) {
    if (v === null || v === undefined) return '<span class="dim">null</span>';
    if ((type === 'bytes' || type === 'crdt') && typeof v === 'string') {
      var n = Math.floor(v.length * 3 / 4) - (v.slice(-2) === '==' ? 2 : v.slice(-1) === '=' ? 1 : 0);
      return '<span class="trunc" title="' + esc(v) + '">' + type + ' · ' + bytes(n) + ' <span class="dim">base64 ' + esc(v.slice(0, 24)) + (v.length > 24 ? '…' : '') + '</span></span>';
    }
    return trunc(typeof v === 'string' ? v : JSON.stringify(v));
  }
  function schemaOf(t) { return INFO.tables.filter(x => x.name === t)[0]; }
  var HISTORY_COLS = [
    { l: 'Seq', c: 'num', d: -1, v: x => x.commitSeq, h: x => '<span class="ty">' + fmt(x.commitSeq) + '</span>' },
    { l: 'Op', v: x => x.op, h: x => esc(x.op) },
    numCol('Version', 'rowVersion'),
    { l: 'Actor', c: 'w-sm', v: x => x.actorId, h: x => idText(x.actorId) },
    { l: 'Client', c: 'w-sm', v: x => x.clientId, h: x => idCell(x.clientId) },
    { l: 'When', c: 'num fill', d: -1, v: x => x.createdAtMs, h: x => when(x.createdAtMs) }
  ];
  function inspect(t, id) {
    if (!t || !id) { html('rows-result', empty('Table and row id required', 'Enter both a table name and a row id.')); return Promise.resolve(null); }
    $('rows-table').value = t; $('rows-id').value = id;
    html('rows-result', SKEL);
    return get('/rows/' + encodeURIComponent(t) + '/' + encodeURIComponent(id)).then(r => {
      var row = r.row, schema = schemaOf(t);
      S.lastRow = [t, id];
      S.recentRows = [[t, id, row.exists]].concat(S.recentRows.filter(x => x[0] !== t || x[1] !== id)).slice(0, 8);
      html('rows-recent', '<div class="sugg">' + S.recentRows.map(x => {
        return '<button type="button" class="tag" data-rt="' + esc(x[0]) + '" data-rid="' + esc(x[1]) + '">' + esc(x[0]) + ' / ' + esc(x[1]) + (x[2] ? '' : ' (missing)') + '</button>';
      }).join('') + '</div>');
      var scopes = row.scopes ? Object.keys(row.scopes).map(k => k + ': ' + row.scopes[k]) : [];
      html('rows-result', '<div class="row-card"><div class="ph"><h2>' + esc(t) + ' / ' + esc(id) + '</h2><span class="meta">' + (row.exists ? st('ok', 'exists') : st('idle', 'not found')) + '</span>' +
        '<button type="button" class="btn sm" data-act="trace-row" data-t="' + esc(t) + '" data-rid="' + esc(id) + '">Trace for a client</button></div><div class="pb">' +
        (row.exists
          ? kv([['Server version', '<span class="ty">' + fmt(row.serverVersion) + '</span>'], ['Scopes', scopes.length ? tags(scopes) : '<span class="dim">none</span>']]) +
            '<h3>Values</h3><div id="row-values"></div>'
          : empty('No such row', 'The partition holds no row ' + esc(id) + ' in table ' + esc(t) + '.', true)) +
        '<h3>History · ' + row.history.length + '</h3><div id="row-history"></div><h3>Response</h3>' + json(row) + '</div></div>');
      if (row.exists && !row.values) html('row-values', empty('No decoded values', 'The server returned no column values for this row.', true));
      else if (row.exists) {
        var cols = schema ? schema.columns : Object.keys(row.values).map(k => ({ name: k, type: '' }));
        table('row-values', [
          { l: 'Column', v: x => x.name, h: x => esc(x.name) + (x.primaryKey ? ' <span class="st warn">key</span>' : '') },
          { l: 'Type', v: x => x.type, h: x => '<span class="dim">' + esc(x.type) + (x.nullable ? '?' : '') + '</span>' },
          { l: 'Value', c: 'fill', ns: true, h: x => cell(row.values[x.name], x.type) }
        ], cols, empty('No columns', 'The row carries no decoded values.', true));
      }
      table('row-history', HISTORY_COLS, row.history, empty('No history', 'The retained commit log holds no change to this row.', true), x => { openCommit(x.commitSeq); });
      return null;
    }, fail(['rows-result']));
  }
  var VERDICT = {
    delivered: ['ok', 'Delivered', 'The client has pulled the row\\'s last change.'],
    'pending-pull': ['warn', 'Pending pull', 'A subscription covers the row, and the client\\'s cursor is behind the row\\'s last change. The next pull delivers it.'],
    'row-deleted': ['warn', 'Row deleted', 'The row\\'s last change is a delete. A client that held the row drops it on its next pull.'],
    'scope-mismatch': ['err', 'Scope mismatch', 'The client subscribes to the table, but no subscription requests the row\\'s scope values. The mismatches are listed below.'],
    'scope-denied': ['err', 'Scope denied', 'A subscription requests the row\\'s scopes, but the actor\\'s allowed scopes from resolveScopes exclude them, so the server never delivers the row.'],
    'no-subscription': ['err', 'No subscription', 'The client has no subscription on this table.'],
    'client-unknown': ['err', 'Client unknown', 'This partition has no cursor record for the client.'],
    'row-missing': ['err', 'Row missing', 'The partition holds no row with this id in this table.']
  };
  function trace(t, id, client) {
    if (!t || !id || !client) { html('trace-result', empty('Table, row id, and client id required', 'Enter all three fields.')); return Promise.resolve(null); }
    $('trace-table').value = t; $('trace-row').value = id; $('trace-client').value = client;
    html('trace-result', SKEL);
    return get('/trace', { table: t, rowId: id, clientId: client }).then(r => {
      var x = r.trace, v = VERDICT[x.verdict] || ['err', x.verdict, 'The console does not know this verdict.'], lc = x.lastChange, c = x.client;
      S.lastTrace = [t, id, client];
      var detail = x.verdict === 'pending-pull' && c && lc ? ' Cursor ' + fmt(c.cursor) + ', last change at ' + fmt(lc.commitSeq) + '.' : '';
      html('trace-result', '<div class="vbox ' + v[0] + '"><b>' + esc(v[1]) + '</b><span>' + esc(v[2] + detail) + '</span></div>' +
        '<div class="cols" style="padding:0 14px 14px">' +
        '<div class="panel"><div class="ph"><h2>Row</h2></div><div class="pb">' + (x.row && x.row.exists
          ? kv([['Version', fmt(x.row.serverVersion)], ['Scopes', tags(Object.keys(x.row.scopes || {}).map(k => k + ': ' + x.row.scopes[k]))]])
          : empty('Row missing', esc(t) + ' / ' + esc(id), true)) + '</div></div>' +
        '<div class="panel"><div class="ph"><h2>Last change</h2></div><div class="pb">' + (lc
          ? kv([['Commit', '<button type="button" class="tag" data-seq="' + lc.commitSeq + '">' + fmt(lc.commitSeq) + '</button>'], ['Op', esc(lc.op)], ['By', esc(lc.actorId) + ' · ' + idCell(lc.clientId)], ['When', when(lc.createdAtMs)], ['Horizon', fmt(x.horizonSeq)]])
          : empty('No change', 'The retained log holds no change to this row; the horizon is at ' + fmt(x.horizonSeq) + '.', true)) + '</div></div>' +
        '<div class="panel"><div class="ph"><h2>Client</h2></div><div class="pb">' + (c
          ? kv([['Client', '<button type="button" class="tag" data-client="' + esc(client) + '">' + esc(client) + '</button>'], ['Cursor', fmt(c.cursor)], ['Lag', fmt(c.lag)], ['Status', c.active ? st('ok', 'active') : st('idle', 'idle')],
            ['Allowed', x.allowed === undefined ? '<span class="dim">no resolver</span>' : x.allowed === 'outage' ? st('err', 'resolveScopes outage') : tags(Object.keys(x.allowed).map(k => k + ': ' + x.allowed[k].join(', ')))]])
          : empty('Client unknown', esc(client), true)) + '</div></div></div>' +
        '<div class="pb" style="padding-top:0"><h3>Subscriptions · ' + x.subscriptions.length + '</h3><div id="trace-subs"></div>' +
        '<h3>Rejections · ' + x.rejections.length + '</h3><div id="trace-rej"></div>' +
        '<h3>Response</h3>' + json(x) + '</div>');
      table('trace-subs', [
        { l: 'Id', c: 'w-sm', h: s => idCell(s.id) },
        { l: 'Requested scopes', h: s => tags(Object.keys(s.scopes).map(k => k + ': ' + s.scopes[k].join(', '))) },
        { l: 'Requested', h: s => s.requestedMatch ? st('ok', 'covers row') : st('err', 'mismatch') },
        { l: 'Allowed', h: s => s.effectiveMatch === undefined ? '<span class="dim">not checked</span>' : s.effectiveMatch ? st('ok', 'covers row') : st('err', 'denied') },
        { l: 'Mismatches', c: 'fill', h: s => s.mismatches.length ? tags(s.mismatches.map(m => m.variable + ': row ' + m.rowValue + ', requested ' + (m.requested.join(', ') || 'none'))) : '<span class="dim">none</span>' }
      ], x.subscriptions, empty('No subscriptions', 'The client has no subscription on ' + esc(t) + '.', true));
      table('trace-rej', EV_COLS.slice(0, 3).concat([EV_COLS[4]]), x.rejections, empty('No rejections', 'The ring holds no rejected or conflicted push for this row.', true), openEvent);
      return null;
    }, fail(['trace-result']));
  }
  function scopeQuery(variable, value) {
    if (!variable || !value) { html('scopes-table', empty('Variable and value required', 'Enter both a scope variable and a value.')); return Promise.resolve(null); }
    $('scopes-var').value = variable; $('scopes-val').value = value;
    html('scopes-table', SKEL);
    return get('/scope-activity', { variable: variable, value: value }).then(r => {
      S.lastScope = [variable, value];
      txt('scopes-count', fmt(r.activity.length) + ' commits');
      table('scopes-table', [
        { l: 'Seq', c: 'num', d: -1, v: a => a.commitSeq, h: a => '<span class="ty">' + fmt(a.commitSeq) + '</span>' },
        { l: 'Table', v: a => a.table, h: a => esc(a.table) },
        { l: 'Actor', c: 'w-sm', v: a => a.actorId, h: a => idText(a.actorId) },
        numCol('Changes', 'changeCount'),
        { l: 'When', c: 'num fill', d: -1, v: a => a.createdAtMs, h: a => when(a.createdAtMs) }
      ], r.activity, empty('No activity', 'No recent commit touched ' + esc(variable) + ': ' + esc(value) + '.'), a => { openCommit(a.commitSeq); });
      return null;
    }, err => { txt('scopes-count', ''); return fail(['scopes-table'])(err); });
  }

  // -- event tail: SSE when the ring is wired, polled otherwise -------------
  var MODE = {
    idle: ['', 'Connecting'], connecting: ['', 'Connecting'], live: ['ok', 'Live'], poll: ['warn', 'Polling'],
    closed: ['err', 'Stream closed'], off: ['warn', 'No event ring'], error: ['err', 'Events failed']
  };
  function setMode(mode) {
    tail.mode = mode;
    var m = tail.paused ? ['warn', 'Paused'] : MODE[mode];
    $('live').className = 'pill ' + m[0];
    $('live').lastChild.textContent = m[1];
    var b = '';
    if (tail.paused) b = '<div class="banner"><b>Paused</b><span>' + fmt(tail.held.length) + ' new events held. The list stays still until you resume.</span><button class="btn sm" type="button" data-act="pause">Resume</button></div>';
    else if (mode === 'poll') b = '<div class="banner"><b>Polling</b><span>The parent-frame transport carries no event stream. Events reload with every refresh (<kbd>r</kbd>) and with auto refresh.</span></div>';
    else if (mode === 'closed') b = '<div class="banner err"><b>Stream closed</b><span>The live event stream failed (authorization, network, or the server closed it). Events now reload with every refresh.</span><button class="btn sm" type="button" data-act="reconnect">Reconnect</button></div>';
    else if (mode === 'off') b = '<div class="banner"><b>No event ring</b><span>This admin has no <code>RingBufferEvents</code> wired, so there is no event tail and no metrics. Pass <code>ring</code> to <code>SyncularAdmin.fromConfig</code>.</span></div>';
    html('ev-banner', b);
    txt('ev-pause', tail.paused ? 'Resume' + (tail.held.length ? ' (' + tail.held.length + ')' : '') : 'Pause');
    $('ev-pause').className = 'btn sm' + (tail.paused ? ' on' : '');
  }
  function tailFilters() {
    var kind = $('ev-kind').value, p = { limit: MAX_TAIL };
    if (kind && kind.indexOf('.') > 0) p.type = kind;
    var c = $('ev-client').value.trim();
    if (c) p.clientId = c;
    return p;
  }
  var EV_COLS = [
    { l: 'Time', d: -1, v: e => e.atMs, h: e => '<span title="' + esc(stamp(e.atMs)) + '">' + clock(e.atMs, true) + '</span>' },
    { l: 'Level', v: e => { return { err: 0, warn: 1, info: 2 }[level(e)]; }, h: e => { var l = level(e); return st(l === 'info' ? 'idle' : l, LEVEL_LABEL[l]); } },
    { l: 'Type', v: e => e.type, h: e => '<span class="ty ' + level(e) + '">' + esc(e.type) + '</span>' },
    { l: 'Client', c: 'w-sm', v: e => e.clientId || e.actorId || '', h: e => {
      return e.clientId ? idCell(e.clientId) : '<span class="dim">' + esc(e.actorId || e.workerId || '') + '</span>';
    } },
    { l: 'Detail', c: 'fill', ns: true, h: e => trunc(summary(e)) }
  ];
  function renderTail() {
    var kind = $('ev-kind').value, lv = $('ev-level').value, q = $('ev-q').value.trim().toLowerCase();
    var rows = tail.list.filter(e => {
      if (kind && kind.indexOf('.') < 0 && e.type.indexOf(kind + '.') !== 0) return false;
      var l = level(e);
      if (lv === 'err' && l !== 'err') return false;
      if (lv === 'warn' && l === 'info') return false;
      return !q || JSON.stringify(e).toLowerCase().indexOf(q) >= 0;
    });
    txt('n-events', tail.mode === 'off' ? '' : fmt(tail.list.length));
    txt('ev-count', rows.length === tail.list.length ? fmt(rows.length) + ' events' : fmt(rows.length) + ' of ' + fmt(tail.list.length) + ' events');
    table('ev-table', EV_COLS, rows, tail.mode === 'off'
      ? empty('No event ring', 'The event tail needs a <code>RingBufferEvents</code> passed to the admin.')
      : tail.list.length ? empty('No match', fmt(tail.list.length) + ' buffered events, none match the filters.')
        : empty('No events yet', 'The tail fills as clients push, pull, and connect.'), openEvent);
  }
  function stopStream() { if (tail.src) { tail.src.close(); tail.src = null; } }
  function connectStream() {
    stopStream();
    tail.list = []; tail.held = [];
    setMode('connecting');
    renderTail();
    var src = new EventSource(base + '/events/stream' + qs(tailFilters()));
    tail.src = src;
    src.onopen = () => { setMode('live'); };
    src.onmessage = msg => {
      var e = JSON.parse(msg.data);
      if (tail.paused) {
        tail.held.unshift(e);
        if (tail.held.length > MAX_TAIL) tail.held.length = MAX_TAIL;
        setMode(tail.mode);
        return;
      }
      if (tail.mode !== 'live') setMode('live');
      tail.list.unshift(e);
      if (tail.list.length > MAX_TAIL) tail.list.length = MAX_TAIL;
      renderTail();
    };
    src.onerror = () => {
      src.close();
      if (tail.src === src) { tail.src = null; setMode('closed'); }
    };
  }
  function startTail() {
    stopStream();
    tail.list = []; tail.held = [];
    setMode('connecting');
    if (!INFO.hasEventStream) { setMode('off'); renderTail(); return Promise.resolve(null); }
    if (!parentTransport && typeof EventSource === 'function') { connectStream(); return Promise.resolve(null); }
    return get('/events', tailFilters()).then(res => {
      tail.list = res.events;
      setMode('poll');
      renderTail();
      return null;
    }, err => { if (err !== STALE) setMode('error'); return fail(['ev-table'])(err); });
  }
  function loadTail() {
    if (tail.mode === 'live' || tail.mode === 'connecting') return Promise.resolve(null);
    if (tail.mode !== 'poll' && tail.mode !== 'closed') return startTail();
    if (tail.paused) return Promise.resolve(null);
    return get('/events', tailFilters()).then(res => { tail.list = res.events; renderTail(); return null; }, fail(['ev-table']));
  }
  function togglePause() {
    tail.paused = !tail.paused;
    if (!tail.paused && tail.held.length) {
      tail.list = tail.held.concat(tail.list).slice(0, MAX_TAIL);
      tail.held = [];
    }
    setMode(tail.mode);
    renderTail();
  }

  // -- drill-down modal ----------------------------------------------------
  var modal = $('modal'), help = $('help'), modalToken = 0;
  function modalTab(which) {
    $('m-sum').hidden = which !== 'sum';
    $('m-json').hidden = which === 'sum';
    $('m-tab-sum').setAttribute('aria-pressed', String(which === 'sum'));
    $('m-tab-json').setAttribute('aria-pressed', String(which !== 'sum'));
  }
  function openModal(kicker, title, copyable, sumHtml, data) {
    modalToken++;
    txt('m-kicker', kicker);
    txt('m-title', title);
    $('m-title').title = title;
    $('m-copy').hidden = !copyable;
    $('m-copy').setAttribute('data-copy', title);
    html('m-copy', COPY_SVG);
    fillModal(sumHtml, data);
    modalTab('sum');
    if (!modal.open) modal.showModal();
    return modalToken;
  }
  function fillModal(sumHtml, data) {
    html('m-sum', sumHtml);
    html('m-json', data === undefined ? SKEL : json(data));
  }
  function openClient(id) {
    var token = openModal('Client', id, true, SKEL);
    get('/clients/' + encodeURIComponent(id), { eventLimit: 50 }).then(r => {
      if (token !== modalToken) return;
      var d = r.detail, c = d.client;
      if (!d.exists) { fillModal(empty('No record', 'This partition has no cursor record for client ' + esc(id) + '.'), d); return; }
      var lease = d.lease
        ? esc(d.lease.leaseId) + ' · ' + (d.lease.revoked ? st('err', 'revoked') : d.lease.expiresAtMs > Date.now() ? st('ok', 'expires ' + rel(d.lease.expiresAtMs)) : st('warn', 'expired'))
        : '<span class="dim">none</span>';
      var head = S.horizon ? S.horizon.maxCommitSeq : null;
      var acts = '<div class="acts" style="margin:0 0 14px"><button type="button" class="btn sm" data-act="trace-client" data-cid="' + esc(id) + '">Trace a row for this client</button>' +
        (INFO.writes && d.lease && !d.lease.revoked ? '<button type="button" class="btn sm amber" data-act="revoke" data-cid="' + esc(id) + '">Revoke lease</button>' : '') + '</div>';
      fillModal(acts + kv([['Actor', esc(c.actorId)], ['Status', c.active ? st('ok', 'active') : st('idle', 'idle')], ['Wire version', c.wireVersion == null ? '–' : 'v' + c.wireVersion + (c.schemaVersion == null ? '' : ' <span class="dim">schema ' + c.schemaVersion + '</span>')],
        ['Realtime', d.realtime === undefined ? '<span class="dim">no realtime hub</span>' : d.realtime === 'open' ? st('ok', 'socket open') : st('idle', 'closed')],
        ['Cursor', fmt(c.cursor)], ['Lag', fmt(c.lag) + ' commits' + (head !== null ? ' <span class="dim">behind head ' + fmt(head) + '</span>' : '')],
        ['Last seen', esc(ago(c.updatedAtMs)) + ' <span class="dim">' + esc(stamp(c.updatedAtMs)) + '</span>'], ['Lease', lease]]) +
        '<h3>Subscriptions · ' + c.subscriptions.length + '</h3><div id="m-subs"></div><h3>Recent events · ' + d.events.length + '</h3><div id="m-events"></div>', d);
      table('m-subs', [
        { l: 'Id', c: 'w-sm', h: s => idCell(s.id) },
        { l: 'Table', h: s => esc(s.table) },
        { l: 'Scopes', c: 'fill', h: s => tags(Object.keys(s.scopes).map(k => k + ': ' + s.scopes[k].join(', '))) }
      ], c.subscriptions, empty('No subscriptions', 'The client has no active subscriptions.', true));
      table('m-events', EV_COLS.slice(0, 3).concat([EV_COLS[4]]), d.events, empty('No events', 'The ring holds no events for this client.', true));
    }, err => { if (token === modalToken && err !== STALE) fillModal(errBox(err), { code: err.code, message: err.message }); });
  }
  function openCommit(seq) {
    var token = openModal('Commit ' + fmt(seq), '…', false, SKEL);
    get('/commits/' + seq).then(r => {
      if (token !== modalToken) return null;
      var c = r.commit;
      txt('m-title', c.clientCommitId);
      $('m-copy').hidden = false;
      $('m-copy').setAttribute('data-copy', c.clientCommitId);
      fillModal(kv([['Seq', '<span class="ty">' + fmt(c.commitSeq) + '</span>'],
        ['Client', '<button type="button" class="tag" data-client="' + esc(c.clientId) + '">' + esc(c.clientId) + '</button>'],
        ['Actor', esc(c.actorId)], ['Created', esc(stamp(c.createdAtMs)) + ' <span class="dim">' + ago(c.createdAtMs) + '</span>']]) +
        '<h3>Changes · ' + c.changes.length + '</h3><div id="m-changes"></div><h3>Ring events</h3><div id="m-events">' + SKEL + '</div>', r);
      table('m-changes', [
        { l: 'Table', v: x => x.table, h: x => esc(x.table) },
        { l: 'Row', c: 'w-sm', v: x => x.rowId, h: x => idCell(x.rowId) },
        { l: 'Op', v: x => x.op, h: x => esc(x.op) + (x.undecodable ? ' ' + st('err', 'undecodable') : '') },
        numCol('Version', 'rowVersion'),
        { l: 'Scopes', c: 'fill', ns: true, h: x => tags(Object.keys(x.scopes || {}).map(k => k + ': ' + x.scopes[k])) }
      ], c.changes, empty('No changes', 'The commit carries no row changes.', true), x => { modal.close(); go('rows'); inspect(x.table, x.rowId); });
      if (!INFO.hasEventStream) { html('m-events', ringOff('Push events come from the event ring.')); return null; }
      return get('/events', { clientId: c.clientId, limit: MAX_TAIL }).then(e => {
        if (token !== modalToken) return;
        var related = e.events.filter(x => x.clientCommitId === c.clientCommitId || (x.commitSeq === c.commitSeq && !x.clientCommitId));
        table('m-events', EV_COLS.slice(0, 3).concat([EV_COLS[4]]), related, empty('No events', 'The ring no longer holds events for this commit.', true));
      }, fail(['m-events']));
    }, err => { if (token === modalToken && err !== STALE) fillModal(errBox(err), { code: err.code, message: err.message }); });
  }
  function openEvent(e) {
    var keys = Object.keys(e).filter(k => k !== 'type' && k !== 'atMs');
    openModal(LEVEL_LABEL[level(e)] + ' event', e.type, false, kv([['Time', esc(stamp(e.atMs))], ['Summary', esc(summary(e))]].concat(keys.map(k => {
      var v = e[k];
      return [k, typeof v === 'string' ? (k.slice(-2) === 'Id' ? idCell(v) : esc(v)) : typeof v === 'object' ? '<code>' + esc(JSON.stringify(v)) + '</code>' : esc(String(v))];
    }))), e);
  }

  // -- view routing and refresh --------------------------------------------
  var LOADERS = {
    overview: () => [loadMetrics(), loadErrors(), loadHorizon(['ov-horizon']), loadClients(), loadFleet()],
    clients: () => [loadClients(), S.horizon ? null : loadHorizon([])],
    commits: () => [loadCommits()],
    rows: () => [S.lastRow ? inspect(S.lastRow[0], S.lastRow[1]) : null],
    trace: () => [S.lastTrace ? trace(S.lastTrace[0], S.lastTrace[1], S.lastTrace[2]) : null, S.clients ? null : loadClients()],
    scopes: () => [S.lastScope ? scopeQuery(S.lastScope[0], S.lastScope[1]) : null, loadClients()],
    events: () => [loadTail()],
    reactions: () => [loadReactions()],
    storage: () => [loadStats(), loadHorizon(['st-horizon'])]
  };
  var busy = {};
  function report(errs) {
    var auth = errs.filter(e => e.code === 'sync.auth_required')[0];
    $('alert').hidden = !auth;
    if (auth) html('alert', '<b>sync.auth_required</b><span>The host\\'s authorize guard rejected the console\\'s requests. Sign in to the host, or open the console with the credentials its guard expects, then refresh.</span>');
    $('updated').className = errs.length ? 'err' : '';
    txt('updated', errs.length ? errs.length + ' failed · ' + (errs[0].code || 'console.render_failed') : 'Updated ' + clock(Date.now()));
  }
  // Every view needs the capability record first; a failed /info renders
  // its error into every panel, and refresh retries it.
  function boot() {
    txt('updated', 'Loading…');
    return get('/info').then(r => {
      INFO = r;
      html('tables-list', r.tables.map(t => '<option value="' + esc(t.name) + '"></option>').join(''));
      startTail();
      return show(location.hash.slice(2));
    }, err => {
      if (err === STALE) return;
      document.querySelectorAll('[data-skel]').forEach(h => { h.innerHTML = errBox(err); });
      setMode('error');
      report([err]);
    });
  }
  function load() {
    var view = S.view;
    if (!INFO) return boot();
    if (busy[view]) return busy[view];
    $('updated').className = '';
    txt('updated', 'Loading…');
    busy[view] = Promise.all(LOADERS[view]()).then(results => {
      busy[view] = null;
      report(results.filter(Boolean));
    });
    return busy[view];
  }
  function show(view) {
    if (VIEWS.indexOf(view) < 0) view = 'overview';
    S.view = view;
    VIEWS.forEach(v => {
      $('view-' + v).hidden = v !== view;
      if (v === view) $('nav-' + v).setAttribute('aria-current', 'page'); else $('nav-' + v).removeAttribute('aria-current');
    });
    if (location.hash !== '#/' + view) history.replaceState(null, '', '#/' + view);
    return load();
  }
  function go(view) { if (view !== S.view) history.pushState(null, '', '#/' + view); return show(view); }
  function setPartition(p) {
    $('partition').value = p;
    partitionChanged();
  }
  function partitionChanged() {
    if (modal.open) modal.close();
    epoch++;
    busy = {};
    reset();
    if (!INFO) { boot(); return; }
    startTail();
    show(S.view);
  }
  var timer = null;
  function setAuto(ms) {
    $('auto').value = String(ms);
    if (timer) clearInterval(timer);
    timer = ms > 0 ? setInterval(load, ms) : null;
    $('auto').className = 'btn' + (ms > 0 ? ' on' : '');
  }
  var toastTimer = null;
  function toast(text) {
    txt('toast', text);
    $('toast').hidden = false;
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { $('toast').hidden = true; }, 2200);
  }
  function copy(text) {
    if (!navigator.clipboard) { toast('Clipboard unavailable: the page is not a secure context'); return; }
    navigator.clipboard.writeText(text).then(() => { toast('Copied ' + text); }, () => { toast('Copy failed: the browser denied clipboard access'); });
  }
  var confirmBox = $('confirm'), pending = null;
  function confirmWrite(title, body, path, after) {
    pending = { path: path, after: after };
    txt('c-text', title);
    html('c-body', '<p class="verdict" style="margin:0">' + body + '</p><p class="verdict">The console sends <code>POST ' + esc(path) + '</code>.</p>');
    $('c-ok').hidden = false;
    txt('c-cancel', 'Cancel');
    confirmBox.showModal();
  }
  function runWrite() {
    var w = pending;
    $('c-ok').hidden = true;
    html('c-body', SKEL);
    post(w.path).then(r => {
      html('c-body', '<p class="verdict" style="margin:0 0 12px"><b class="ty">Done</b>The server answered:</p>' + json(r));
      toast('Write applied: POST ' + w.path);
      w.after();
    }, err => { html('c-body', err === STALE ? '' : errBox(err)); }).then(() => { txt('c-cancel', 'Close'); });
  }
  var ACTS = {
    pause: () => togglePause(),
    reconnect: () => connectStream(),
    'err-tab': el => { ERR_TAB = el.getAttribute('data-tab'); if (S.errors) renderErrors(); },
    'commits-older': () => { S.commitPages = (S.commitPages || []).concat([S.commitOldest]); loadCommits(); },
    'commits-newer': () => { S.commitPages = S.commitPages.slice(0, -1); if (!S.commitPages.length) S.commitPages = null; loadCommits(); },
    'commits-newest': () => { S.commitPages = null; loadCommits(); },
    'fleet-prev': () => { S.fleetOffset = Math.max(0, S.fleetOffset - FLEET_PAGE); loadFleet(); },
    'fleet-next': () => { S.fleetOffset += FLEET_PAGE; loadFleet(); },
    'trace-row': el => { $('trace-table').value = el.getAttribute('data-t'); $('trace-row').value = el.getAttribute('data-rid'); go('trace'); $('trace-client').focus(); },
    'trace-client': el => { modal.close(); $('trace-client').value = el.getAttribute('data-cid'); go('trace'); $('trace-table').focus(); },
    retry: el => {
      var k = el.getAttribute('data-key');
      confirmWrite('Retry reaction ' + k, 'The reaction returns to pending with its attempts reset, and a worker claims it again.', '/reactions/' + encodeURIComponent(k) + '/retry', () => { modal.close(); loadReactions(); });
    },
    prune: () => {
      var h = S.horizon;
      confirmWrite('Prune the commit log', 'A prune pass advances the horizon of partition ' + esc(h.partition) + ' from ' + fmt(h.horizonSeq) + ' toward ' + fmt(h.recommendedHorizonSeq) +
        ' and deletes the commits below it. A client whose cursor falls under the new horizon re-bootstraps.', '/prune', load);
    },
    revoke: el => {
      var id = el.getAttribute('data-cid');
      confirmWrite('Revoke the lease of ' + id, 'The client loses its lease at once; its next request needs a fresh authorized round.', '/clients/' + encodeURIComponent(id) + '/revoke-lease', () => { openClient(id); });
    }
  };
  function pickRow(tr) {
    var id = tr.closest('[data-tbl]').getAttribute('data-tbl'), t = T[id];
    if (t && t.pick) t.pick(t.rows[Number(tr.getAttribute('data-i'))]);
  }

  // -- wiring --------------------------------------------------------------
  $('ev-kind').innerHTML = '<option value="">All kinds</option><optgroup label="Families">' +
    ['request', 'push', 'pull', 'realtime', 'reaction', 'segment', 'blob', 'prune', 'scopes', 'lease'].map(f => '<option value="' + f + '">' + f + '.*</option>').join('') +
    '</optgroup><optgroup label="Types">' + EVENT_TYPES.map(t => '<option value="' + t + '">' + t + '</option>').join('') + '</optgroup>';
  document.addEventListener('click', e => {
    var t = e.target, el;
    if (!t || !t.closest) return;
    if ((el = t.closest('[data-copy]'))) { e.stopPropagation(); copy(el.getAttribute('data-copy')); return; }
    if ((el = t.closest('[data-sort]'))) { sortBy(el.closest('[data-tbl]').getAttribute('data-tbl'), Number(el.getAttribute('data-sort'))); return; }
    if ((el = t.closest('[data-client]'))) { openClient(el.getAttribute('data-client')); return; }
    if ((el = t.closest('[data-sv]'))) { scopeQuery(el.getAttribute('data-sv'), el.getAttribute('data-sval')); return; }
    if ((el = t.closest('[data-rt]'))) { inspect(el.getAttribute('data-rt'), el.getAttribute('data-rid')); return; }
    if ((el = t.closest('[data-act]'))) { ACTS[el.getAttribute('data-act')](el); return; }
    if ((el = t.closest('[data-seq]'))) { openCommit(Number(el.getAttribute('data-seq'))); return; }
    if ((el = t.closest('tr[data-i]'))) { pickRow(el); return; }
    if ((el = t.closest('.side a'))) { e.preventDefault(); go(el.id.slice(4)); }
  });
  document.addEventListener('keydown', e => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    var t = e.target, tag = t && t.tagName;
    if (e.key === 'Enter' && tag === 'TR' && t.hasAttribute('data-i')) { e.preventDefault(); pickRow(t); return; }
    if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') { if (e.key === 'Escape') t.blur(); return; }
    if (modal.open || help.open || confirmBox.open) return;
    var n = Number(e.key);
    if (n >= 1 && n <= VIEWS.length) go(VIEWS[n - 1]);
    else if (e.key === 'r') load();
    else if (e.key === 'a') { var o = [0, 2000, 5000, 15000]; setAuto(o[(o.indexOf(Number($('auto').value)) + 1) % o.length]); }
    else if (e.key === '/') { var f = document.querySelector('#view-' + S.view + ' [data-focus]'); if (f) f.focus(); }
    else if (e.key === 'p') $('partition').focus();
    else if (e.key === ' ' && S.view === 'events' && tag !== 'BUTTON') togglePause();
    else if (e.key === '?') help.showModal();
    else return;
    e.preventDefault();
  });
  window.addEventListener('hashchange', () => { var v = location.hash.slice(2); if (v !== S.view) show(v); });
  window.addEventListener('popstate', () => { var v = location.hash.slice(2); if (v !== S.view) show(v); });
  $('refresh').addEventListener('click', () => { load(); });
  $('auto').addEventListener('change', () => setAuto(Number($('auto').value)));
  $('help-btn').addEventListener('click', () => { help.showModal(); });
  $('help-close').addEventListener('click', () => { help.close(); });
  $('m-close').addEventListener('click', () => { modal.close(); });
  $('m-tab-sum').addEventListener('click', () => { modalTab('sum'); });
  $('m-tab-json').addEventListener('click', () => { modalTab('json'); });
  $('c-ok').addEventListener('click', runWrite);
  $('c-cancel').addEventListener('click', () => { confirmBox.close(); });
  [modal, help, confirmBox].forEach(d => { d.addEventListener('click', e => { if (e.target === d) d.close(); }); });
  $('partition').addEventListener('change', partitionChanged);
  $('clients-q').addEventListener('input', () => { if (S.clients) renderClients(); });
  $('clients-active').addEventListener('change', () => { if (S.clients) renderClients(); });
  $('commits-table').addEventListener('change', () => { S.commitPages = null; loadCommits(); });
  $('commits-limit').addEventListener('change', () => { S.commitPages = null; loadCommits(); });
  $('rows-form').addEventListener('submit', e => { e.preventDefault(); inspect($('rows-table').value.trim(), $('rows-id').value.trim()); });
  $('trace-form').addEventListener('submit', e => { e.preventDefault(); trace($('trace-table').value.trim(), $('trace-row').value.trim(), $('trace-client').value.trim()); });
  $('scopes-form').addEventListener('submit', e => { e.preventDefault(); scopeQuery($('scopes-var').value.trim(), $('scopes-val').value.trim()); });
  function refilter() { if (tail.mode === 'live' || tail.mode === 'connecting') connectStream(); else loadTail(); }
  $('ev-kind').addEventListener('change', refilter);
  $('ev-client').addEventListener('change', refilter);
  $('ev-level').addEventListener('change', renderTail);
  $('ev-q').addEventListener('input', renderTail);
  $('ev-pause').addEventListener('click', togglePause);
  $('ev-clear').addEventListener('click', () => { tail.list = []; tail.held = []; setMode(tail.mode); renderTail(); });
  $('rx-status').addEventListener('change', loadReactions);
  $('rx-type').addEventListener('change', loadReactions);

  reset();
  boot();
})();
</script>
</body>
</html>`.replace(/^ +(?:\/\/.*\n)?/gm, '');
