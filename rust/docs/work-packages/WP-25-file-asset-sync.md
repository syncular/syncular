# WP-25 File Asset Sync

Status: `[~]` in progress

## Goal

Make Syncular a strong foundation for Dropbox-like photos and file syncing by
syncing file metadata as server-authoritative rows while using blobs only for
verified byte storage and transfer.

Core principle: files, folders, versions, sharing, conflicts, and cache policy
are app data models; blobs are content-addressed byte objects.

## Scope

- Generated file/folder metadata schema patterns for apps that want file sync:
  files, folders, file versions, shares, local availability, and trash/restore
  state.
- File versioning semantics built on normal Syncular commits and file-version
  rows.
- Folder tree operations: create, rename, move, soft delete, restore, and
  scoped sharing.
- Conflict semantics for rename, move, delete-vs-update, duplicate names,
  concurrent version edits, and folder delete with child updates.
- Client file lifecycle states: local-only, uploading, uploaded, committed,
  downloading, available, online-only, pinned, evicted, conflicted, and failed.
- Cache/download policy helpers: selective sync, pin for offline, online-only
  placeholders, eviction, and priority queues.
- Server helpers that authorize blob download/upload through visible
  file/version rows, building on WP-24 blob authorization.
- Testkit scenarios for multi-client file convergence, sharing revocation,
  conflicts, trash/restore, and missing/corrupted blob bodies.

## Non-Scope

- Putting file/folder semantics directly into generic blob storage.
- Storing file bytes in app rows, snapshot chunks, or sync commits.
- Rewriting history for rollback or conflict repair.
- A built-in Dropbox product UI.
- Editor-specific document APIs.
- Mandatory file schema for apps that only need raw blob references.

## Acceptance Criteria

- Apps can generate or adopt a file asset schema where file metadata syncs
  through normal subscriptions, mutations, conflict handling, and scoped access.
- Blob bytes remain separate content-addressed objects referenced by
  `BlobRef`/file-version rows.
- File version history is inspectable without rewriting commits or exposing
  unauthorized data.
- File conflicts produce explicit Syncular conflicts or app-visible file
  conflict rows instead of silent overwrites.
- Sharing revocation clears synced file metadata and can trigger local cache
  eviction for no-longer-authorized blob bodies.
- The default blob authorization helper from WP-24 can authorize file blobs by
  checking visible file/version rows.
- Client lifecycle events and diagnostics explain why a file is not available,
  not synced, not downloadable, evicted, or conflicted.
- Browser and native clients have aligned semantics, with native allowed to use
  stronger file-streaming paths.

## Required Gates

- Generator tests for file asset schema helpers where generated output changes.
- Runtime/native store tests for file metadata mutation/conflict flows.
- Browser worker/WASM tests for generated file rows, blob refs, availability
  state, and revocation clearing.
- Server authorization tests for file/version-row-backed blob access.
- Testkit multi-client file scenarios for rename, move, delete-vs-update,
  version conflict, sharing revocation, and trash/restore.
- Blob gates from WP-24 when file asset work touches blob transfer,
  authorization, cache, or encryption.
- Console/diagnostic tests when file lifecycle surfaces are added.

## Accept / Reject Rule

- Retain file asset work only if it preserves the boundary between synced file
  metadata and blob byte transfer.
- Reject any design that grants blob access from hash knowledge alone.
- Reject rollback behavior that rewrites server commits, cursors, or verified
  roots.
- Reject hidden file caches or indexes that change local query semantics
  without explicit app intent.
- Reject default whole-partition file sync assumptions; folder/file sharing must
  respect arbitrary scoped subscriptions.

## Current Evidence

Syncular already has several prerequisites:

- Generated app schemas support `blobColumns` and `BlobRef` types.
- Mutations/outbox, conflicts, dynamic subscriptions, scope revocation clearing,
  realtime wakeups, and local SQLite reads are already part of the Rust-first
  model.
- Native and browser blob APIs can stage, upload, retrieve, cache, prune, and
  sync blob references through app rows.
- WP-13, WP-15, WP-18, WP-19, WP-20, and WP-24 define the surrounding
  observability, error, limits, security, repair, and blob-hardening work this
  feature needs.

