# Security And Privacy Threat Model

This document records the Rust-first Syncular security and privacy model. It is
not a compliance claim; it is the engineering contract future work must test
against.

## Protected Assets

- App rows, synced deletes, tombstones, derived local read models, and local
  SQLite replicas.
- Effective scopes, subscription state, cursors, verified roots, conflict rows,
  outbox commits, blob metadata, CRDT update/checkpoint rows, and artifact
  manifests.
- Auth headers, API keys, websocket auth tokens, direct-upload/download tokens,
  encryption keys, encrypted field payloads, encrypted blobs, and encrypted
  CRDT ciphertext.
- Diagnostics, console request payload snapshots, native event payloads,
  debug/export bundles, benchmark traces, and generated fixture data.

## Trust Boundaries

- App host to Syncular client: app code is trusted to call public APIs but must
  not be able to bypass synced mutation/outbox semantics through generated
  clients.
- Syncular client to server: the server is authoritative for scopes, commits,
  row eligibility, conflicts, blobs, CRDT update delivery, and revocation.
- Server to storage: SQL/object storage is trusted for durability, not for
  authorization; handlers and routes enforce scope checks.
- Realtime websocket to HTTP recovery: websocket deltas are a fast path only.
  HTTP pull remains the recovery path after reconnect, overflow, auth expiry,
  root mismatch, or cursor loss.
- Console/debug surfaces to operators: operators can inspect authorized server
  state, but diagnostics must avoid leaking app secrets, encrypted plaintext,
  auth tokens, or unauthorized scoped data.

## Core Security Invariants

1. Scoped access is the data model. A client may receive, persist, query as
   synced data, verify, and live-update only rows and fields authorized by its
   current effective scopes.
2. Scope revocation clears local synced rows, derived state, and live-view
   assumptions for the revoked subscription.
3. Local writes are durable intent, not authority. A write becomes server truth
   only after push acceptance.
4. Artifacts, chunks, realtime deltas, and binary packs must carry the same
   authorization and verification semantics as ordinary pull responses.
5. Verification must match the authorized stream. Clients verify delivered
   subscription roots/manifests/chunks; they do not need hidden rows to verify
   their scoped stream.
6. Encrypted fields, blobs, and CRDT payloads must never become plaintext in
   diagnostics, request events, debug bundles, console summaries, or generated
   test artifacts by default.
7. Observability must fail closed. If an event stream, websocket, artifact
   download, digest, or verified root overflows or mismatches, the recovery path
   is resync/refresh, not best-effort apply.

## Threats And Controls

| Surface | Threat | Required Control |
| --- | --- | --- |
| Push | Actor writes rows outside allowed scopes | Handler push validation returns `sync.forbidden` or stable conflict/error; no commit side effects for rejected operations |
| Pull | Actor asks for unauthorized scopes | Server intersects requested and allowed scopes; unauthorized subscriptions are revoked or omitted |
| Realtime | Actor receives deltas for scopes it no longer owns | Connection scope membership is updated from pull state; overflow/reconnect/root mismatch forces pull recovery |
| Artifacts/chunks | Actor downloads cached bootstrap data for another scope | Download routes require authenticated partition/scope headers and validate scope-bound cache keys/manifests |
| Local replica | Revoked data remains queryable | Revocation clears scoped rows and generated/local derived state before cursor advancement is trusted |
| Outbox/conflicts | Offline writes hide later revocation | Push acceptance remains server-authoritative; conflicts and forbidden results stay explicit |
| Blobs | Actor uploads/downloads blobs outside scope or leaks blob tokens | Blob routes authenticate, validate hashes/sizes, use short-lived signed URLs/tokens, and isolate partition/actor access |
| CRDT fields | Partial or wrong-base update corrupts document | Required-base errors force resync/checkpoint recovery; encrypted CRDT update logs remain ciphertext outside materialization |
| Diagnostics | Logs expose plaintext, tokens, payloads, or unauthorized rows | Native diagnostics redact oversized/event payloads; console payload snapshots are opt-in and size bounded |
| Console | Operator crosses partition boundaries by id lookup | Console list/detail/mutation endpoints enforce auth and partition filters consistently |
| Generated clients | Host bypasses mutation/outbox safety | Generated synced write APIs expose mutations, not raw app-table insert/update/delete |
| Verification | Client accepts forged or mixed streams | Snapshot chunks/artifacts/deltas verify digest/root/manifest before apply and before cursor advancement |

## Non-Goals

- Client-visible global non-equivocation over rows a client is not authorized to
  receive. Stronger transparency would need signed roots, witnesses, gossip, or
  Merkle proofs designed for scoped access.
- Protecting data from a fully compromised app process that legitimately holds
  plaintext after decryption/materialization.
- Making console/debug export a universal data recovery interface. Debug tools
  should inspect state without mutating sync history and should redact by
  default.

## Required Test Shape

Security work should prefer cross-surface tests over isolated happy paths:

- one actor authorized for `scope A`, another for `scope B`;
- one row/blob/CRDT stream/artifact in each scope;
- prove unauthorized pull, realtime delivery, artifact/chunk download, console
  lookup, and debug payload access fail closed;
- prove authorized recovery still works after revocation and reauthorization;
- assert no cursor advancement or local mutation happens after a rejected
  artifact, chunk, root, digest, or scope check.

## Review Checklist

Before accepting a security/privacy-sensitive change:

- Does it preserve scoped access for push, pull, realtime, artifacts, blobs,
  CRDTs, and console surfaces?
- Does it avoid storing or emitting auth tokens, plaintext encrypted data, or
  unauthorized rows in diagnostics?
- Does it fail closed with a stable error and recovery action?
- Does it avoid adding compatibility/fallback behavior that could bypass a
  current authorization or verification path?
- Does it have a test that proves the failure mode, not just the success path?
