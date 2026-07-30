<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="logo/readme-animated-dark.svg" />
    <img alt="Animated syncular ASCII singularity" src="logo/readme-animated-light.svg" width="720" />
  </picture>
</p>

# syncular

Server-authoritative, offline-first SQL sync you can operate. Clients keep a
real local SQLite database (OPFS in the browser, native SQLite elsewhere),
writes go through an optimistic outbox, and one ordered commit log on the
server stays the source of truth.

**[Documentation](https://syncular.dev)** ·
[Quickstart](https://syncular.dev/quickstart/) ·
[Live demos](https://syncular.dev/demos/) ·
[Benchmarks](https://syncular.dev/benchmarks/) ·
[Blog](https://syncular.dev/blog/)

```sh
bun create syncular-app my-app
```

## How the repo is built

- **Spec-first**: [`SPEC.md`](docs/SPEC.md) is normative and
  [`spec/vectors/`](spec/vectors) are golden fixtures; when spec and code
  disagree, the code changes. Two cores (TypeScript and Rust) are kept in
  lockstep by an implementation-agnostic conformance suite.
- **Test doctrine**: loopback in-memory transport for integration scenarios;
  fault injection at the transport interface; tests wait on explicit readiness
  signals (sleeps are banned); real-socket tests few and quarantined. See
  [`packages/conformance`](packages/conformance/README.md).
- **One good path**: the browser persists to OPFS and reports unsupported
  environments as errors; sync runs over the WebSocket.

## Layout

| Path | What it is |
|---|---|
| [`packages/core`](packages/core) | Protocol codecs, shared types, vector round-trip |
| [`packages/server`](packages/server) | `handleSyncRequest(bytes, ctx)` + storage/auth interfaces (SQLite, Postgres, D1) |
| [`packages/server-hono`](packages/server-hono), [`packages/server-workers`](packages/server-workers) | Framework bindings (Hono, Cloudflare Workers) |
| [`packages/web-client`](packages/web-client) | `@syncular/client`: TS client core on `@sqlite.org/sqlite-wasm` |
| [`packages/react`](packages/react) | React hooks over the client |
| [`packages/typegen`](packages/typegen) | Schema IR + TypeScript emitter, named queries (cargo-free) |
| [`packages/crypto`](packages/crypto), [`packages/crdt-yjs`](packages/crdt-yjs) | Per-column E2EE primitives, Yjs CRDT mergers |
| [`packages/testing`](packages/testing) | `@syncular/testkit`: in-memory loopback of real server + clients |
| [`packages/conformance`](packages/conformance) | Scenario runner both cores must pass |
| [`rust/`](rust) | The Rust client core and its C-ABI FFI crate |
| [`bindings/`](bindings) | Tauri, React Native, Swift, Kotlin, Flutter |
| [`apps/docs`](apps/docs) | The docs site ([syncular.dev](https://syncular.dev)) |

## Commands

```sh
bun install
bun run check   # typecheck + lint + test
```

## Contributing

Read [`AGENTS.md`](AGENTS.md) first. The doctrine in it (spec-first, no
fallbacks, no timers in tests, cross-core parity) applies to human and
machine contributors alike.

On AI assistance: LLMs are welcome for tests, reproductions, benchmarks, and
other technical work. For production code, use them under strict review and
iteration; you must understand and be able to defend every line you submit.
Syncular itself is built this way: LLM assistance is used mainly for writing
tests and iterating over technical concepts, under that same review bar.
Low-effort machine-generated PRs, issues, and comments are closed without
comment. The full policy and the plain-text docs bundle for agents live at
[syncular.dev/llms](https://syncular.dev/llms/).
