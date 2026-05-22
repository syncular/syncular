# WP-28 Relay Rust Evaluation And Protocol Validation

Status: `[x]` accepted, depends on WP-27

## Goal

Evaluate where more Rust-owned relay/server-edge code would actually help, then
retain only the smallest proven integration point. Protocol validation in the
existing TypeScript relay path is the first candidate, not a guaranteed final
shape.

## Why

WP-27 proves the Rust protocol boundary in tests. Before creating separate Rust
edge proxy, realtime fanout, or server WPs, we need evidence about where Rust
would improve relay/server behavior versus where it would only add boundary
cost, deployment complexity, or duplicate ownership.

The working hypothesis is that Rust may help most where the code is protocol,
binary, verification, or connection-oriented. Rust should not move into relay
app semantics unless a later product decision says Rust owns server-side table
handlers, authorization, scope resolution, and mutation application.

## Scope

- Baseline current relay/server paths before adding Rust:
  - local client push into relay;
  - relay forward to main server;
  - relay pull from main server and local apply;
  - local client pull from relay;
  - realtime wakeup/delta handling where relay/server coverage exists;
  - blob/snapshot artifact paths if they are relay-relevant.
- Evaluate candidate Rust boundaries:
  - protocol validation only;
  - binary sync-pack decode/inspect/validate;
  - snapshot chunk/artifact reference validation;
  - blob metadata/hash validation;
  - auth lease provenance validation;
  - realtime frame validation and ACK/overflow semantics;
  - edge/proxy byte-preserving forwarding feasibility.
- Prototype one or more candidate boundaries behind tests or a dev-only path
  when measurement requires code.
- Measure boundary overhead explicitly: JSON materialization, byte copies,
  wasm/native call cost, startup cost, package size, memory, and deployability.
- Brainstorm follow-up shapes from the evidence and record the decision:
  stop, retain a small validation path, or create a new scoped WP.

## Non-Scope

- No relay rewrite in Rust.
- No replacement for `ForwardEngine`, `PullEngine`, `SequenceMapper`, or relay
  Kysely storage.
- No Rust table handlers, scope resolution, conflict generation, or mutation
  application.
- No fallback from failed Rust validation to legacy TypeScript protocol
  acceptance.
- No pre-created Rust edge proxy, realtime fanout, or pure server WP until this
  evaluation produces a concrete target.

## Evaluation Questions

1. Which relay/server paths are protocol-heavy enough that Rust reuse matters?
2. Which paths are app-semantics-heavy and should stay TypeScript/Kysely-owned?
3. Does Rust validation catch meaningful drift or malformed inputs that current
   TypeScript relay/server tests miss?
4. Is the Rust call boundary cheap enough for hot paths, or only suitable for
   offline/dev/test validation?
5. Can binary payloads stay binary across the boundary, or does the integration
   force JSON/map materialization?
6. Does Rust make realtime fanout, ACK/replay, or overflow behavior simpler or
   more measurable than the current server manager?
7. Would an edge proxy preserve protocol bodies byte-for-byte, or would it
   become a partial server rewrite?
8. What follow-up WP would be justified by evidence, if any?

## Measurement Plan

Before retaining production behavior, capture before/after or candidate/control
evidence for the relevant paths:

- Relay push/forward latency and CPU time.
- Relay pull/apply latency and CPU time.
- Local client pull from relay latency and response bytes.
- Realtime delivery p50/p95, dropped frames, ACK latency, reconnect recovery,
  and HTTP pull-required count.
- Blob/snapshot validation cost when those paths are in scope.
- Boundary overhead: wasm/native call count, payload bytes copied, JSON
  serialization time, memory delta, and startup/package cost.
- Correctness value: malformed fixture classes rejected, protocol drift caught,
  and diagnostics quality.

If a metric cannot be collected with existing tests, add a focused benchmark or
instrumentation point before deciding.

## Acceptance Criteria

- Current relay/server baselines are recorded for the paths being evaluated.
- At least one Rust boundary candidate is evaluated with correctness and cost
  evidence, even if the decision is to stop.
- Valid relay flows remain behaviorally unchanged in existing relay tests.
- Malformed protocol fixtures produce stable diagnostics without leaking row
  payloads or secret material.
- The final WP note records one decision:
  - retain a small Rust validation path;
  - keep Rust protocol checks in tests/dev tooling only;
  - create a new scoped WP for a specific Rust relay/server component;
  - or stop because TypeScript relay/server ownership is still the right shape.

## Required Gates

- WP-27 gates.
- `bun run --cwd packages/relay evaluate:rust-boundary`
- `bun run --cwd packages/relay evaluate:relay-paths`
- `bun test packages/relay`
- `bun run --cwd packages/relay tsgo`
- Server/Hono realtime tests if relay websocket handling is touched.
- Targeted relay/server benchmark for any candidate placed on a hot path.

## Accept / Reject Rule

- Retain only if the evidence shows a correctness, performance,
  observability, or maintainability benefit that is larger than the Rust
  boundary cost.
- Retain production validation only if it strengthens relay correctness without
  changing app authorization or mutation semantics.
- Reject if the boundary forces JSON materialization on a binary hot path
  without a measured reason.
- Reject if production relay behavior gains a compatibility fallback around the
  current protocol.
- Reject new Rust server/relay component WPs that are not backed by this
  evaluation's measurements and product reasoning.

## Current Evidence

- Relay currently imports protocol and server types from TypeScript packages.
- Server-edge docs recommend starting with the protocol boundary before any
  Rust edge/proxy product.
