---
'@syncular/client-crdt-adapters': minor
'@syncular/client-react-native': minor
'@syncular/client-tauri': minor
'@syncular/client': minor
'@syncular/console': minor
'@syncular/core': minor
'create-syncular-app': minor
'@syncular/dialects': minor
'@syncular/migrations': minor
'@syncular/observability-sentry': minor
'@syncular/react': minor
'@syncular/relay': minor
'@syncular/server-cloudflare': minor
'@syncular/server-dialect-postgres': minor
'@syncular/server-dialect-sqlite': minor
'@syncular/server-hono': minor
'@syncular/server-service-worker': minor
'@syncular/server': minor
'syncular': minor
'@syncular/testkit': minor
'@syncular/transport-http': minor
'@syncular/typegen': minor
'@syncular/ui': minor
'@syncular/client-javascript-bindings': minor
'@syncular/server-storage-filesystem': minor
'@syncular/server-storage-s3': minor
'@syncular/server-plugin-yjs': minor
---

First versioned release train (everything on main since `0.0.6-248`).

BREAKING — client dialect packages merged into `@syncular/dialects`:
`@syncular/dialect-better-sqlite3`, `@syncular/dialect-bun-sqlite`,
`@syncular/dialect-d1`, `@syncular/dialect-libsql`, `@syncular/dialect-neon`,
`@syncular/dialect-pglite`, and `@syncular/dialect-sqlite3` are replaced by
subpath exports, e.g. `import { createNeonDialect } from '@syncular/dialects/neon'`.
Exported symbol names are unchanged; drivers stay optional peerDependencies.
The old packages will be deprecated on npm.

BREAKING — the `syncular` umbrella package is now CLI-only
(`npx syncular generate`). All passthrough re-export modules are removed;
import from the scoped `@syncular/*` packages instead.

New:

- `create-syncular-app` scaffolding CLI (`bun create syncular-app`) that
  generates a minimal full-stack app.
- `apps/demo` rebuilt as a self-contained `@syncular/react` reference app
  (own schema + codegen, two-pane live sync).
- First publish for `@syncular/react`, `@syncular/client-javascript-bindings`,
  `@syncular/dialects`, `@syncular/client-crdt-adapters`,
  `@syncular/client-react-native`, `@syncular/client-tauri`, and
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
everywhere, `@syncular/react`'s `SyncProvider` takes
`CreateSyncularDatabaseOptions` and `closeOnUnmount`, and `runtime` accepts a
packaged artifact variant name (defaults to `'full'`).
