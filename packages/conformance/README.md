# @syncular/conformance

Implementation-agnostic conformance runner for the SSP2 protocol
([`SPEC.md`](../../SPEC.md) is normative; REVISE.md B4 is the mandate).
A catalog of scenario scripts executes against any (client, server)
pairing through a driver interface; `bun run check` at the workspace root
runs the whole catalog on (TS web client × TS server) plus the
golden-vector stage on the reference codec.

This document is also the **test doctrine** for this repo. It is law,
not aspiration.

## The doctrine

1. **Loopback by default.** Scenarios drive the server exclusively
   through its byte-level entry points (`handleSyncRequest`, the segment
   download handler, the realtime hub) over an in-memory loopback. No
   HTTP, no sockets, no ports. The loopback is owned by the harness —
   neither implementation can tell it from a network, so everything a
   scenario proves holds for real transports. Real-socket tests are few,
   live elsewhere (adapter packages), and are quarantined from the gate.

2. **Fault injection at the transport seam.** The harness sits between
   the client driver and the server driver; faults are armed on that seam
   and nowhere else: drop request, drop response (ack loss → cached
   replay), duplicate delivery, stale retransmit (permitted reordering),
   and byte truncation of responses or segment downloads (decode-error
   surfacing). Faults are deterministic — the only randomness is the
   truncation offset, drawn from a PRNG seeded by the scenario name.
   Implementations are never instrumented to "know" a fault happened;
   the single exception is the *optional* `idempotency-fault` server
   capability (§6.3 requires a storage-level failure no transport can
   simulate). Drivers without it skip those scenarios.

3. **Readiness waits, never sleeps.** Every wait is an explicit
   completion promise: a sync round resolving, a delivered delta, a
   wake-up, or the client's ack after applying a delta — all observed at
   the transport seam (`RealtimeObservations.waitForAck/waitForWakes/
   waitForDeltas`). There is **zero** `setTimeout`/`setInterval`/sleep in
   this package, and a doctrine test in `test/conformance.test.ts`
   grep-enforces that (the test file itself is the only file allowed to
   mention the words, inside the enforcement regex). The server clock is
   virtual (`advanceClock`) so TTL and retention scenarios need no timers
   either.

4. **Scenarios are never weakened.** If a scenario fails against a
   pairing, either the scenario misreads the SPEC (fix the scenario,
   citing the section) or the implementation diverges (mark the scenario
   `knownDiscrepancy: '<spec ref>'` and file the bug). The runner then
   *expects* the failure (`expected-fail`) and flags `unexpected-pass`
   when the fix lands, so stale markers rot loudly.

## Layout

```
src/
  driver.ts        ServerDriver / ClientDriver / CodecDriver interfaces
  fixture.ts       shared scenario schema (tasks + docs) and row builders
  faults.ts        TransportFaults + seeded PRNG (the seam controller)
  scenario.ts      Scenario type, ScenarioContext, seam observability
  runner.ts        runScenario / runCatalog / formatReport
  raw.ts           reference-codec request builders (raw-bytes surface)
  checks.ts        framework-free assertions
  drivers/
    ts-server.ts      reference ServerDriver (@syncular/server)
    ts-client.ts      reference ClientDriver (@syncular/client, bun:sqlite)
    reference-codec.ts reference CodecDriver (@syncular/core)
  catalog/         the scenario catalog, one file per area
test/
  conformance.test.ts  bun-test wiring: one test per scenario
```

## Driver interfaces (the portability contract)

Everything crossing a driver boundary is a **primitive, a JSON-able
value, or raw bytes** — no rich objects, no callbacks except the
bytes/strings-only transport endpoints. That is deliberate: a future
Rust core implements these interfaces behind a subprocess (or FFI) shim
by serializing exactly these shapes over its pipe.

- **`ServerDriver.create(options)` → `ServerInstance`** — schema IR +
  partition + virtual clock start + limits. The instance exposes:
  `handleSyncRequest(actorId, bytes) → bytes | error-json` (§1.1),
  `downloadSegment(actorId, segmentId, scopesHeaderJson)` (§5.5),
  `connectRealtime(actorId, clientId, sink)` (§8.1), host control
  (`setAllowedScopes`, `setResolverFailing`, `advanceClock`, `prune`),
  and an introspection surface for assertions (`getMaxCommitSeq`,
  `getHorizonSeq`, `readRows`).
- **`ClientDriver.create(options)` → `ClientInstance`** — clientId +
  schema IR + `ClientEndpoints` (the transport seam handed *to* the
  client: `sync(bytes)→bytes`, `downloadSegment(…)→bytes`,
  `connectRealtime(sink)→connection`). The instance exposes `subscribe`,
  `mutate`, `sync`/`syncUntilIdle` (returning JSON-able reports, never
  throwing), `readRows`, `conflicts`, `rejections`, `pendingCommitIds`,
  `subscriptionState`, `schemaFloor`, and realtime connect/disconnect.
- **`CodecDriver`** — `messageRoundtrip(bytes)` / `segmentRoundtrip(bytes)`
  (decode → §11 rendering + byte-exact re-encode, or a named error code)
  and `realtimeKnown(text)`. This is the golden-vector stage: every codec
  implementation must pass `spec/vectors/` byte-for-byte.

### Plugging in a new implementation

Implement the interface(s) for your runtime and pair them:

```ts
import { CATALOG, runCatalog, tsServerDriver, referenceCodecDriver } from '@syncular/conformance';

const report = await runCatalog(CATALOG, {
  client: myRustClientDriver,   // e.g. subprocess shim around the Rust core
  server: tsServerDriver,       // any pairing works: mix and match
  codec: myRustCodecDriver,
});
```

**What the Rust-core driver will look like** (post-gate, when Rust
re-enters as the native runtime): a small host binary linking the Rust
client core, speaking length-prefixed JSON+bytes messages over
stdin/stdout. Each `ClientInstance` method maps to one message; the
`ClientEndpoints` inversion (the client calling *out* to the harness for
transport) becomes a request message from the shim that the TS harness
answers — which is exactly how the driver interfaces are shaped: bytes
in, bytes out, JSON everywhere else, no shared memory, no TS types. The
conformance suite then runs (Rust client × TS server), (TS client × Rust
server), and (Rust × Rust) in CI — conformance-in-CI for every runtime
is the merge precondition (REVISE).

## The catalog

~35 scenarios covering the original testkit gate intent within skeleton scope
(convergence, offline replay + idempotency, both conflict shapes, scope
grant/revoke/purge, bootstrap fresh/resumed/interrupted + segments,
cursor expiry/horizon, schema floor, realtime delta/wake-up/catch-up,
error catalog, golden vectors). Every scenario carries its SPEC refs;
run `bun test` in this package (or `bun run check` at the root) to see
them. Fine-grained permutations belong in package-local tests
(`packages/server/test`, `packages/web-client/test`), not here — the
catalog buys breadth across implementations, not depth within one.

Scenario authoring rules:

- Scripts touch **only** the driver interfaces, the raw reference-codec
  surface (`raw.ts`), and the fault controller. Importing an
  implementation package inside `catalog/` is a review-blocking bug.
- The raw surface deliberately uses the reference codec no matter which
  pairing runs: servers must interoperate with spec-pinned bytes.
- Every scenario states its `specRefs`; assertions cite the section they
  pin in their failure messages.
