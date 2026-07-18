# __PROJECT_NAME__

A [syncular](https://github.com/bkniffler/syncular) "one codebase, web +
desktop" app: one React tree that runs in the browser (the whole client core
in a Web Worker on OPFS) **and** in a Tauri window (a native Rust core with a
real file database in the host process). Every hook, component, and query is
identical — the only host-aware code is the ~50-line engine seam in
`src/frontend/engine.ts`.

## Run the web half

```sh
bun install
bun run generate          # syncular.json + migrations → src/syncular.generated.ts
bun run dev               # http://localhost:8787 — sync server + web app
```

Open the URL, add todos, open a second window to watch them converge over the
realtime socket. `bun test` runs a server-level convergence smoke test.

## Run the desktop half

With the dev server still running (the native core syncs against it):

```sh
cd src-tauri
cargo tauri dev
```

`cargo tauri dev` builds the frontend (`bun run build-frontend` → `dist/`),
compiles the Rust host, and opens the window. Edit todos in the browser and
the desktop window side by side — same server, two radically different hosts,
converging live.

Prerequisites: [Rust](https://rustup.rs) and the
[Tauri v2 system dependencies](https://v2.tauri.app/start/prerequisites/);
`cargo install tauri-cli` for the `cargo tauri` subcommand. The
`tauri-plugin-syncular` dependency comes from crates.io.

> `dist/` ships with a placeholder page so a direct `cargo build` works
> before the first frontend build (`tauri::generate_context!` hard-fails on
> a missing `frontendDist` directory). Any `cargo tauri dev`/`build`
> replaces it via `beforeDevCommand`.

## Layout

| File | What it is |
|---|---|
| `syncular.json` + `migrations/` + `queries/` | Schema and named-query inputs |
| `syncular.migrations.lock.json` | Immutable deployed-migration checksums/layout evidence (committed) |
| `src/syncular.generated.ts` + `src/syncular.queries.ts` | Generated descriptors (committed) |
| `src/server.ts` | Sync server + WebSocket + the web frontend, one Bun process |
| `src/frontend/engine.ts` | **The seam**: picks worker core vs native core |
| `src/frontend/main.tsx` | The shared React tree (host-agnostic) |
| `src/frontend/worker.ts` | The sync worker (web half only) |
| `build-frontend.ts` | Bundles the frontend to `dist/` for the Tauri window |
| `src-tauri/` | The desktop host: plugin registration, config, capability |
| `src/smoke.test.ts` | Server-level convergence smoke test (`bun test`) |

## How the seam works

`createEngine()` detects a Tauri webview (`__TAURI_INTERNALS__`) and
dynamic-imports either `createTauriSyncClient` (`@syncular/tauri` — an RPC
bridge to the native core the plugin hosts) or `createSyncClientHandle`
(`@syncular/client` — the worker core on OPFS). Both satisfy the one
structural interface the hooks target, `SyncClientLike`, so a single
async client resource and `<SyncProvider>` serve both hosts. Both cores own and
persist client identity; app code has no localStorage identity mirror. The
dynamic imports keep each host's
machinery out of the other's bundle.

On desktop, the plugin owns the database path and the transport — see
`src-tauri/src/lib.rs` (`SyncularConfig { base_url, db_path, .. }`) and the
`syncular:default` permission in `src-tauri/capabilities/syncular.json`.

## What to edit first

1. **`src/server.ts` → `resolveScopes`** — the whole authorization story. The
   starter returns `['*']`; a real one returns the scope values the
   authenticated actor may see. Multiple variables are independent, not
   correlated parent/child tuples: test isolation with at least two parents and
   child IDs, and carry the parent scope on every child table before using a
   child wildcard. See
   [Scopes & authorization](https://syncular.dev/concepts-scopes/).
2. **`src/server.ts` → `authenticate`** — plug in your real session/token
   check; return `{ actorId, partition }` or `null` for a 401.
3. **`src-tauri/src/lib.rs` → `base_url`** — point the native core at your
   deployed sync endpoint (rotating auth goes through `client.setHeaders`).
4. **`src/frontend/main.tsx`** — the UI. Everything under `<SyncProvider>` is
   shared code; grow it into your app.
5. **`migrations/` + `syncular.json`** — append migrations and add tables or
   scopes, then `bun run generate`. Never edit a migration after deployment.

## Next

- One codebase, web + desktop guide: https://syncular.dev/guide-web-desktop/
- Tauri plugin reference: https://syncular.dev/platform-tauri/
- React hooks: https://syncular.dev/platform-react/
