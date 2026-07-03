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
- **Connect-then-sync boot order** (§8.7): panes connect the socket
  first, then run their first sync round OVER it — the round registers
  this connection's subscriptions at round end, so the old
  "connect-before-first-pull ⇒ silent no-fanout" footgun (§8.1 fixed
  registration) no longer exists. All sync rounds ride the WebSocket
  once it is connected; `POST /sync` stays server-side for
  producers/tooling and segment downloads stay on HTTP.
- The demo intentionally has zero dependencies beyond the workspace
  packages; the frontend is vanilla DOM.

## Multi-tab (TODO 3.2)

The two panes simulate two **devices**: they use *distinct* lock names, so
each pane is its own leader with its own core and DB. Multi-tab followers
are about the SAME lock name across real browser **tabs** of one origin.

To see leader + follower live, open the demo in two browser tabs with
`?multitab` on both (this flips `createSyncClientHandle({ multiTab: true })`
and uses one shared lock name per pane across tabs). The first tab's pane
becomes the leader (spawns the worker, owns the OPFS DB, holds the socket);
the second tab's pane becomes a follower proxying to it over a
BroadcastChannel — the badge shows `leader` / `follower`. Close the leader
tab and the follower promotes (badge flips to `leader`) and keeps syncing.

**Browser verification to run (orchestrator follow-up):** open two tabs on
`?multitab`, confirm one badge reads `leader` and the other `follower`;
mutate in the follower and confirm it converges (one socket in the network
panel, on the leader tab only); close the leader tab and confirm the
follower's badge flips to `leader` and edits still sync. Cross-tab Web
Locks + BroadcastChannel are browser-only (bun has no `navigator.locks`),
so this path is covered in-process by `web-client/test/multi-tab.test.ts`
and needs a real-browser pass here.
