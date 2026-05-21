# WP-29 Rust Edge Proxy

Status: `[!]` blocked pending WP-27 evidence and a concrete product target

## Goal

Build a Rust edge proxy only when the product need is connection, auth, rate
limit, websocket-origin, or network offload in front of the existing JS/Hono
server.

## Why

The smallest useful server-side Rust product is not a full server. It is a
proxy that terminates edge concerns, validates the current protocol through
`syncular-protocol`, forwards combined sync/blob requests to the existing
server, and leaves app table semantics in the current handler/dialect model.

## Scope

- HTTP endpoint for forwarding combined sync requests to the existing server.
- Blob route forwarding where bodies can be preserved safely.
- Websocket upgrade/origin/rate-limit handling for realtime connections.
- Protocol validation through `syncular-protocol`.
- Edge diagnostics for request IDs, validation failures, auth failures,
  websocket lifecycle, and upstream latency.
- Deployment-specific integration only after the runtime target is chosen.

## Non-Scope

- No app mutation application in Rust.
- No Rust table handlers.
- No Rust scope resolution or app authorization beyond edge authentication and
  forwarding policy.
- No sync metadata database ownership.
- No replacement for the JS/Hono server.
- No Cloudflare Worker rewrite unless the chosen runtime target specifically
  requires it and the JS host boundary cost is measured.

## Acceptance Criteria

- Valid sync, blob, and realtime traffic is forwarded to the current server
  without changing protocol bodies unless the proxy is explicitly responsible
  for edge metadata.
- Invalid protocol traffic fails at the proxy with stable, non-leaky errors.
- The proxy never applies app operations or advances sync cursors.
- Auth/rate-limit/origin decisions are explicit and covered by tests.
- Benchmarks show the proxy overhead and websocket fanout behavior for the
  target deployment shape.

## Required Gates

- WP-27 gates.
- Proxy integration tests against a local Hono sync server.
- Realtime websocket tests for connect, reconnect, overflow, and pull-required
  recovery.
- Blob forwarding tests for upload initiation, completion, direct transfer, and
  download metadata.
- Targeted latency/throughput benchmark for the concrete deployment target.

## Accept / Reject Rule

- Retain only if there is a concrete product target and the proxy avoids
  duplicating app table semantics.
- Reject if the implementation starts becoming a partial server rewrite.
- Reject if protocol bodies are transformed without a documented product need
  and fixture coverage.

## Current Evidence

- `rust/docs/reference/SERVER_EDGE_INVESTIGATION.md` recommends an edge proxy as
  the smallest server-side Rust product when connection/auth/network offload is
  needed.
- WP-11 keeps Rust server/proxy work deferred until a concrete product target
  exists.

## Next Action

Do not implement until WP-27 is accepted and the target deployment reason is
recorded. When unblocked, draft the runtime target and forwarding contract
before writing code.
