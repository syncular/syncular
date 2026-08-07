<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="logo/readme-animated-dark.svg" />
    <img alt="Animated syncular ASCII singularity" src="logo/readme-animated-light.svg" width="720" />
  </picture>
</p>

# syncular

Syncular keeps an SQLite database on each client and synchronizes it through a
server-owned commit log. Apps read from local SQLite and continue to work
offline. A write updates local state immediately, enters an outbox, and is
checked by the server when it syncs.

The browser client runs SQLite on OPFS. Native integrations share the Rust core
and native SQLite across Rust, Swift, Kotlin, Flutter, React Native, and Tauri.
Servers run on Bun, Node, or Cloudflare Workers with SQLite, Postgres, or D1.
Backend processes can run the same SQLite client headlessly, or use the
database-less remote client for push-only commits and registered server
operations.

**[Documentation](https://syncular.dev)** ·
[Quickstart](https://syncular.dev/quickstart/) ·
[Live demos](https://syncular.dev/demos/) ·
[Benchmarks](https://syncular.dev/benchmarks/) ·
[Blog](https://syncular.dev/blog/)

## Try it

```sh
bun create syncular-app my-app --template minimal
```

The minimal template creates a server, a schema, two independent clients, and a
smoke test. The [five-minute quickstart](https://syncular.dev/quickstart/)
walks through the generated project and runs the two clients against each
other.

## Project status

Syncular is pre-1.0 and currently maintained by me,
[Benjamin Kniffler](https://github.com/bkniffler). The wire protocol is written
down and checked across two implementations. Public APIs and protocol details
can still change before 1.0. Changes are recorded in
[`docs/RELEASE.md`](docs/RELEASE.md).

## How behavior is checked

[`docs/SPEC.md`](docs/SPEC.md) defines the sync wire protocol,
[`docs/REMOTE.md`](docs/REMOTE.md) defines registered remote operations, and
[`spec/vectors/`](spec/vectors) contains its byte-level fixtures. The
TypeScript and Rust cores run the same implementation-independent conformance
catalog. A behavior change that affects both cores has to update the spec and
add a conformance scenario.

Integration tests use an in-memory transport with deterministic fault
injection. They wait for explicit readiness signals; sleeps are banned. A small
set of adapter tests exercises real sockets. The details live in
[`packages/conformance`](packages/conformance/README.md).

## Repository map

| Path | What it contains |
|---|---|
| [`packages/core`](packages/core) | Protocol codecs, shared types, vector round-trips |
| [`packages/server`](packages/server) | Server protocol handler plus storage and authorization interfaces |
| [`packages/server-hono`](packages/server-hono), [`packages/server-workers`](packages/server-workers) | Hono and Cloudflare Workers bindings |
| [`packages/web-client`](packages/web-client) | `@syncular/client`, the TypeScript client core on SQLite |
| [`packages/react`](packages/react) | React hooks over the client |
| [`packages/typegen`](packages/typegen) | Schema and query compiler with TypeScript, Swift, Kotlin, Dart, and Rust output |
| [`packages/crypto`](packages/crypto), [`packages/crdt-yjs`](packages/crdt-yjs) | Column encryption and Yjs CRDT integration |
| [`packages/testing`](packages/testing) | `@syncular/testkit`, an in-process server and clients |
| [`packages/conformance`](packages/conformance) | The scenario catalog both cores run |
| [`rust/`](rust) | Rust client core, command surface, and C FFI |
| [`bindings/`](bindings) | Tauri, React Native, Swift, Kotlin, and Flutter bindings |
| [`apps/docs`](apps/docs) | The [syncular.dev](https://syncular.dev) source |

## Development

```sh
bun install
bun run check   # typecheck + lint + test
```

Read [`AGENTS.md`](AGENTS.md) before contributing. It contains the rules that
apply to maintainer work and external contributions.

## LLMs

This README has had plenty of LLM help. So has the rest of the project: docs,
tests, benchmarks, production code. Syncular itself wasn't prompted into
existence though; I've spent years on offline-first problems, built
[`debe`](https://github.com/bkniffler/debe) back in 2019, and studied
PowerSync, Zero, Electric, Replicache, Turso, LiveStore, and Jazz closely
before writing this engine. The concepts and their first implementations are
hand-written, and the checks above apply to every diff no matter where it
came from. The full story is at
[syncular.dev/llms](https://syncular.dev/llms/).

Contributions with LLM help are welcome. If a model drafted or rewrote
something that's still in your pull request, say so in the description. Read
your own diff and be ready to explain it; pull requests pasted straight out
of a model are closed without comment.
