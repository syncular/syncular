# What is syncular

Syncular gives your app a **local SQLite database that stays in sync** with a
server-authoritative commit log, scoped to exactly the data each user is
allowed to see. You read and write local SQL; syncular handles the rest —
optimistic writes, bootstrap, realtime deltas, offline replay, conflicts.

The one-liner: **local SQLite + a server-authoritative commit log + scopes.**

## How it fits together

Every client — a browser tab, an iPhone, a Flutter app, a Rust process — owns a
real SQLite database. Reads are plain SQL against that database: joins,
aggregates, indexes, all local and instant. Writes apply locally at once and
queue in a durable **outbox**; when the network is there, they push to the
server as idempotent **commits**.

The server is authoritative. It validates every commit against your **scopes**
(one `resolveScopes(actor)` function that lives in *your* backend, next to your
auth), appends it to an ordered commit log, and delivers it to every subscribed
client — as a fast bootstrap **segment** for fresh replicas, and as realtime
deltas over WebSocket for live ones. Conflicting writes are detected by version
and surfaced to your app with the server row attached; nothing is silently
merged.

## One protocol, two cores, every platform

Syncular is a **written protocol** ([SPEC.md](https://github.com/syncular/syncular/blob/main/SPEC.md))
with two independent, conformance-locked implementations:

- A **TypeScript core** for the web — the whole client runs in a Web Worker on
  OPFS-backed sqlite-wasm, 19.6 KB gzip of syncular's own code.
- A **Rust core** for everything else — rusqlite on the device filesystem,
  shipped through a five-function C FFI.

Both pass the same golden byte-level vectors and the same conformance catalog
(74 scenarios, run against both cores in CI). The platform bindings are thin
marshaling over the shared Rust core, so protocol behavior is identical
everywhere:

| Platform | What you use | Guide |
|---|---|---|
| Browser | `@syncular/client` (worker + OPFS) | [Web](/platform-web/) |
| React | `@syncular/react` hooks | [React](/platform-react/) |
| iOS / macOS | `SyncularClient` Swift package | [Swift](/platform-swift/) |
| Android / JVM | `SyncularClient` Kotlin library (FFM) | [Kotlin](/platform-kotlin/) |
| Flutter | `syncular` Dart package (dart:ffi) | [Flutter](/platform-flutter/) |
| React Native | `@syncular/react-native` TurboModule | [React Native](/platform-react-native/) |
| Desktop (Tauri) | `tauri-plugin-syncular` + `@syncular/tauri` | [Tauri](/platform-tauri/) |
| Rust | `syncular-client` crate | [Rust](/platform-rust/) |
| Anything with a C FFI | `syncular-ffi` (5 functions) | [Embedding](/platform-ffi/) |

On the server you get a framework-neutral core with adapters for
[Bun/Node via Hono](/guide-server/) and
[Cloudflare Workers](/server-workers/), storage on
[SQLite, Postgres, or D1](/server-storage/), and segments/blobs on
S3-compatible stores.

## What it is — and is not

Syncular is **server-authoritative, offline-first SQL sync you can operate**.
It is deliberately not several other things:

- **Not decentralized.** There is one server and one ordered log. That is a
  feature: authorization, audit, and pruning stay tractable.
- **Not a pure CRDT engine.** Rows converge through versioned upserts with
  explicit conflicts; [CRDT columns](/concepts-crdt/) (Yjs/yrs) are opt-in for
  collaborative text, not the default for all data.
- **Not automatic conflict resolution.** Version mismatches are surfaced with
  the server row attached; your app decides. See
  [Conflicts](/concepts-conflicts/).
- **Not for frame-by-frame multiplayer.** Great for durable, authorized app
  data; wrong tool for physics state.

## Boring by design

v1 of syncular proved the design — scopes, a server-authoritative log with an
optimistic outbox, precomputed snapshots — but bled effort on infrastructure
entropy: one Rust binary bridged everywhere, an implicit protocol, toolchain
taxes on JS users. v2 keeps the design and spends the whole budget on
**boring-ness**:

| Decision | Why it matters |
|---|---|
| A written protocol ([SPEC.md](https://github.com/syncular/syncular/blob/main/SPEC.md)) | A third implementation plugs in against a spec + vectors, not a binary. Divergence is a bug you can point at. |
| Two cores, one protocol | The web core is small, debuggable TypeScript with no cargo; the Rust core ships native. Parity is a CI gate, not a hope. |
| No fallback ladders | One sync loop over WebSocket, one persistent browser mode (OPFS), one bootstrap format preference. Unsupported means fail-loud, never a silent degraded path. |
| Scopes run in *your* backend | `resolveScopes(actor)` lives next to your auth. Sync never becomes a second authorization system to keep in agreement. |
| One command to a running app | `bun create syncular-app my-app` scaffolds a working server + client with the typed schema wired up — no cargo, no config archaeology. |

## The numbers

- **30 ms** to bootstrap a 100k-row image on a fresh client (the rows lane is
  365 ms) — see [benchmarks](/benchmarks/).
- **0.2 ms p95** realtime propagation between two live clients.
- **19.6 KB gzip** of syncular's own client JavaScript; the rest of the browser
  payload is the stock sqlite-wasm distribution every wasm-SQLite product ships.
- **764 tests, 74 conformance scenarios × 2 cores, 19 golden vector cases** —
  all CI-blocking.

> Version-truth: these docs describe what is in the tree today. Roadmap items
> are called out as roadmap where they appear, never documented as shipped.

## Where to go next

- **[Quickstart](/quickstart/)** — two synced clients in a terminal, ≤ 5 minutes.
- **[Live demos](/demos/)** — see convergence, offline replay, and conflicts run.
- **[Scopes & authorization](/concepts-scopes/)** — the moat, and the one piece you write.
- **[Protocol & conformance](/guide-conformance/)** — how the two cores stay in lockstep.
