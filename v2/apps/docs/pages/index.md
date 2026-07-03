# Why syncular

Syncular gives your app a local SQLite database that stays in sync with a
server-authoritative commit log, scoped to exactly the data each user is
allowed to see. You read and write local SQL; syncular handles the rest —
optimistic writes, bootstrap, realtime deltas, offline replay, conflicts.

The one-liner: **local SQLite + a server-authoritative commit log + scopes.**

## The numbers

- **30 ms** to bootstrap a 100k-row image on a fresh client (warm/storm
  case; the rows lane is 365 ms) — see [bench results](../../bench/RESULTS.md).
- **14 KB gzip** of syncular's own client JavaScript (45.5 KB raw) — versus
  v1's 217.7 KB. The rest of the browser payload is the stock SQLite
  distribution, which every wasm-SQLite product ships.
- **Two conformance-locked cores** — a TypeScript core for the web and a
  Rust core for native — that interoperate because they both implement one
  written protocol, verified by a shared conformance suite, not by sharing a
  binary.

## The v1 → v2 story, in three sentences

v1 proved the design — scope-based authorization, a server-authoritative
commit log with an optimistic outbox, precomputed snapshot artifacts — but
bled effort on infrastructure entropy: one Rust binary bridged everywhere, an
implicit protocol, socket-coupled tests, and toolchain taxes on JS users.
v2 keeps ~90% of the design and spends the whole budget on **boring-ness**: a
[written protocol](../../SPEC.md) with golden vectors, two cores instead of
one bridged binary, no cargo in the JS toolchain, and no fallback paths — one
good path per concern. The result is a TypeScript-first sync engine at v1
feature parity where it matters, with the native core re-entering through the
same conformance suite.

## What "boring" buys you

| Decision | Why it matters |
|---|---|
| A written protocol ([SPEC.md](../../SPEC.md)) | A third implementation plugs in against a spec + vectors, not a binary. Divergence is a bug you can point at. |
| Two cores, one protocol | The web core is small, debuggable TypeScript with no cargo; the Rust core ships native. Parity is a CI gate, not a hope. |
| No fallback ladders | One sync loop over WebSocket, one persistent browser mode (OPFS), one bootstrap format preference. Unsupported means fail-loud, never a silent degraded path. |
| Scopes run in *your* backend | `resolveScopes(actor)` lives next to your auth. Sync never becomes a second authorization system to keep in agreement. |

## Where to go next

- **[Quickstart](/quickstart/)** — two synced clients in a terminal, no browser, ≤ 5 minutes.
- **[Scopes & authorization](/concepts-scopes/)** — the moat, and the one piece you write.
- **[Server setup](/guide-server/)** and **[Web client](/guide-client/)** — wiring the real thing.
- **[Protocol & conformance](/guide-conformance/)** — how the two cores stay in lockstep, and how a third joins.

> Version-truth: this documents what is in the v2 tree today. Roadmap items
> (windowed sync / local eviction, CRDT fields, React live-query bindings)
> are called out as roadmap where they appear, never documented as shipped.
