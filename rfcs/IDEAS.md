# RFC Ideas Backlog

Status: Draft ideas  
Updated: 2026-02-16

## 1) Incremental External-Change Ingestion (CDC/Outbox Bridge)

- Replace table-wide re-bootstrap behavior from `notifyExternalDataChange` with row-level incremental commits for external writers.
- Define ordering, idempotency keys, and replay safety for REST/webhook/cron/pipeline updates.
- Goal: external writes should preserve incremental pull performance and history semantics.

## 2) Protocol Versioning + Capability Negotiation

- Introduce explicit protocol version and feature capability handshake for client/server compatibility.
- Define optional feature gating (for example: snapshot streaming, WS push-response, replay mode, future pull variants).
- Goal: unblock protocol evolution without brittle runtime mismatches.

## 3) Distributed Control Plane Primitives (Official Adapters)

- Specify production-grade adapters for realtime fanout and rate limiting (for example Redis/NATS).
- Define delivery semantics, dedupe strategy, partition awareness, and failure behavior.
- Goal: remove “single-instance by default” operational gaps for multi-instance deployments.

## 4) Backup/Restore + Retention Guarantees

- Define supported backup/restore paths across sync tables, blobs, and snapshot chunk metadata.
- Specify compatibility with prune/compaction and what guarantees are preserved after restore.
- Goal: make DR and audit retention explicit and testable.

## 5) Partitioning and Tenant Sharding Model

- Formalize partition lifecycle: creation, routing, migration/rebalancing, and observability.
- Define invariants around partition isolation, cursor behavior, and cross-partition operations.
- Goal: provide a clear horizontal scale model beyond the default partition.

## 6) Relay Conflict Lifecycle + Operator Workflows

- Define conflict classes and lifecycle for `relay_forward_conflicts` (retry, dead-letter, manual resolution, escalation).
- Add operator/console workflow contracts and API surface for resolving relay-forward failures.
- Goal: make relay behavior operationally complete under sustained conflict scenarios.

## 7) Realtime Auth Contract (Upgrade vs First-Message Token)

- Standardize auth flows for WebSocket realtime across runtimes (cookies/query/first-message token).
- Define token rotation, replay protection, and failure-mode behavior.
- Goal: eliminate current ambiguity between transport capabilities and server auth handling.
