<p align="center">
  <img src="assets/syncular-anim.svg" width="280" height="280" alt="Syncular" />
</p>

<h1 align="center">Syncular</h1>

<p align="center">
  Offline-first SQL sync you can operate.
  <br />
  Local SQL on every client. Append-only commit log on the server. Every change tagged, scoped, and auditable.
</p>

<p align="center">
  <a href="https://syncular.dev">Docs</a> &nbsp;·&nbsp;
  <a href="https://demo.syncular.dev">Live Demo</a> &nbsp;·&nbsp;
  <a href="https://console.syncular.dev">Console</a> &nbsp;·&nbsp;
  <a href="https://www.npmjs.com/org/syncular">npm</a>
</p>

> **Alpha.** APIs, wire formats, and storage layouts will change between releases. Do not use in production unless you are comfortable pinning versions and migrating manually.

## Why Syncular

Full SQL on the client — local SQL with its own schema, shaped for fast local queries. An append-only commit log on the server — every change tagged with scope values, monotonically ordered, permanently auditable. Your server-side SQL schema models your domain; your client schema is independent. Table handlers and `resolveScopes` bridge the two in code. When something goes wrong, you read the log.

- **Instant UI** — queries hit local SQL, sub-millisecond, no loading spinners; full SQL, joins, aggregates — not a KV store
- **Commit-log sync** — append-only, scoped, monotonically ordered; like `git log` for your data
- **No denormalization tax** — your server schema models your domain, not your sync topology; client schema is independent and optimized for local queries; table handlers bridge the two; when permissions change, you update a function, not a schema
- **Scope-based auth** — authorization is code not YAML rules; every change tagged with scope values at sync time; pulls return the intersection of requested and allowed scopes
- **Durable outbox** — writes survive app restarts; sync resumes when connectivity returns
- **Idempotent push** — keyed by `(clientId, clientCommitId)`; safe to retry indefinitely with no duplicates
- **Explicit conflict detection** — push with a `baseVersion`; server returns a conflict response with the current row when another write landed first; you decide the resolution
- **Access revocation** — when a user loses access, the next pull reflects it; local data for revoked scopes is cleared
- **Compaction + pruning** — commit log stays manageable: prune history all active clients have consumed, compact sequences into snapshots; new clients bootstrap from a snapshot, not a full log replay
- **Doorbell realtime** — WebSocket carries wake-up signals only; all data flows over HTTP (cacheable, retryable, debuggable with standard tools)
- **Admin console** — inspect commits, clients, and events; browse storage objects; trigger prune/compact; debug sync in production
- **Blob storage** — sync binary files alongside structured data; pluggable backends (filesystem, database, S3/R2/MinIO)
- **Yjs CRDT fields** — optional plugin that stores Yjs collaborative state (text, XML, ProseMirror) as columns alongside structured data, synced through the same commit log
- **End-to-end encryption** — optional field-level E2E encryption (XChaCha20-Poly1305) with BIP39 key sharing between devices
- **Audit UI primitives** — per-commit push outcomes, conflict streams, and scoped `/sync/audit/*` endpoints for in-product history
- **External changes + admin proxy** — integrate existing REST/webhook/pipeline writes and admin SQL without breaking sync semantics
- **Observability** — pluggable telemetry (logs, traces, metrics, exceptions); Sentry adapter or bring your own (OpenTelemetry, Datadog, etc.)
- **Migrations + typegen** — schema versioning for rolling upgrades; generate TypeScript types from migrations
- **Type-safe end-to-end** — TypeScript + [Kysely](https://kysely.dev) on both client and server, queries checked at build time
- **Runs everywhere** — browser (WASM SQLite, PGlite), Electron, React Native (Expo, Nitro SQLite), Bun, Node.js on the client; Postgres, SQLite, Neon, LibSQL, or Cloudflare D1 on the server
- **Self-hosted, Apache-2.0** — run on your own infrastructure, no vendor lock-in

## How it works

```
┌──────────────────────────────────────────────────────┐
│  CLIENT  (browser · Electron · React Native · Bun …) │
│  App UI → Kysely → Local SQL                         │
│  Writes → Outbox (durable, survives restart)         │
└──────────────────┬───────────────────────────────────┘
                   │  push / pull (HTTP)
                   │  wake-up signal (WebSocket only)
                   ▼
┌──────────────────────────────────────────────────────┐
│  SERVER  (Node · Bun · Cloudflare Workers …)         │
│  Table handlers → Kysely → SQL database              │
│  Commit log (append-only, scoped, ordered)           │
└──────────────────────────────────────────────────────┘
```

1. **Bootstrap** — first sync returns a point-in-time snapshot (chunked + compressed for large datasets)
2. **Push** — client writes locally, queues in outbox, pushes to server; server validates, extracts scopes from row data, writes to commit log
3. **Pull** — client sends its cursor; server returns commits since then filtered to the intersection of requested and allowed scopes
4. **Realtime** — WebSocket sends a wake-up signal; client pulls over HTTP (data never flows over WebSocket)

Your server schema models your domain. Your client schema is shaped for local queries. Table handlers bridge the two — `resolveScopes` is a function, not a YAML rule, so hierarchical permissions, dynamic lookups, and role changes are just code.

## What Syncular is not

- **Not decentralized.** Syncular is server-authoritative — there is no P2P or fully decentralized mode. If data sovereignty (no server ever sees your data) is a hard requirement, look at [Jazz](https://jazz.tools) or [Evolu](https://www.evolu.dev).
- **Not a pure CRDT engine.** The core model is server-authoritative structured data sync. For fields that need real-time collaborative editing (rich text, ProseMirror), the optional Yjs plugin bridges both worlds — CRDT state stored as columns, synced through the same commit log.
- **Not a read-only sync layer.** Syncular owns the full write path. If you only need to stream Postgres changes to clients at CDN scale, [Electric SQL](https://electric-sql.com) may be a better fit.
- **Conflict resolution is not automatic.** You get version-based detection, field-level merge utilities, and resolution primitives — but you implement the strategy and any resolution UI. There is no silent auto-merge.
- **JavaScript/TypeScript only.** React Native is supported via JS (Expo SQLite, Nitro SQLite), but there are no native Swift or Kotlin SDKs. If first-class native mobile SDKs are a requirement, [PowerSync](https://www.powersync.com) is worth evaluating.

## Supported platforms

Mix and match any client dialect with any server dialect. The sync protocol is the same everywhere.

### Client

| Dialect | Runtime | Package |
|---|---|---|
| wa-sqlite | Browser (WASM) | `@syncular/dialect-wa-sqlite` |
| PGlite | Browser (WASM) | `@syncular/dialect-pglite` |
| better-sqlite3 | Node.js / Electron | `@syncular/dialect-better-sqlite3` |
| sqlite3 | Node.js | `@syncular/dialect-sqlite3` |
| Electron IPC SQLite | Electron (renderer + main process) | `@syncular/dialect-electron-sqlite` |
| Bun SQLite | Bun | `@syncular/dialect-bun-sqlite` |
| Expo SQLite | React Native | `@syncular/dialect-expo-sqlite` |
| Nitro SQLite | React Native | `@syncular/dialect-react-native-nitro-sqlite` |
| LibSQL | Turso / LibSQL | `@syncular/dialect-libsql` |
| Neon | Neon serverless | `@syncular/dialect-neon` |
| D1 | Cloudflare Workers | `@syncular/dialect-d1` |

### Server

| Dialect / runtime | Use case | Package |
|---|---|---|
| Postgres | Production (Node, Bun, …) | `@syncular/server-dialect-postgres` |
| SQLite | Dev / testing | `@syncular/server-dialect-sqlite` |
| Cloudflare Worker + D1 | Cloudflare Workers (HTTP only) | `@syncular/server-cloudflare` |
| Cloudflare Durable Object + D1 | Cloudflare Workers + WebSocket realtime | `@syncular/server-cloudflare` |

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
| `syncular` | Meta package — single install for the full stack |
| `@syncular/core` | Protocol types, schemas, telemetry |
| `@syncular/server` | Server sync engine (push, pull, pruning, snapshots, blobs) |
| `@syncular/server-hono` | Hono adapter with OpenAPI spec + WebSocket; host anywhere (Node, Bun, Deno, …) |
| `@syncular/server-cloudflare` | Cloudflare adapter: stateless Worker (HTTP) or Durable Object (HTTP + WebSocket realtime) |
| `@syncular/server-service-worker` | Run the sync server inside a browser Service Worker; wake transport for fully in-browser operation |
| `@syncular/server-storage-filesystem` | Filesystem blob storage adapter |
| `@syncular/server-storage-s3` | S3-compatible blob storage adapter (S3, R2, MinIO) |
| `@syncular/client` | Client sync engine (outbox, conflicts, plugins, blobs) |
| `@syncular/client-react` | React provider, typed hooks, queries, mutations, presence |
| `@syncular/transport-http` | HTTP transport with typed client |
| `@syncular/transport-ws` | WebSocket transport for realtime + presence |
| `@syncular/relay` | Edge relay (acts as both client and server) |
| `@syncular/console` | Embeddable console UI — inspect commits, clients, and events inside your own app |
| `@syncular/migrations` | Versioned migrations with checksum tracking |
| `@syncular/typegen` | Generate DB types from migrations (with type overrides) |
| `@syncular/testkit` | Testing toolkit: scenario flows, fault injection, HTTP/WebSocket fixtures, sync assertions |
| `@syncular/client-plugin-yjs` | Yjs CRDT field plugin for client (text, XML, ProseMirror) |
| `@syncular/server-plugin-yjs` | Yjs CRDT server integration for table handlers |
| `@syncular/client-plugin-encryption` | E2E field encryption (XChaCha20-Poly1305) with key sharing |
| `@syncular/client-plugin-offline-auth` | Provider-agnostic offline auth primitives for JS runtimes |
| `@syncular/client-plugin-offline-auth-react` | React hooks for offline auth state + local lock policy |
| `@syncular/observability-sentry` | Sentry adapter for logs, traces, metrics |

## Run locally

```bash
bun install
bun --cwd apps/demo dev     # demo (single app + console shell, default http://localhost:9811)
bun --cwd apps/docs dev     # docs at http://localhost:3000
bun --cwd apps/console dev  # console at http://localhost:3000
```

## Latency checks

```bash
bun run test:runtime:demo-latency
bun run test:runtime:demo-toggle-latency
```

`test:runtime:demo-toggle-latency` reports split-screen checkbox toggle latency for:
- `samePaneMs` (click -> left pane update)
- `mirrorPaneMs` (click -> right pane update)

Optional thresholds can be set via env vars:
- `LOCAL_P95_BUDGET_MS`
- `MIRROR_P95_BUDGET_MS`

## License

Apache-2.0
