# syncular sync lab

A laptop and a phone, each running an independent client core from
`@syncular/client`, edit one Release board (a kanban of boards, members,
cards, labels, and comments) through one server. The server's commit log
sits between them. The laptop signs in as Ada, the team lead, who is a
member of the Web and Mobile boards; the phone signs in as Ben, a mobile
engineer, who is a member of the Mobile board only. The default dev mode runs each core in a Web Worker
over sqlite-wasm on persistent OPFS (`opfs-sahpool`), driven through the
`SyncClientHandle` RPC; the server (server-hono adapter, bun:sqlite storage)
runs in the same Bun process. Add `?ephemeral` for the explicit in-memory
main-thread mode (labeled; nothing survives a reload).

## Run

```sh
bun install
cd apps/demo
bun run dev          # http://localhost:8787 (PORT=… and HOST=… to override)
```

OPFS and `crypto.randomUUID` need a secure context: `localhost` or HTTPS.
To open the lab from another machine, put a TLS proxy in front of
`HOST=127.0.0.1` (for example `tailscale serve`).

One process serves everything on one port:

- `POST /sync`, `GET /segments/:id`: the server-hono adapter; requests
  name their actor in `x-syncular-demo-actor` (`ada` or `ben`)
- `GET /realtime?actor=…`: WebSocket wired to the server's `RealtimeHub`
- `GET /events`: server-sent events from the server event ring, the
  retained backlog first and then every new event; the commit log, the
  packets, and the tour read it
