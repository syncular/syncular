# syncular v2 — two-pane convergence demo (B6)

Two independent client cores from `@syncular-v2/web-client` — each a Web
Worker running the WHOLE core (SyncClient + transports + sqlite-wasm on
persistent OPFS via `opfs-sahpool`, Direction decision 2) — syncing a
todo list through the B2 server (server-hono adapter, bun:sqlite storage)
in one Bun process. The page drives each core through the
`SyncClientHandle` RPC. Add `?ephemeral` for the explicit in-memory
main-thread mode (labeled; nothing survives a reload).

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
- `/`, `/app.js`, `/worker.js` — the frontend + the sync-worker bundle
  (both built with `Bun.build` at startup; the sqlite-wasm bare specifier
  is rewritten to the vendor path because module workers never see the
  page's import map)
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
- **sqlite-wasm backend**: each pane's worker opens a persistent database
  (`demo-a` / `demo-b`) on the `opfs-sahpool` VFS — no COOP/COEP needed
  (the headers are still served, but sahpool runs on
  `FileSystemSyncAccessHandle`, not SharedArrayBuffer). The pane badge
  shows the mode in use. With the default in-memory SERVER storage, a
  server restart forgets commits that the panes' persistent databases
  still hold — use `SYNCULAR_DEMO_DB` for a symmetric persistence story.
- **Realtime attaches after the first sync**: the hub session binds to the
  client record a sync round creates (§8.1 fixed registration), so panes
  connect the socket after their initial pull.
- The demo intentionally has zero dependencies beyond the workspace
  packages; the frontend is vanilla DOM.
