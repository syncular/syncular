# @syncular/core

## 0.1.2

## 0.1.1

## 0.1.0

### Minor Changes

- 208ef70: First versioned release train (everything on main since `0.0.6-248`).

  BREAKING — client dialect packages merged into `@syncular/dialects`:
  `@syncular/dialect-better-sqlite3`, `@syncular/dialect-bun-sqlite`,
  `@syncular/dialect-d1`, `@syncular/dialect-libsql`, `@syncular/dialect-neon`,
  `@syncular/dialect-pglite`, and `@syncular/dialect-sqlite3` are replaced by
  subpath exports, e.g. `import { createNeonDialect } from '@syncular/server/neon'`.
  Exported symbol names are unchanged; drivers stay optional peerDependencies.
  The old packages will be deprecated on npm.

  BREAKING — the `syncular` umbrella package is now CLI-only
  (`npx syncular generate`). All passthrough re-export modules are removed;
  import from the scoped `@syncular/*` packages instead.

  New:

  - `create-syncular-app` scaffolding CLI (`bun create syncular-app`) that
    generates a minimal full-stack app.
  - `apps/demo` rebuilt as a self-contained `@syncular/client/react` reference app
    (own schema + codegen, two-pane live sync).
  - First publish for `@syncular/client/react`, `@syncular/client-javascript-bindings`,
    `@syncular/dialects`, `@syncular/client/crdt-yjs`,
    `@syncular/client/react-native`, `@syncular/client/tauri`, and
    `create-syncular-app`.

  Fixes and internals:

  - client: actionable error when the WASM runtime artifact is missing.
  - server: malformed `resolveScopes` values now fail loudly with a descriptive
    error instead of silently revoking access.
  - server: shared transaction helpers across dialects; server-hono route
    factories split by domain.
  - Docs fully restructured and source-verified; client bundle-size baseline
    enforced in CI; Bun pinned to 1.3.13.

  BREAKING — single-step client init; the database owns the sync lifecycle:
  `createSyncularClient` / `SyncularClient` / `SyncularManagedClient` are
  removed. `createSyncularDatabase` (and the generated
  `createSyncularAppDatabase`) now registers `subscriptions`, runs the initial
  sync, and starts realtime while opening (disable with
  `lifecycle: { autoStart: false }`; realtime defaults to on for remote
  databases), and exposes `start`/`stop`/`sync`/`on`/`getStatus`/presence/
  conflicts directly on the database. `destroy()` is renamed to `close()`
  everywhere, `@syncular/client/react`'s `SyncProvider` takes
  `CreateSyncularDatabaseOptions` and `closeOnUnmount`, and `runtime` accepts a
  packaged artifact variant name (defaults to `'full'`).
