<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="logo/banner-dark.svg" />
    <img alt="syncular" src="logo/banner-light.svg" width="440" />
  </picture>
</p>

# syncular

Server-authoritative, offline-first SQL sync you can operate. Clients keep a
real local SQLite database (OPFS in the browser, native SQLite elsewhere),
writes go through an optimistic outbox, and one ordered commit log on the
server stays the source of truth. Docs live at
[syncular.dev](https://syncular.dev).

```sh
bun create syncular-app my-app
```

## How the repo is built

- **Spec-first**: [`SPEC.md`](SPEC.md) is normative; [`spec/vectors/`](spec/vectors)
  are golden fixtures; implementations follow the spec, never the other way
  around. Two cores — TypeScript and Rust — are kept in lockstep by an
  implementation-agnostic conformance suite.
- **Test doctrine**: loopback in-memory transport for integration scenarios;
  fault injection at the transport interface; readiness waits, never sleeps;
  real-socket tests few and quarantined. See
  [`packages/conformance`](packages/conformance/README.md).
- **One good path**: OPFS or fail-loud in the browser, sync over the
  WebSocket, no fallback ladders.

## Layout

| Path | What it is |
|---|---|
| [`packages/core`](packages/core) | Protocol codecs, shared types, vector round-trip |
| [`packages/server`](packages/server) | `handleSyncRequest(bytes, ctx)` + storage/auth interfaces (SQLite, Postgres, D1) |
| [`packages/server-hono`](packages/server-hono), [`packages/server-workers`](packages/server-workers) | Framework bindings (Hono, Cloudflare Workers) |
| [`packages/web-client`](packages/web-client) | `@syncular/client` — TS client core on `@sqlite.org/sqlite-wasm` |
| [`packages/react`](packages/react) | React hooks over the client |
| [`packages/typegen`](packages/typegen) | Schema IR + TypeScript emitter, named queries (cargo-free) |
| [`packages/crypto`](packages/crypto), [`packages/crdt-yjs`](packages/crdt-yjs) | Per-column E2EE primitives, Yjs CRDT mergers |
| [`packages/testing`](packages/testing) | `@syncular/testkit` — in-memory loopback of real server + clients |
| [`packages/conformance`](packages/conformance) | Scenario runner both cores must pass |
| [`rust/`](rust) | The Rust client core and its C-ABI FFI crate |
| [`bindings/`](bindings) | Tauri, React Native, Swift, Kotlin, Flutter |
| [`apps/docs`](apps/docs) | The docs site ([syncular.dev](https://syncular.dev)) |

## Commands

```sh
bun install
bun run check   # typecheck + lint + test
```