- WP-02 accepted `syncular-protocol` as the shared Rust protocol owner.
- WP-11 deferred Rust server/proxy work until there is a concrete target.
- First evaluation slice added
  `packages/relay/scripts/evaluate-rust-boundary.ts` and
  `packages/relay/src/evaluation/rust-boundary.ts`. This is a repeatable
  TypeScript relay/protocol baseline over the WP-27 relay fixture; it does not
  wire Rust into relay production behavior.
- Local result on 2026-05-22:
  - combined request JSON: `1,368` bytes;
  - combined response JSON: `2,978` bytes;
  - binary sync pack: `2,349` bytes, wire version `14`;
  - JSON parse p95: request `3.96us`, response `6.21us`;
  - TypeScript schema p95: request `13.08us`, response `18.50us`;
  - HTTP-style parse+schema p95: request `12.33us`, response `16.42us`;
  - binary sync-pack decode p95: `11.96us`;
  - binary sync-pack decode+schema p95: `22.58us`;
  - validating schema-backed fixture protocol objects p95: `47.46us`.
- Malformed probe coverage rejects empty client IDs, non-true combined
  responses, invalid blob hashes, and stale binary sync-pack wire versions with
  sanitized path/code/message diagnostics.
- Initial read: protocol validation is measurable but currently cheap on this
  fixture. A production Rust validation boundary only makes sense if it avoids
  extra JSON materialization/copies or proves stronger drift/correctness value
  than the existing TypeScript schemas.
- Second evaluation slice added
  `packages/relay/scripts/evaluate-relay-paths.ts` and
  `packages/relay/src/evaluation/relay-paths.ts`. It measures current
  in-memory relay app paths with Bun SQLite, `server-dialect-sqlite`, the
  relay push/pull wrappers, `ForwardEngine`, `PullEngine`, and `RelayRealtime`.
- Local result on 2026-05-22, 100 measured iterations with 10 warmups:
  - local client push into relay p95: `701.46us`;
  - relay forward to main p95: `108.63us`;
  - relay pull from main and local apply p95: `379.96us`;
  - local client incremental pull from relay p95: `305.67us`;
  - realtime wakeup to 100 open mock connections p95: `33.92us`.
- Initial comparison: schema-backed protocol validation p95 (`47.46us`) is
  smaller than the DB/app-semantics relay paths in this local control. Rust
  protocol validation alone is therefore unlikely to be a relay performance win
  unless it replaces existing work without adding JSON copies or catches drift
  the TypeScript path misses. The app-heavy paths still look TypeScript/Kysely
  owned.
- Existing Rust JavaScript bindings are the full browser/client WASM runtime,
  not a small relay-callable protocol validation package. Using that surface as
  a relay/server boundary probe would measure full runtime startup/package
  shape, not the byte-level protocol validation candidate this WP is evaluating.
  A meaningful future probe would need a deliberately scoped protocol-only
  wasm/native binding.

## Interim Brainstorm

The current evidence does not justify moving relay/server app semantics into
Rust. `relayPushCommit`, `ForwardEngine`, `PullEngine`, `relayPull`, and
Kysely-backed relay storage are doing authorization/handler/DB orchestration,
not just protocol parsing. Moving those into Rust would duplicate server table
handler semantics and raise deployment complexity before there is a measured
target.

Potentially sensible Rust shapes:

- Keep `syncular-protocol` as a cross-language oracle in tests/dev tooling.
  This already catches fixture drift without adding production boundary cost.
- Measure a byte-level Rust validator only for bodies that can stay binary:
  binary sync packs, binary snapshot chunks, artifact refs, blob hashes, and
  realtime binary frames. This needs a no-op/call-boundary control first.
- Consider a Rust edge/proxy only if the product need is byte-preserving
  forwarding, request authentication/rate-limit policy, or binary verification
  before forwarding. It should not become partial table-handler/server logic.

Bad shapes from the current data:

- Wrapping already-parsed TypeScript objects in Rust validation on relay hot
  paths. It would likely pay JSON/object mapping cost around a cheap schema
  check.
- Moving `ForwardEngine`, `PullEngine`, sequence mapping, Kysely storage, or
  server table handlers into Rust without a separate product decision that Rust
  owns server-side mutation/apply semantics.
- Creating more Rust relay/server WPs before a call-boundary measurement or a
  concrete product need exists.

## Candidate Follow-Ups

- Rust protocol validation remains in fixtures/dev tooling only.
- A protocol-only wasm/native binding can be proposed later only if binary
  validation becomes a real product need and the probe can keep bodies as bytes.
- Rust realtime fanout WP only if connection/fanout load tests, not the local
  100-connection control, show pressure.
- Rust edge proxy WP only if deployment/auth/rate-limit/network offload is the
  concrete product need and bodies can stay byte-preserving.
- Rust server trait-model WP only if we explicitly decide Rust should own app
  mutation semantics.

## Final Decision

Keep Rust protocol checks in fixtures/dev tooling only for now. Do not retain a
production Rust validation path in relay/server, do not create new Rust
relay/server component WPs from this evaluation, and do not move relay app
semantics into Rust.

This decision is based on three points:

- The current TypeScript protocol checks are measurable but small on the WP-27
  fixture.
- The measured relay paths are dominated by DB/app semantics rather than
  protocol validation.
- The repo does not currently have a small relay-callable Rust protocol binding;
  the available JS/WASM binding is the full browser client runtime and would be
  the wrong integration surface for this decision.

## Next Action

WP-28 is closed. Reopen relay/server Rust planning only with new evidence from
load tests, a product need for byte-preserving edge verification/proxying, or a
scoped protocol-only binding proposal.
