# WP-14 Developer Experience And Generated APIs

Status: `[~]` in progress

## Goal

Make generated Syncular clients feel excellent for app developers while keeping
the Rust runtime as the source of sync correctness.

## Scope

- Clearer generated mutation APIs for create, update, delete, batch, and
  domain-specific operation helpers.
- Typed subscription builders with stable subscription IDs, table names, scope
  values, and generated validation.
- Generated conflict helpers that expose conflict state without pushing repair
  logic into app code.
- Generated diagnostic/debug hooks that connect app code to WP-13 client
  snapshots and event streams.
- Better public error messages with stable codes and remediation hints from
  WP-15.
- Documentation examples that match real app flows, including bootstrap,
  mutations, subscriptions, conflicts, realtime, and local reads.

## Non-Scope

- Replacing query-builder-first local reads with table-specific ORM methods.
- Exposing raw app-table writes as synced write APIs.
- Preserving old JS/client protocol behavior or generated compatibility
  aliases.

## Acceptance Criteria

- Generated APIs make common app flows obvious without hiding mutation/outbox,
  scope, authorization, or conflict semantics.
- Subscription builders produce stable IDs and explicit scope values.
- Generated mutation helpers route through the current Rust-first mutation path.
- Conflict helpers preserve server authority and local intent.
- Browser, Rust, Swift, Kotlin, and JVM generated surfaces stay semantically
  aligned where supported.
- Docs include at least one end-to-end generated client flow that exercises
  typed reads, mutations, subscriptions, diagnostics, and conflicts.

## Required Gates

- Generator checks and generated example/smoke tests.
- Browser worker/package typechecks when generated TypeScript changes.
- Native binding smokes when Swift/Kotlin/JVM generation changes.
- Runtime tests when helper APIs touch mutation, conflict, or subscription
  behavior.

## Accept / Reject Rule

- Retain generated API changes only if they improve app ergonomics without
  adding synced-write escape hatches or weakening server-authoritative sync.
- Reject APIs that make subscriptions look like arbitrary remote SQL queries.
- Reject convenience aliases that preserve old protocol/client behavior unless
  explicitly recorded in `COMPATIBILITY_REGISTER.md`.

## Current Evidence

The Rust-first runtime already supports generated safe mutations, typed local
read surfaces, subscriptions, conflicts, browser worker clients, and native
bindings. The remaining gap is the app-facing shape: generated APIs should make
the correct sync path easy and make incorrect paths hard to reach.

## Next Action

Use the generated TypeScript mutation shape as the reference for the next native
generated-client pass:

1. Align Swift/Kotlin/JVM generated mutation entry points with the same
   generated-input/public-patch shape where the native runtime already exposes
   the required low-level JSON enqueue/apply calls.
2. Add generated diagnostics helpers that surface WP-13 snapshots/events without
   making apps parse raw JSON strings.
3. Revisit CRDT state-column exposure in generated mutation input types so app
   code cannot accidentally write CRDT persistence columns directly.

## Progress

- TypeScript generated app databases now expose generated mutation types on
  `database.mutations`. Inserts accept `New{Table}` and updates accept
  `{Table}Patch` instead of full app rows, so app code no longer has to provide
  server-owned columns such as `server_version`.
- The generated mutation type is a type-level wrapper over the existing
  Rust-first mutation/outbox path; it does not add raw table-write escape
  hatches or change runtime semantics.
- Added browser generated-conformance coverage proving the typed generated
  mutation surface produces the same clean outbox/local-row payloads.
