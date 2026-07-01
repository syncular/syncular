# Syncular starter app

A minimal local-first todo app built with [Syncular](https://syncular.dev):
the client writes to its own SQLite database (persisted in IndexedDB) and
syncs with a Hono server over HTTP + WebSocket realtime. It works offline and
reconciles when the connection returns.

## Run it

```sh
bun install
bun dev
```

This starts:

- the sync server on `http://127.0.0.1:4100` (health check at `/health`,
  sync routes under `/sync`, data persisted in `data/sync.sqlite`)
- Vite on `http://127.0.0.1:5173`

Open the app in two browser windows and watch edits replicate. Stop the dev
server while the page stays open: edits queue locally and sync when the
server is back.

The status lines in the task panel come from `getSyncularBrowserHealth(...)`,
the generated `database.schemaReadiness()` helper, and
`database.exportSupportBundle(...)`. They are the app-facing checks for
durable storage, active subscriptions, realtime state, generated schema
compatibility, the latest structured Syncular error, stable recommended
actions such as refreshing auth or checking permissions, and a redacted local
support artifact that can be attached to bug reports.

For preview or production deploys, run
`getSyncularBrowserDeploymentPreflight(...)` from the browser before opening the
database. Run it in the deployed page or a real browser smoke so storage APIs
reflect the target browser. It checks Worker/WebAssembly support, HTTPS or
localhost secure context, OPFS/IndexedDB persistence, quota,
persistent-storage status, and served WASM asset status/content types without
starting the Worker. The starter's `openAppClient()` runs this preflight before
opening Syncular.

> **Why Bun?** The dev script and sync server run on Bun (`Bun.serve`,
> `bun:sqlite` via `@syncular/server/bun-sqlite`) because Bun runs
> TypeScript directly and ships SQLite with zero native build steps — one
> runtime for the server, scripts and tooling. The browser client and the
> Vite build are runtime-agnostic. If you need a Node server instead, swap
> the dialect for `@syncular/server/better-sqlite3` and serve the Hono app
> with `@hono/node-server` + `@hono/node-ws`.

## Project structure

```
migrations/            SQL schema, one folder per migration (up.sql/down.sql)
syncular.app.ts        App contract: tables -> subscriptions + scopes
generated/             Codegen handoff (syncular.codegen.json, Rust/Swift/Kotlin)
src/generated/         Generated TypeScript client + server modules (committed)
src/server/            Hono sync server (auth, handlers, server-side tables)
src/client/syncular.ts Client wiring: local DB, sync lifecycle, managed client
src/app.tsx            React UI built on @syncular/client/react hooks + diagnostics
scripts/dev.ts         Runs sync server + Vite together
vite.config.ts         Serves/copies Syncular core WASM assets for browser deploys
```

How a change flows: `useMutations().tasks.insert(...)` writes to the local
SQLite database and queues an outbox entry → the sync engine pushes it to
`/sync` → the server handler authorizes it against your scopes and assigns a
`server_version` → other subscribed clients receive it over the WebSocket and
`useSyncQuery` re-renders.

When app code needs to wait for a committed command or realtime wakeup to
appear in the local read model, use the generated table helper such as
`database.awaitTaskVisibility(...)`. It wraps the lower-level local visibility
primitive with this app's `tasks` table metadata, so you do not need to pass a
manual table list or call `sync()` as a stale-read workaround.

## Regenerating the client (`bun run codegen`)

`src/generated/` is **committed**, so the app installs and runs without any
extra toolchain. Regenerate it after changing `migrations/` or
`syncular.app.ts`:

```sh
bun run codegen         # npx syncular generate
bun run codegen:check   # CI: verify committed output is current
npx syncular schema check --json
```

`syncular generate` needs two tools:

- **Bun** — runs the TypeScript manifest step (`syncular-typegen`).
- **Rust (cargo)** — the generator itself is the `syncular-codegen` crate.
  On first run the CLI installs it automatically with
  `cargo install syncular-codegen --locked` into a local cache (get Rust from
  https://rustup.rs). No Rust is needed to run the app itself.

## Next steps

### Add a table

1. Add a migration, e.g. `migrations/0002_projects/up.sql`:

   ```sql
   CREATE TABLE IF NOT EXISTS projects (
     id TEXT PRIMARY KEY,
     name TEXT NOT NULL,
     user_id TEXT NOT NULL,
     server_version BIGINT NOT NULL DEFAULT 0
   ) WITHOUT ROWID;
   ```

   (plus a `down.sql` with `DROP TABLE IF EXISTS projects;`)

2. Register it in `syncular.app.ts`:

   ```ts
   projects: syncedTable({
     table: 'projects',
     subscriptionId: 'sub-projects',
     scopes: [scope('user_id', { source: 'actorId', required: true })],
     serverVersion: 'server_version',
     sqliteWithoutRowid: true,
   }),
   ```

3. Run `bun run codegen`, then mirror the table on the server: add a
   `createServerHandler` for `projects` in `src/server/sync-server.ts` and a
   matching `createTable` in `ensureAppTables`. Subscribe the client by
   adding `projectSubscription({ actorId })` in `src/client/syncular.ts`.

### Change scopes

Scopes decide which rows each user receives. `scope('user_id', { source:
'actorId' })` means "sync rows whose `user_id` equals the signed-in actor".
For shared data, scope by a different column (e.g. `team_id`) and return the
user's teams from `resolveScopes` on the server.

### Real auth

The starter authenticates every request as one demo user with a static
token. Replace `authenticate` in `src/server/sync-server.ts` with your
session/JWT validation, and have `src/client/syncular.ts` send your real
token and the signed-in user's id as `actorId`.

## Learn more

- Docs: https://syncular.dev/docs
- CLI reference: https://syncular.dev/docs/reference/cli
