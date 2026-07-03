# syncular v2 — two-pane convergence demo (B6)

Two independent `SyncClient`s from `@syncular-v2/web-client` — each on its
own sqlite-wasm database — syncing a todo list through the B2 server
(server-hono adapter, bun:sqlite storage) in one Bun process.

## Run

```sh
cd v2
bun install
cd apps/demo
bun run dev          # http://localhost:8787 (PORT=… to override)
```

One process serves everything on one port:

- `POST /sync`, `GET /segments/:id` — the server-hono adapter
- `GET /realtime` — WebSocket wired to the server's `RealtimeHub`
- `/`, `/app.js` — the frontend (built with `Bun.build` at startup)
- `/vendor/sqlite-wasm/*` — the `@sqlite.org/sqlite-wasm` package files

Server storage is in-memory by default; `SYNCULAR_DEMO_DB=path bun run dev`
persists it to a file.

## What to try

- **Convergence**: add/toggle/delete todos in pane A; they appear in pane B
  via realtime deltas (and vice versa).
- **Offline replay**: "Go offline" in a pane, keep editing — the outbox
  counter grows. "Go online" drains it with idempotent retry.
- **Conflict surfacing**: "Simulate conflict" creates a row, takes pane A
  offline, edits the row in both panes (pane B's edit wins on the server),
  then asks you to toggle pane A online — the replayed stale-`baseVersion`
  commit surfaces a §6.3 conflict record (never auto-resolved) in pane A.

## Notes

- **Schema is typegen-generated** (B5 dogfood): `syncular.json` +
  `migrations/0001_initial/up.sql` → `bun run generate` →
  `src/syncular.generated.ts` (committed). Both server and clients import
  it.
- **sqlite-wasm backend**: the page is served with COOP/COEP headers, but
  sqlite-wasm's OPFS VFS refuses the main thread regardless (it needs
  `Atomics.wait()`, a worker-only API), so `openWasmDatabase` uses its
  documented in-memory fallback. The pane badge shows the backend actually
  in use. Persistent OPFS arrives with worker mode (post-gate B3 surface).
- The demo intentionally has zero dependencies beyond the workspace
  packages; the frontend is vanilla DOM.
