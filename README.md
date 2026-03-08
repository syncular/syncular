<p align="center">
  <img src="assets/syncular-anim.svg" width="280" height="280" alt="Syncular" />
</p>

<h1 align="center">Syncular</h1>

<p align="center">
  Offline-first SQL sync you can operate.
  <br />
  Local SQL on every client. Server-authoritative sync through an append-only commit log. Every change tagged, scoped, and auditable.
</p>

<p align="center">
  <a href="https://syncular.dev">Docs</a> &nbsp;·&nbsp;
  <a href="https://demo.syncular.dev">Live Demo</a> &nbsp;·&nbsp;
  <a href="https://console.syncular.dev">Console</a> &nbsp;·&nbsp;
  <a href="https://www.npmjs.com/org/syncular">npm</a>
</p>

> **Alpha.** APIs, wire formats, and storage layouts will change between releases. Do not use in production unless you are comfortable pinning versions and migrating manually.

## Why Syncular

Syncular is for apps that want local SQL on every client without giving up server authority. Reads and optimistic writes hit local SQL first. The server validates writes, stores them in an append-only commit log, tags them with scopes, and clients pull only what they are allowed to see. When something goes wrong, you inspect commits, clients, and events instead of reverse-engineering replication state.

- **Local SQL is the hot path** — queries, joins, aggregates, and optimistic writes run against local SQLite or PGlite, not a remote cache
- **The server stays authoritative** — pushes are validated, idempotent, conflict-aware, and auditable
- **Commit-log sync is explicit** — ordered, append-only history is easier to reason about than opaque replication
- **Scopes make auth inspectable** — authorization is code, and every synced change carries the scope data used to gate it
- **Client and server schemas stay independent** — shape each side for its job and bridge them with table handlers
- **Realtime stays simple** — WebSocket is only a wake-up signal; data flows over HTTP where retries, caching, and debugging are straightforward
- **Production ops are part of the product** — Console, audit endpoints, prune/compact, blob inspection, and telemetry are built in

## What Syncular is not

- **Not decentralized.** Syncular is server-authoritative — there is no P2P or fully decentralized mode. If data sovereignty (no server ever sees your data) is a hard requirement, look at [Jazz](https://jazz.tools) or [Evolu](https://www.evolu.dev).
- **Not a pure CRDT engine.** The core model is server-authoritative structured data sync. For fields that need real-time collaborative editing (rich text, ProseMirror), the optional Yjs plugin bridges both worlds — CRDT state stored as columns, synced through the same commit log.
- **Not a read-only sync layer.** Syncular owns the full write path. If you only need to stream Postgres changes to clients at CDN scale, [Electric SQL](https://electric-sql.com) may be a better fit.
- **Conflict resolution is not automatic.** You get version-based detection, field-level merge utilities, and resolution primitives — but you implement the strategy and any resolution UI. There is no silent auto-merge.
- **Not built for multiplayer games.** Syncular is good for durable game data like accounts, inventory, progression, or async/shared world state. It is not the right transport for frame-by-frame gameplay, physics replication, rollback netcode, or latency-critical entity sync.
- **JavaScript/TypeScript only.** React Native is supported via JS (Expo SQLite, Nitro SQLite), but there are no native Swift or Kotlin SDKs. If first-class native mobile SDKs are a requirement, [PowerSync](https://www.powersync.com) is worth evaluating.

## Quick start

The fastest way to evaluate Syncular is to run the demo:

```bash
git clone https://github.com/syncular/syncular.git
cd syncular
bun install
bun --cwd apps/demo dev
```

Open `http://localhost:9811` for the app and `http://localhost:9811/console` for the built-in Console.

Building your own app instead?

**Server**

```bash
npm install @syncular/server @syncular/server-hono @syncular/server-dialect-postgres kysely pg hono
```

**Client (React + browser)**

```bash
npm install @syncular/client @syncular/client-react @syncular/transport-http @syncular/dialect-wa-sqlite kysely
```

See the [Quick Start guide](https://syncular.dev/docs/introduction/quick-start) for the walkthrough, the [Installation guide](https://syncular.dev/docs/introduction/installation) for the package/runtime matrix, and [Build](https://syncular.dev/docs/build) for the implementation path.

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

1. **Local write** — the app writes to local SQL immediately and queues the commit in the outbox
2. **Push** — the server validates the write, resolves scopes, applies domain logic, and appends to the commit log
3. **Pull** — clients fetch snapshots or commits since their cursor, filtered to the intersection of requested and allowed scopes
4. **Realtime** — WebSocket sends a wake-up signal; clients still pull data over HTTP

That separation is intentional: your server schema models the domain, your client schema models local UX, and table handlers plus `resolveScopes` are where the mapping lives.

## Testing and confidence

New sync systems should be met with skepticism. Syncular is tested across multiple layers so you can validate behavior before trusting it in an app.

- **Runner-agnostic testkit** — `@syncular/testkit` gives you in-process fixtures, real HTTP fixtures, engine-mode clients, assertions, deterministic clocks/IDs, realtime helpers, and fault injection utilities
- **Core protocol and handler coverage** — `bun test` runs package tests plus unit, integration, dialect, and typegen suites
- **Runtime matrix coverage** — `bun test:runtime` exercises real runtime paths across browser/demo, Cloudflare, D1, Node, Deno, Electron, and relay flows
- **Performance and stress checks** — dedicated perf, latency, and load suites cover bootstrap behavior, reconnect storms, mixed workloads, and demo responsiveness

Start here:

```bash
bun test
bun test:runtime
bun test:perf
```

See the [Testing docs](https://syncular.dev/docs/testing) for the full testkit API, fault injection patterns, and runtime examples.

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

## Core packages

Most packages are published under the `@syncular` scope on npm. The umbrella package is published as `syncular`.

| Package | Description |
|---|---|
| `syncular` | Umbrella package with re-exports for one-package imports |
| `@syncular/server` | Server sync engine (push, pull, pruning, snapshots, blobs) |
| `@syncular/server-hono` | Hono adapter with HTTP routes, OpenAPI, WebSocket, and console routes |
| `@syncular/server-cloudflare` | Cloudflare adapter for Workers and Durable Objects |
| `@syncular/client` | Client sync engine (outbox, conflicts, plugins, realtime, push/pull) |
| `@syncular/client-plugin-blob` | Optional client blob storage plugin (`client.blobs`, local cache, upload queue) |
| `@syncular/client-react` | React bindings, typed hooks, queries, mutations, presence |
| `@syncular/transport-http` | HTTP push/pull transport |
| `@syncular/transport-ws` | WebSocket wake-up and presence transport |
| `@syncular/console` | Embeddable console UI for commits, clients, events, and operations |
| `@syncular/testkit` | Runner-agnostic fixtures, assertions, HTTP/runtime helpers, and fault injection |
| `@syncular/migrations` | Versioned migrations with checksum tracking |
| `@syncular/typegen` | Generate database types from migrations |

Need more? Optional packages cover blob storage adapters, runtime dialects, relay, Yjs, encryption, offline auth, observability, and test tooling. See the [Installation guide](https://syncular.dev/docs/introduction/installation) for the full matrix.

## Run locally

```bash
bun install
bun --cwd apps/demo dev     # demo + built-in console at http://localhost:9811 and /console
bun --cwd apps/docs dev     # docs site (Next dev, typically http://localhost:3000)
bun --cwd apps/console dev  # standalone console app; run separately and use the URL printed at startup
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