Current gap: Syncular has blob byte handling, but not a first-class file asset
model for folders, versions, sharing, lifecycle state, selective sync, or
Dropbox-like conflict behavior.

First retained slice:

- Added `syncular-testkit::file_assets`, a reference app-schema fixture with
  scoped `files` and `file_versions` tables.
- `file_versions.blob_ref` is the only blob column; file rows carry metadata
  and current-version identity, not bytes.
- Added mutation builders for create file, create folder, attach file version,
  rename, move, soft delete, restore, and current-version updates.
- Added a two-client stateful testkit scenario where one client stages/uploads
  blob bytes, commits file/version metadata, another client pulls the metadata,
  downloads the blob via the referenced `BlobRef`, and subscription revocation
  clears both file metadata tables.
- Gate: `cargo test --manifest-path rust/Cargo.toml -p syncular-testkit
  file_asset`
- Broader gate: `cargo test --manifest-path rust/Cargo.toml -p
  syncular-testkit`
- Benchmark gate: not applicable for this slice; it adds a testkit/reference
  schema and does not change runtime sync/apply/query hot paths.

Second retained slice:

- Added Hono blob-route coverage proving file-version rows can back blob
  authorization through `file_versions.blob_ref`.
- The route now has a production-shaped test where an uploaded hash is still
  forbidden until a visible file-version row references it, then the owning
  actor can mint a download URL and a different actor remains forbidden.
- Gates:
  - `bun --cwd packages/server-hono tsgo`
  - `bun test packages/server-hono/src/__tests__/blob-routes.test.ts`
- Benchmark gate: not applicable; this is authorization coverage over existing
  route/helper behavior.

Third retained slice:

- Added browser/WASM coverage for a reference `file_versions` app schema with
  `blob_ref` typed through the normal blob-column codec path.
- The test drives the low-level Rust-owned SQLite database API against Hono
  sync routes: writer commits a file-version row with a `BlobRef`, server
  stores the row as JSON text, reader pulls it back as an app-shaped
  `BlobRef`, and subscription revocation clears the local table.
- Gates:
  - `bun --cwd rust/bindings/browser tsgo`
  - `bun test rust/bindings/browser/src/__tests__/variant-core.wasm.test.ts -t
    file-version`
  - `bun test rust/bindings/browser/src/__tests__/variant-core.wasm.test.ts`
- Benchmark gate: not applicable; this adds conformance coverage and does not
  change runtime sync/apply/query code.

## Suggested App Schema

Initial generated/reference schema:

- `files`: stable file or folder identity, parent id, name, kind, current
  version id, size, mime type, owner/sharing scope, deleted/trash state, and
  local availability policy.
- `file_versions`: immutable version rows with blob ref, content hash, size,
  actor id, created time, and optional previous version.
- `file_shares`: explicit share grants or inherited folder sharing metadata.
- `file_conflicts`: app-visible conflict records for cases that cannot be
  merged safely.

This schema is a reference pattern, not a required global Syncular system
schema.

## First Slice

Add a reference file asset schema and conformance scenario:

1. `[x]` Define reference/testkit tables for `files` and `file_versions`.
2. `[x]` Add mutation builders for create file, create folder, attach new
   version, rename, move, soft delete, and restore.
3. `[x]` Use `BlobRef` in `file_versions`, not in file row payload bytes.
4. `[x]` Add a two-client test where one client uploads a file/version,
   another pulls metadata, downloads the blob, then sees revocation clear the
   file metadata. The retained testkit scenario covers this through
   `AppTestServer`, and the Hono route now proves the same row-backed
   file-version authorization shape for download URL access.

## Next Action

Add the production server/browser side of the reference path:

1. `[x]` Add Hono blob authorization coverage using `file_versions.blob_ref` as the
   visible row-backed blob reference.
2. `[x]` Add browser/WASM coverage that generated app rows with a file-version
   `BlobRef` sync and clear on revocation.
3. `[ ]` Expand testkit file scenarios for rename, move, delete-vs-update, version
   conflict, trash/restore, and missing/corrupted blob bodies.
4. `[ ]` Decide whether the reference schema should also become a codegen optional
   template, while keeping it optional app-layer metadata rather than Syncular
   core tables.
