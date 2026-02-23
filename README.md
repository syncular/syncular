<p align="center">
  <img src="assets/syncular-anim.svg" width="280" height="280" alt="Syncular" />
</p>

<h1 align="center">Syncular</h1>

<p align="center">
  Local-first sync framework for TypeScript apps.
  <br />
  Local SQLite on the client. Postgres on the server. A commit-log in between.
</p>

<p align="center">
  <a href="https://syncular.dev">Docs</a> &nbsp;·&nbsp;
  <a href="https://demo.syncular.dev">Live Demo</a> &nbsp;·&nbsp;
  <a href="https://console.syncular.dev">Console</a> &nbsp;·&nbsp;
  <a href="https://www.npmjs.com/org/syncular">npm</a>
</p>

> **Alpha.** APIs, wire formats, and storage layouts will change between releases. Do not use in production unless you are comfortable pinning versions and migrating manually.

## Why Syncular

Your app queries a **local database** — reads are instant, the UI never waits for the network, and everything works offline. When connectivity returns, an **immutable commit-log** syncs changes between client and server through simple push/pull over HTTP.

- **Instant UI** — queries hit local SQLite, sub-millisecond, no loading spinners
- **Offline by default** — writes go to a local outbox and sync when online
- **Commit-log sync** — append-only log of changes, incremental pulls, easy to reason about and debug
- **Scope-based auth** — every change is tagged with scope values (e.g. `user_id`, `project_id`); pulls return only what's requested _and_ allowed
- **Blob storage** — sync binary files (images, documents) alongside structured data; pluggable backends including database storage and Cloudflare R2
- **End-to-end encryption** — optional field-level E2E encryption plugin (XChaCha20-Poly1305) with BIP39 key sharing between devices
- **Admin console** — inspect commits/clients/events, browse storage objects, and run maintenance operations (prune/compact/notify)
- **External changes + admin proxy** — integrate existing REST/webhook/pipeline writes and admin SQL without breaking sync semantics
- **Observability** — pluggable telemetry (logs, traces, metrics, exceptions) with built-in Sentry adapter or bring your own (OpenTelemetry, Datadog, etc.)
- **Migrations + typegen** — schema versioning for rolling upgrades, plus optional type generation from migrations
- **Type-safe end-to-end** — TypeScript + [Kysely](https://kysely.dev) on both client and server, queries checked at build time
- **Self-hosted, Apache-2.0** — run on your own infrastructure, no vendor lock-in

## How it works

```
┌──────────────────────────────────────────────┐
│  CLIENT                                      │
│  React UI → Kysely → Local SQLite            │
│  Writes → Outbox (queued, survives restart)  │
└──────────┬───────────────────────────────────┘
           │  push / pull (HTTP)
           ▼
┌──────────────────────────────────────────────┐
│  SERVER                                      │
│  Table handlers → Kysely → Postgres          │
│  Commit log (append-only, scoped, ordered)   │
└──────────────────────────────────────────────┘
```

1. **Bootstrap** — first sync sends a point-in-time snapshot (chunked + compressed for large datasets)
2. **Push** — client writes locally, queues in outbox, pushes to server; server validates, writes to commit log
3. **Pull** — client sends its cursor, server returns commits since then filtered by scopes
4. **Realtime** — WebSocket wakes clients on new commits (data still flows over HTTP)

## Supported databases

### Client

| Dialect | Runtime | Package |
|---|---|---|
| wa-sqlite | Browser (WASM) | `@syncular/dialect-wa-sqlite` |
| PGlite | Browser (WASM) | `@syncular/dialect-pglite` |
| better-sqlite3 | Node.js / Electron | `@syncular/dialect-better-sqlite3` |
| Electron IPC SQLite | Electron (renderer + main process) | `@syncular/dialect-electron-sqlite` |
| Bun SQLite | Bun | `@syncular/dialect-bun-sqlite` |
| Expo SQLite | React Native | `@syncular/dialect-expo-sqlite` |
| LibSQL | Turso / LibSQL | `@syncular/dialect-libsql` |

### Server

| Dialect | Use case | Package |
|---|---|---|
| Postgres | Production | `@syncular/server-dialect-postgres` |
| SQLite | Dev / testing | `@syncular/server-dialect-sqlite` |
| D1 | Cloudflare Workers | `@syncular/server-cloudflare` |

## Quick start

**Server**

```bash
npm install @syncular/server @syncular/server-hono @syncular/server-dialect-postgres kysely pg hono
```

**Client (React + browser)**

```bash
npm install @syncular/client @syncular/client-react @syncular/transport-http @syncular/dialect-wa-sqlite kysely
```

See the [Quick Start guide](https://syncular.dev/docs/introduction/quick-start) for a full walkthrough.

## Packages

All packages are published under the `@syncular` scope on npm.

| Package | Description |
|---|---|
| `@syncular/core` | Protocol types, schemas, telemetry |
| `@syncular/server` | Server sync engine (push, pull, pruning, snapshots, blobs) |
| `@syncular/server-hono` | Hono adapter with OpenAPI spec + WebSocket |
| `@syncular/server-service-worker` | Service Worker server/runtime + wake transport helpers |
| `@syncular/client` | Client sync engine (outbox, conflicts, plugins, blobs) |
| `@syncular/client-react` | React provider, typed hooks, queries, mutations, presence |
| `@syncular/transport-http` | HTTP transport with typed client |
| `@syncular/transport-ws` | WebSocket transport for realtime + presence |
| `@syncular/relay` | Edge relay (acts as both client and server) |
| `@syncular/migrations` | Versioned migrations with checksum tracking |
| `@syncular/typegen` | Generate DB types from migrations (with type overrides) |
| `@syncular/client-plugin-encryption` | E2E field encryption (XChaCha20-Poly1305) with key sharing |
| `@syncular/observability-sentry` | Sentry adapter for logs, traces, metrics |

## Run locally

```bash
bun install
bun --cwd apps/demo dev     # demo (single app + console shell, default http://localhost:9811)
bun --cwd apps/docs dev     # docs at http://localhost:3000
bun --cwd apps/console dev  # console at http://localhost:5174
```

## License

Apache-2.0
