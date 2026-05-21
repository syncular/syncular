# WP-24 Blob Hardening And Production Polish

Status: `[ ]` planned

## Goal

Move Rust-first blob handling from usable MVP to production-grade by tightening
authorization, encryption, browser large-payload behavior, diagnostics, limits,
and cross-binding conformance.

## Scope

- Scope-aware blob access helpers so server apps can authorize blob hashes
  against row references, partitions, subscriptions, and actor scope without
  hand-rolling broad `canAccessBlob` logic.
- First-class encrypted blob body support with generated metadata, key IDs,
  upload/download encryption hooks, and safe diagnostics.
- Browser large-payload strategy for upload/download that avoids unnecessary
  full-body memory copies where platform APIs permit it.
- Queue and cache hardening: explicit limits, retention policy, retry policy,
  failed-entry cleanup, and app-facing status.
- Blob observability: diagnostic events, queue/cache stats, upload/download
  timing, retry reasons, and console surfaces.
- Cross-binding conformance for TypeScript/browser, Rust native, Swift, Kotlin,
  JVM, and app testkit scenarios.
- Server route hardening for signed URLs, max sizes, hash/size validation,
  storage adapters, and authorization failure behavior.

## Non-Scope

- Storing blob bytes inside snapshot chunks or app row payloads.
- Rewriting existing blob refs or server commits during repair.
- Treating blob access as globally authorized just because a hash is known.
- Preserving old JS/client blob behavior as a fallback path.
- Editor-specific file attachment APIs in core.

## Acceptance Criteria

- Server apps can use a default helper to authorize blob access from current
  scoped row references, with an explicit escape hatch for custom policies.
- Blob-body encryption has a clear runtime contract: encrypted bytes are stored
  and transported as blobs, plaintext never appears in server diagnostics, and
  missing keys fail clearly before cache mutation.
- Browser and native clients expose aligned blob queue/cache status and stable
  diagnostic codes for upload, download, retry, failure, cache hit/miss,
  pruning, and authorization rejection.
- Upload and download paths validate hash and size before marking uploads
  complete or caching downloaded bytes.
- Queue/cache limits are configurable and enforced with WP-15 error codes and
  WP-13 diagnostics.
- Missing, unauthorized, corrupted, interrupted, oversized, and stale-auth blob
  cases are covered in shared conformance scenarios.
- Generated blob columns continue to sync only `BlobRef` metadata; blob body
  transfer remains a separate content-addressed path.

## Required Gates

- Native runtime blob transport tests:
  `cargo test --manifest-path rust/Cargo.toml -p syncular-runtime --test blob_transport --features native,crdt-yjs,demo-todo-native-fixture`
- Runtime/native store tests when queue/cache/encryption behavior changes:
  `cargo test --manifest-path rust/Cargo.toml -p syncular-runtime --test store_backends --features native,crdt-yjs,demo-todo-native-fixture`
- Browser blob/Hono tests:
  `bun test rust/bindings/browser/src/__tests__/blob-hono.wasm.test.ts`
- Browser sync tests when generated `BlobRef` row sync changes:
  `bun test rust/bindings/browser/src/__tests__/sync-hono.wasm.test.ts`
- Server blob route tests:
  `bun test packages/server-hono/src/__tests__/blob-routes.test.ts`
- Generator checks when blob column metadata or generated APIs change.
- Testkit/conformance tests for shared blob failure scenarios.
- Browser E2E or targeted perf benchmarks when browser blob memory/copy
  behavior changes.

## Accept / Reject Rule

- Retain blob changes only if they preserve content-addressed integrity,
  scoped/server-authoritative access, and explicit retry/failure semantics.
- Reject blob access helpers that grant access based only on hash knowledge.
- Reject encryption paths that store plaintext in server-visible blob bodies,
  diagnostics, request events, or debug bundles.
- Reject browser optimizations that skip hash/size validation before cache or
  upload completion.
- Reject fallback behavior for old blob protocols unless explicitly recorded in
  `COMPATIBILITY_REGISTER.md`.

## Current Evidence

Existing strengths:

- Generated app schemas support `blobColumns` and generated `BlobRef` types.
- Native Rust supports byte and file blobs, queued and immediate upload,
  retrieval, cache stats, pruning, clear-cache, FFI/BoltFFI exposure, and
  streaming file upload/download without local cache.
- Browser Rust/WASM supports store, retrieve, upload queue processing, queue
  stats, local cache, preload, prune, clear, and React hooks.
- Server Hono blob routes support upload init, complete, download URL, direct
  upload/download for database adapters, signed tokens, max upload size,
  hash/size validation, and streaming upload when the storage adapter supports
  it.
- Tests cover upload/download, dedupe, auth failure retry, interrupted upload
  retry, missing remote blobs, cache pruning, generated `BlobRef` sync, native
  streaming file paths, and Swift/Kotlin/JVM native smokes.

Known gaps:

- Blob authorization is currently app-supplied through `canAccessBlob`; the
  core server does not yet provide a default scope-aware row-reference helper.
- Runtime blob body encryption is not first-class; current Rust-created blob
  refs use `encrypted=false`.
- Browser blob bodies are still stored and uploaded through SQLite/memory
  buffers, so very large browser blobs need better limits and platform-aware
  transfer strategy.
- Queue/cache limits, diagnostics, and console visibility are thinner than
  production support needs.
- Shared conformance is good but not complete for every auth, scope,
  encryption, corruption, browser/native, and server-adapter edge case.

## Interface Impact

Canonical semantics:

- Blob bodies transfer through the content-addressed blob path. Generated app
  rows carry only `BlobRef` metadata.
- Hash and size validation are mandatory before upload completion or cache
  mutation.
- Blob authorization remains scoped/server-authoritative; knowing a hash does
  not grant access.

TypeScript/browser:

- `blobs.store(...)`, `blobs.retrieve(...)`, upload queue processing,
  cache stats, preload, prune, clear, and stable blob error codes are the
  canonical host surfaces.
- Browser wrappers must preserve queue/cache status, integrity failures, auth
  failures, and large-payload limits instead of silently retrying or copying
  without bounds.

React:

- Blob queue/cache hooks should be event-driven from runtime lifecycle/blob
  events, not independent polling loops.

Tauri/React Native/Expo:

- Bridge packages must preserve validation, max-size errors, queue/cache
  status, retry state, and auth diagnostics.
- Large blob transfer over JavaScript bridges needs explicit limits or a
  platform-native file/stream path; no unbounded base64 bridge path should be
  introduced as default behavior.

Testkit/docs:

- Conformance should cover scoped auth allow/deny, missing blobs, corrupted
  bytes, interrupted upload retry, encrypted blob roundtrip, cache pruning, and
  browser/native parity.

## First Slice

Add scope-aware blob authorization helpers and diagnostics:

1. Define a server helper that checks whether a blob hash is referenced by at
   least one row the actor is authorized to receive for a handler/subscription
   scope.
2. Wire Hono blob routes to accept that helper without removing custom
   `canAccessBlob`.
3. Emit stable diagnostics for blob auth allowed, denied, missing reference,
   and missing blob.
4. Add tests for authorized row reference, unauthorized scope, and hash-known
   but unreferenced blob access.

## Next Action

Design the default server-side `canAccessBlob` helper around table handlers and
scoped row references. Keep it explicit and opt-in so apps with custom storage
or sharing policies can still provide their own authorization function.
