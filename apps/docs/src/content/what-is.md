# What is Syncular

Syncular is a local-first sync engine. Every client reads and writes a local SQLite database, and one server converges all clients through an ordered commit log. This page is for engineers deciding whether Syncular fits an app; it covers the model, the platforms, and the limits.

::meta{for="Engineers evaluating Syncular" time="3 minutes" first="quickstart"}

:::terms
- **Commit**: An atomic group of row writes that the server applies entirely or not at all.
- **Outbox**: The local queue of commits waiting to be sent.
- **Scope**: The group a row belongs to, such as one list. Scopes decide which rows a user receives.
- **Segment**: A snapshot of a client's rows that a new client downloads to start.
:::

:::figure{title="How a write reaches every client" note="Server is the authority" ticks}
<div class="d-row">
<div class="node hot"><span class="t">Client · local SQLite</span>Reads are local SQL<br>Writes apply at once</div>
<span class="d-arrow"></span>
<div class="node"><span class="t">Outbox</span>Commits queue until the network is there</div>
<span class="d-arrow"></span>
<div class="node ok"><span class="t">Server</span>Checks scopes, appends to the commit log</div>
<span class="d-arrow"></span>
<div class="node cool"><span class="t">Other clients</span>Segment on first sync, then realtime deltas</div>
</div>

::caption[The server checks scopes with `resolveScopes(actor)`, a function in your backend next to your auth.]
:::

## What you get

- **Local reads.** Queries are plain SQL against the device database, so joins, aggregates, and indexes need no network round trip. Named queries written in SQL or [SYQL](/syql/) generate typed APIs for TypeScript, Swift, Kotlin, Dart, and Rust.
- **Optimistic writes.** A write changes the local table and joins the outbox in one transaction. The outbox retries as idempotent commits ([Commits](/concepts-commits/)).
- **Authorization you already have.** The server validates every commit against your scopes ([Scopes](/concepts-scopes/)).
- **Explicit conflicts.** A version mismatch returns to your app with the server row attached, and your code decides the merge ([Conflicts](/concepts-conflicts/)).

## One protocol, two cores

The protocol is written down in [SPEC.md](https://github.com/syncular/syncular/blob/main/docs/SPEC.md). A TypeScript core serves the web and a Rust core serves every other platform, and CI runs a shared conformance catalog against both ([Protocol & conformance](/reference/#protocol--conformance)). Measured performance is on [Benchmarks](/benchmarks/).

| Platform | Guide |
|---|---|
| Browser, React | [Web](/platform-web/), [React](/platform-react/) |
| iOS and macOS, Android and JVM | [Swift](/platform-swift/), [Kotlin](/platform-kotlin/) |
| Flutter, React Native, Tauri | [Flutter](/platform-flutter/), [React Native](/platform-react-native/), [Tauri](/platform-tauri/) |
| Rust, any language with a C FFI | [Rust](/platform-rust/), [C FFI](/platform-ffi/) |

The server runs on Bun or Node through Hono ([Server setup](/guide-server/)) or on [Cloudflare Workers](/server-workers/), with storage on [SQLite, Postgres, or D1](/server-storage/).

## Limits

- **One server, one ordered log.** There is no peer-to-peer mode.
- **Versioned rows.** Rows converge through versioned upserts. [CRDT columns](/concepts-crdt/) merge collaborative text per column.
- **Durable, authorized app data.** Frame-by-frame multiplayer state belongs in a dedicated netcode layer.

Run the [quickstart](/quickstart/) to see two clients converge in a terminal, or open the [live demos](/demos/).
