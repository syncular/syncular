# What is syncular

Syncular gives your app a **local SQLite database that stays in sync** with a
server-authoritative commit log, scoped to the data each user is allowed to
see. You read and write local SQL; syncular handles optimistic writes,
bootstrap, realtime deltas, offline replay, and conflicts.

The one-liner: **local SQLite + a server-authoritative commit log + scopes.**

## How it fits together

Every client (a browser tab, an iPhone, a Flutter app, a Rust process) owns a
real SQLite database. Reads are plain SQL against that database, so joins,
aggregates, and indexes work locally without a network round trip. Writes
apply locally at once and queue in a durable **outbox**; when the network is
there, they push to the server as idempotent **commits**.

Reads can remain raw SQL or become checked named queries. One SQL or SYQL
source is lowered to a target-neutral QueryIR and generates typed APIs for
TypeScript, Swift, Kotlin, Dart, and Rust, including the reactive dependencies
and synchronization coverage the compiler can prove.

The server is authoritative. It validates every commit against your **scopes**
(one `resolveScopes(actor)` function that lives in *your* backend, next to your
auth), appends it to an ordered commit log, and delivers it to every subscribed
client: as a fast bootstrap **segment** for fresh replicas, and as realtime
deltas over WebSocket for live ones. Conflicting writes are detected by version
and handed to your app with the server row attached, so your app decides the
merge.

## One protocol, two cores

Syncular is a **written protocol** ([SPEC.md](https://github.com/syncular/syncular/blob/main/docs/SPEC.md))
with two independent, conformance-locked implementations:

- A **TypeScript core** for the web. The whole client runs in a Web Worker on
  OPFS-backed sqlite-wasm, 31.3 KB gzip of syncular's own code.
- A **Rust core** for everything else: rusqlite on the device filesystem,
  shipped through a five-function C FFI.

Both pass the same golden byte-level vectors and the same 93-scenario
conformance catalog, run against both cores in CI. The platform bindings are
thin marshaling over the shared Rust core, so protocol behavior is identical
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

## Boundaries

Syncular is **server-authoritative, offline-first SQL sync you can operate**.
A few boundaries define it:

- **One server, one ordered log.** A single source of truth keeps
  authorization, audit, and pruning tractable. There is no peer-to-peer mode.
- **Versioned rows with explicit conflicts.** Rows converge through versioned
  upserts, and conflicts surface to your app. Where you want collaborative
  text, [CRDT columns](/concepts-crdt/) (Yjs/yrs) handle merging per column.
- **Your app resolves conflicts.** Version mismatches arrive with the server
  row attached, and your code decides what happens next. See
  [Conflicts](/concepts-conflicts/).
- **Built for durable, authorized app data.** Frame-by-frame multiplayer
  state belongs in a dedicated netcode layer.

## Boring by design

Sync engines usually bleed effort on infrastructure: implicit protocols and
toolchain overhead. Syncular spends its whole budget on boring-ness:

| Decision | Why it matters |
|---|---|
| A written protocol ([SPEC.md](https://github.com/syncular/syncular/blob/main/docs/SPEC.md)) | A third implementation plugs in against the spec and its golden vectors. Divergence is a bug you can point at. |
| Two cores, one protocol | The web core is small, debuggable TypeScript that builds without the Rust toolchain; the Rust core ships native. Parity between them is a CI gate. |
| One query plan, five targets | TypeScript, Swift, Kotlin, Dart, and Rust generated queries share inputs, selected SQL, bind order, dependencies, coverage, and row identity. |
| One path per concern | One sync loop over WebSocket, one persistent browser mode (OPFS), one preferred bootstrap format. An unsupported environment produces a clear error. |
| Scopes run in *your* backend | `resolveScopes(actor)` lives next to your auth, so sync reuses the authorization you already have. |
| One command to a running app | `bun create syncular-app my-app` scaffolds a working server and client with the typed schema already wired up. |

## The numbers

- **30 ms** to bootstrap a 100k-row image on a fresh client (the rows lane is
  365 ms). See [benchmarks](/benchmarks/).
- **0.2 ms p95** realtime propagation between two live clients.
- **31.3 KB gzip** of syncular's own client JavaScript; the rest of the browser
  payload is the stock sqlite-wasm distribution every wasm-SQLite product ships.
- The complete conformance catalog, protocol vectors, package suite, and
  platform-native gates are CI-blocking.

> These docs describe what is in the tree today. Roadmap items are labeled as
> roadmap where they appear.

## Where to go next

- **[Quickstart](/quickstart/)** — two synced clients in a terminal, ≤ 5 minutes.
- **[Live demos](/demos/)** — see convergence, offline replay, and conflicts run.
- **[Scopes & authorization](/concepts-scopes/)** — the one piece you write yourself.
- **[Protocol & conformance](/guide-conformance/)** — how the two cores stay in lockstep.
