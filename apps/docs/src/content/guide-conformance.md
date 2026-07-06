# Protocol & conformance

Syncular's two cores — TypeScript for the web, Rust for native — interoperate
because they both implement one **written protocol**, not because they share a
binary. The protocol is [`SPEC.md`](https://github.com/syncular/syncular/blob/main/SPEC.md); parity is proven by a
shared **conformance suite**. This page explains what the spec is and how a
third implementation plugs in.

## SPEC.md is the constitution

[`SPEC.md`](https://github.com/syncular/syncular/blob/main/SPEC.md) is normative. It fully specifies the wire format
(the SSP2 envelope, frames, the row codec, segments) and the semantics (the
commit/cursor model, scope intersection and revocation, bootstrap phases,
conflict detection, realtime). Everything needed to interoperate is in that
document plus the **golden vectors** in `spec/vectors/` — an implementer needs
no access to any existing source tree.

The rules of the tree ([ROADMAP.md](https://github.com/syncular/syncular/blob/main/ROADMAP.md)):

- **Spec-first.** Behavior lands in the spec, with vectors or conformance
  scenarios, before or with the code. The spec is never reverse-engineered
  from an implementation.
- **Canonical encoding.** For every value there is exactly one valid byte
  sequence; golden vectors verify byte-for-byte round-trips. An encoder that
  produces different bytes for the same value is non-conformant.
- **A change to wire format or semantics** requires a version bump and updated
  vectors in the same commit.

## The conformance runner

`@syncular/conformance` is an implementation-agnostic scenario catalog that
runs against any `(client, server)` pairing through a **driver interface**.
`bun run check` runs the whole catalog on (TS client × TS server) plus the
golden-vector stage; the Rust pairing runs the same catalog against the TS
server. The [conformance README](https://github.com/syncular/syncular/blob/main/packages/conformance/README.md) is both
the runner reference and the **test doctrine** for the tree:

- **Loopback by default** — scenarios drive the server through its byte-level
  entry points over an in-memory loopback the implementations cannot
  distinguish from a network. No HTTP, no sockets, no ports for 99% of tests.
- **Fault injection at the transport seam** — dropped requests/responses,
  duplicate delivery, stale retransmit, byte truncation — all deterministic.
- **Readiness waits, never sleeps** — every wait is an explicit completion
  promise; there is zero `setTimeout` in the package, grep-enforced.
- **Scenarios are never weakened** — a divergence is marked with its spec ref
  and *expected* to fail until fixed, so stale markers rot loudly.

## Plugging in a third implementation

A new client or server implements a **driver** — the seam the runner already
uses for the TS and Rust cores. The reference `ts-server` driver
([source](https://github.com/syncular/syncular/blob/main/packages/conformance/src/drivers/ts-server.ts)) shows the
surface: `handleSyncRequest(bytes)`, the segment-download handler, the realtime
hub connect, plus test hooks (set allowed scopes, advance the virtual clock,
inject faults). A driver declares its `capabilities` (e.g. `signed-urls`,
`blobs`, `idempotency-fault`); scenarios needing a capability skip drivers that
lack it.

The path for a third core is therefore: implement `SPEC.md`, pass the golden
vectors byte-for-byte, then pass the conformance catalog through a driver
shim. That is exactly how the clean-room Rust core was validated — written from
the spec alone, it passed every vector on first run and the full catalog
against the TS server.

This is also how features land: **CRDT fields** shipped spec-first — the
column type and merge semantics in
[SPEC §5.10](https://github.com/syncular/syncular/blob/main/SPEC.md#510-crdt-columns--opt-in-collaborative-state), two
golden vectors, and convergence scenarios in the catalog run by both client
cores (the Rust core round-trips the same bytes the TS core merges through
`@syncular/crdt-yjs`).
