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
  <a href="https://console.syncular.dev">Console</a> &nbsp;·&nbsp;
  <a href="https://www.npmjs.com/org/syncular">npm</a>
</p>

> **Alpha.** APIs, wire formats, and storage layouts will change between releases. Do not use in production unless you are comfortable pinning versions and migrating manually.

## Why Syncular

Syncular is for apps that want local SQL on every client without giving up server authority. Reads and optimistic writes hit local SQL first. The server validates writes, stores them in an append-only commit log, tags them with scopes, and clients pull only what they are allowed to see. When something goes wrong, you inspect commits, clients, and events instead of reverse-engineering replication state.

- **Local SQL is the hot path** — queries, joins, aggregates, and optimistic writes run against local SQLite, not a remote cache
- **The server stays authoritative** — pushes are validated, idempotent, conflict-aware, and auditable
- **Commit-log sync is explicit** — ordered, append-only history is easier to reason about than opaque replication
- **Scopes make auth inspectable** — authorization is code, and every synced change carries the scope data used to gate it
- **Client and server schemas stay independent** — shape each side for its job and bridge them with table handlers
- **Realtime stays verified** — WebSocket wakes the Rust client and delivers verified binary sync packs where available
- **Production ops are part of the product** — Console, audit endpoints, prune/compact, blob inspection, and telemetry are built in

## What Syncular is not