- `/`, `/app.js`, `/worker.js`: the frontend and the sync-worker bundle
  (both built with `Bun.build` at startup; the sqlite-wasm bare specifier
  is rewritten to the vendor path because module workers never see the
  page's import map)
- `/vendor/sqlite-wasm/*`: the `@sqlite.org/sqlite-wasm` package files
- `/favicon.svg`, `/fonts/*`: the docs site's mark and self-hosted IBM Plex
  files from `apps/docs/public`

Server storage is in-memory by default; `SYNCULAR_DEMO_DB=path bun run dev`
persists it to a file.

`bun run build:static [outDir]` emits the hosted version (`dist/` by default;
the docs build passes `../docs/dist/demo`, which serves it at
syncular.dev/demo/): the same page,
with the server core running over sqlite-wasm in a third Web Worker and
in-memory main-thread client cores whose transports post into it. The
worker streams its event ring to the page over the same RPC.

## The Release board model

`migrations/0001_initial/up.sql` defines six tables, each carrying
`board_id` and synced under `board:{board_id}`: `boards` (whose `board_id`
equals its `id`), `members` (one row per board membership), `cards`,
`labels`, `card_labels`, and `comments`. Child tables declare references to
their parents.

`src/seed.ts` holds the sample data: two boards, four people, 24 cards
across `backlog`, `doing`, `review`, and `done`, six labels per board, the
card-label links, and 12 comments, with ids and timestamps derived from a
fixed base. It exports the typed rows (`releaseBoardSeed`) and the
`seedMutations` builder (`releaseBoardSeedMutations`). The Bun server, the
embedded server worker, and the SYQL playground in `apps/docs` all load
this one module, so a playground query returns the rows the lab shows.

`src/access.ts` is the authorization: `resolveScopes` returns the boards an
actor has a `members` row on (`m-{board}-{actor}`). The seed runs as an
`operator` actor with every board. Granting or revoking a board is an
ordinary write to `members`.

## What the lab shows

- **Commit log** (`src/frontend/lab.ts`): server events folded into one
  entry per client commit. `push.applied`, `push.conflicted`, and
  `push.rejected` create entries; `realtime.delta` and `pull.served` record
  receivers by sequence number (the hub fans a commit out before the
  pusher's `push.applied` is emitted). Each device records the intent of
  its writes under the `clientCommitId` that `mutate` returns, which names
  the write and its board scope in the log.
- **Board** (`src/frontend/device.ts`): each device subscribes every table
  per board (`cards:mobile`, `members:web`, …), so a revocation revokes
  whole subscriptions and triggers the §3.3 purge. Cards move by mouse
  drag, or through the card sheet's column buttons on touch and keyboard.
  A move is a sparse `patch` of `column_id` and `position` (`planMove` in
  `lab.ts`); edits patch only the changed columns.
- **Scopes**: "Grant Web" makes the laptop upsert `m-web-ben`; the phone
  subscribes to `board:web` and bootstraps it. "Revoke Web" deletes the
  row; the phone's next round returns its Web subscriptions as revoked and
  the phone purges the rows.
- **Local SQL**: a read-only console per device over `client.query()`,
  with example joins, aggregates, and a window function.
- **Offline replay**: each device's network switch severs its transport;
  the outbox panel lists the pending commits and drains on reconnect.
- **Conflicts**: "Simulate conflict" takes both devices offline, moves one
  Mobile card to different columns, and reconnects the phone first. The
  laptop's replay surfaces a §6.3 conflict record, which the card sheet
  resolves with `resolveCommitOutcome` (keep server, or a superseding patch
  to keep its value).
- **Latency**: in the hosted build, a slider delays every page-to-worker
  message by half the round trip in each direction, in order per lane.
- **Guided tour**: five steps that complete from log entries, the phone's
  outbox and SQL runs, and open conflicts (`advanceTour` in `lab.ts`,
  covered by `lab.test.ts`).
- **Server console**: in the hosted lab, "Server console" opens the
  graphical `SyncularAdmin` interface in a drawer. The interface reads the
  embedded server worker and displays horizon status, metrics, store stats,
  clients, commit metadata, row inspection, scope activity, and the event
  tail for the in-page `demo` partition. For the Bun server operator
  console, run `SYNCULAR_DEMO_ADMIN=1 bun run dev` and open `/admin`.

## Notes

- **Schema is typegen-generated**: `syncular.json` +
  `migrations/0001_initial/up.sql` → `bun run generate` →
  `src/syncular.generated.ts` (committed). Both server and clients import
  it.
- **sqlite-wasm backend**: each device's worker opens a persistent
  database (`demo-laptop` / `demo-phone`) on the `opfs-sahpool` VFS. The
  COOP/COEP headers are still served, but sahpool runs on
  `FileSystemSyncAccessHandle` and needs no SharedArrayBuffer. The device
  header shows the mode in use. With the default in-memory server storage,
  a server restart forgets commits that the devices' persistent databases
  still hold; use `SYNCULAR_DEMO_DB` for a symmetric persistence story.
- **Connect-then-sync boot order** (§8.7): devices connect the socket
  first, then run their first sync round over it; the round registers
  this connection's subscriptions at round end. All sync rounds ride the
  WebSocket once it is connected; `POST /sync` stays server-side for
  producers and tooling, and segment downloads stay on HTTP.
- The lab has no dependencies beyond the workspace packages; the frontend
  is vanilla DOM and the fonts are self-hosted.
- **Hooks variant**: [`apps/demo-react`](../demo-react) is a todo app with
  its own schema and server and a **React** frontend built on `@syncular/react`: `SyncProvider` +
  `useQuery` (typed named queries, read-only) + `useMutation` + `useSyncStatus`
  + a `useWindow` list-filter dropdown that dogfoods W1 windowing. Run it with
  `bun run --cwd apps/demo-react dev` (port 8788).

## Multi-tab

The laptop and the phone use distinct lock names, so each device is its own
leader with its own core and database. Multi-tab followers share one lock
name across browser tabs of one origin.

To see a leader and a follower, open the lab in two tabs with `?multitab`
on both (this sets `createSyncClientHandle({ multiTab: true })` and shares
one lock name per device across tabs). Each device in the first tab becomes
the leader: it spawns the worker, owns the OPFS database, and holds the
socket. The second tab's devices become followers that proxy to it over a
BroadcastChannel, and the device header shows `leader` or `follower`. Close
the leader tab and the follower promotes to `leader` and keeps syncing.

Cross-tab Web Locks and BroadcastChannel are browser-only (Bun has no
`navigator.locks`), so `web-client/test/multi-tab.test.ts` covers this path
in-process and the browser pass stays manual: confirm one tab reads
`leader` and the other `follower`, mutate in the follower, and confirm it
converges over one socket on the leader tab; then close the leader tab and
confirm the follower promotes and edits still sync.
