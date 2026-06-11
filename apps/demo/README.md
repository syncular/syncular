# Syncular demo

A split-view, local-first todo app that shows the full Syncular flow the way a
real project wires it up:

- **Own schema + codegen**: `migrations/0001_initial/up.sql` defines a `tasks`
  table; `syncular.app.ts` maps it to subscriptions/scopes with
  `defineSyncularClient` from `@syncular/typegen`. The generated client and
  server modules are committed under `src/generated/`.
- **Sync server** (`src/server/sync-server.ts`): Hono + `createSyncServer`
  with an in-memory SQLite database, seed rows and console routes.
- **Two clients, one user**: each pane opens its own local SQLite database
  (persisted in IndexedDB) via the generated `createSyncularAppDatabase` and
  syncs over HTTP + WebSocket realtime.
- **React layer** (`src/app.tsx`): `@syncular/react` hooks — `SyncProvider`
  per pane, `useSyncQuery` live queries, `useMutations` for add/toggle/delete,
  `useSyncStatus`/`useSyncConnection` for the status badge and the offline
  toggle, `useOutboxStats` for queued changes, plus undo/redo backed by the
  generated command history.

## Run it

From the repository root:

```sh
bun demo
```

This starts the sync server on `http://127.0.0.1:4101` (health check at
`/health`) and Vite on `http://127.0.0.1:5173`. Add, toggle and delete todos
in either pane and watch the other pane follow; use the wifi button to take a
pane offline and queue changes.

## Regenerate the client

After changing `migrations/` or `syncular.app.ts`:

```sh
bun run codegen        # from apps/demo
bun run codegen:check  # verify committed output is current (CI)
```

This runs the `syncular` CLI (`syncular generate`), which refreshes
`generated/syncular.codegen.json`, `syncular.schema.json`, the TypeScript
modules in `src/generated/` and the Rust/Swift/Kotlin artifacts under
`generated/` (emitted unconditionally by the codegen; the web demo only uses
the TypeScript output).