- **Not decentralized.** Syncular is server-authoritative — there is no P2P or fully decentralized mode. If data sovereignty (no server ever sees your data) is a hard requirement, look at [Jazz](https://jazz.tools) or [Evolu](https://www.evolu.dev).
- **Not a pure CRDT engine.** The core model is server-authoritative structured data sync. For fields that need real-time collaborative editing (rich text, ProseMirror), the optional Yjs plugin bridges both worlds — CRDT state stored as columns, synced through the same commit log.
- **Not a read-only sync layer.** Syncular owns the full write path. If you only need to stream Postgres changes to clients at CDN scale, [Electric SQL](https://electric-sql.com) may be a better fit.
- **Conflict resolution is not automatic.** You get version-based detection, field-level merge utilities, and resolution primitives — but you implement the strategy and any resolution UI. There is no silent auto-merge.
- **Not built for multiplayer games.** Syncular is good for durable game data like accounts, inventory, progression, or async/shared world state. It is not the right transport for frame-by-frame gameplay, physics replication, rollback netcode, or latency-critical entity sync.
- **Not a JavaScript-owned runtime.** The client runtime is Rust-first, with TypeScript bindings for browser and React apps.

## Quick start

The fastest way to evaluate Syncular as an app is the scaffolded starter:

```bash
bunx create-syncular-app my-app
cd my-app
bun install
bun dev
```

Working on this repository instead? Use the pinned Bun version from
`packageManager` (`bun@1.3.9`). CI downloads that exact release; local Volta or
system Bun installs may be newer and can change browser/WASM worker behavior.
If this worktree has the cached binary, prefix it explicitly:

```bash
git clone https://github.com/syncular/syncular.git
cd syncular
export PATH="$PWD/.context/bun-1.3.9/bun-darwin-aarch64:$PATH" # macOS arm64 cache, when present
bun --version  # expect 1.3.9
bun install
bun run client:test
bun run client:tsgo
```

Building your own app instead?

**Server**

```bash
npm install @syncular/server kysely pg hono
```

**Client (React + browser)**

```bash
npm install @syncular/client kysely react react-dom
```

If your server runtime is Neon-backed, pair `@syncular/server/neon` with
`createNeonServerDialect()` from `@syncular/server/postgres`.

If startup-critical data should bootstrap before large background tables, assign
`bootstrapPhase` on client subscriptions. Lower phases bootstrap first, while
later phases stay deferred until earlier phases are ready.

For pull/apply diagnostics, enable `traceEnabled: true` on the client and
inspect the emitted `sync:trace` events or inspector snapshot.

See the [Quick Start guide](https://syncular.dev/docs/start/quick-start) for the walkthrough, the [Installation guide](https://syncular.dev/docs/start/installation) for the package/runtime matrix, [Client](https://syncular.dev/docs/client) for app runtimes, and [Server](https://syncular.dev/docs/server) for the authoritative sync surface.

## How it works

```
┌──────────────────────────────────────────────────────┐
│  CLIENT  (browser · Electron · React Native · Bun …) │
│  App UI → Kysely → Local SQL                         │
│  Writes → Outbox (durable, survives restart)         │
└──────────────────┬───────────────────────────────────┘
                   │  push / pull (HTTP)
                   │  realtime deltas / recovery wake-ups (WebSocket)
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
4. **Realtime** — WebSocket carries verified sync-pack deltas when safe; pull-required wake-ups use HTTP recovery

That separation is intentional: your server schema models the domain, your client schema models local UX, and table handlers plus `resolveScopes` are where the mapping lives.

## Testing and confidence

New sync systems should be met with skepticism. Syncular is tested across multiple layers so you can validate behavior before trusting it in an app.

- **Rust browser gates** — `bun run client:test`, `bun run client:tsgo`, and `bun run client:build:wasm` cover the canonical browser client package
- **Rust conformance** — `bun run rust:conformance:fast` covers the shared client/server protocol scenarios
- **Server and package tests** — `bun test` covers remaining TypeScript server, core, dialect, migration, and typegen packages

Start here:

```bash
bun test
bun run client:test
bun run rust:conformance:fast
```

The generic Linux `bun test` path intentionally excludes
`packages/client/src/__tests__/*.wasm.test.ts`; Bun worker/WASM delivery is
fragile on Linux under newer Bun releases. For browser/WASM or runtime-worker
changes, use the dedicated browser gates in
[`rust/docs/QUALITY_GATES.md`](rust/docs/QUALITY_GATES.md) with pinned Bun
1.3.9.

See the [Testing docs](https://syncular.dev/docs/testing) for the full testkit API, fault injection patterns, and runtime examples.

## Supported platforms

Use the canonical Rust-backed client with the server runtime/dialect that fits
your deployment. The sync protocol is the same everywhere.

### Client

The canonical app client is `@syncular/client`, backed by the Rust
browser/native runtime and generated TypeScript bindings. Older pure TypeScript
client implementations are no longer a product path.

### Server

| Dialect / runtime | Use case | Package |
|---|---|---|
| Postgres | Production (Node, Bun, Workers, …) | `@syncular/server/postgres` |
| Neon-backed Postgres | Production serverless / edge runtimes | `@syncular/server/postgres` via `createNeonServerDialect()` |
| SQLite | Dev / testing | `@syncular/server/sqlite` |
| Cloudflare Worker + D1 | Cloudflare Workers (HTTP only) | `@syncular/server/cloudflare` |
| Cloudflare Durable Object + D1 | Cloudflare Workers + WebSocket realtime | `@syncular/server/cloudflare` |

## Core packages

Most packages are published under the `@syncular` scope on npm. The `syncular`
package is CLI-only (`npx syncular generate`); app code imports from the scoped
packages and their subpaths.

| Package | Description |
|---|---|
| `syncular` | CLI package for `npx syncular generate`, `schema check`, and `codegen install` |
| `@syncular/server` | Server sync engine (push, pull, pruning, snapshots, blobs) |
| `@syncular/server/hono` | Hono adapter with HTTP routes, OpenAPI, WebSocket, and console routes |
| `@syncular/server/cloudflare` | Cloudflare adapter for Workers and Durable Objects |
| `@syncular/client` | Rust-owned browser client package with TypeScript runtime bindings |
| `@syncular/client/react` | React hooks and provider for the Rust-owned client |
| `@syncular/client/tauri` | Tauri JS/React bridge facade over a Rust Syncular host |
| `@syncular/client/react-native` | React Native/Nitro bridge facade over a native Syncular host |
| `@syncular/core/http` | HTTP push/pull transport |
| `@syncular/console` | Embeddable console UI for commits, clients, events, and operations |
| `@syncular/testkit` | Server fixtures, protocol request builders, realtime helpers, and fault injection |
| `@syncular/migrations` | Versioned migrations with checksum tracking |
| `@syncular/typegen` | Generate database types from migrations |

Need more? Optional subpaths cover server blob storage adapters, server CRDT
handling, relay, observability, and tooling. See the [Installation guide](https://syncular.dev/docs/start/installation) for the full matrix.

## Run locally

```bash
bun install
bun --cwd apps/docs dev     # docs site (Next dev, typically http://localhost:3000)
bun --cwd apps/console dev  # standalone console app; run separately and use the URL printed at startup
```

## License

Apache-2.0
