# WP-16 Schema Evolution And Migration Safety

Status: `[~]` started

## Goal

Make local/client schema changes safe across app releases, generated clients,
server handlers, and rolling deployments.

## Scope

- Schema compatibility checks between generated clients, local SQLite, server
  handlers, snapshot/artifact manifests, and protocol capabilities.
- Local migration lifecycle for browser and native stores.
- Server/client schema-version mismatch handling with clear errors and
  diagnostics.
- Generated migration metadata and version assertions.
- Diagnostics for blocked sync due to schema drift.
- Testkit scenarios for rolling deploys and mixed client versions.

## Non-Scope

- Forcing server and client schemas to be identical.
- Keeping compatibility branches for old protocol behavior by default.
- Allowing incomplete migrations to query or mutate synced tables as if they
  were current.

## Acceptance Criteria

- Clients fail clearly when local schema, generated schema metadata, or server
  snapshot/apply shape is incompatible.
- Snapshot artifacts are schema-bound and never applied against incompatible
  local schema versions.
- Rolling deploy tests cover old client/new server and new client/old server
  behavior under the current protocol contract.
- Migration failures are visible through WP-13 diagnostics and WP-15 error
  codes.
- Browser and native stores expose enough schema state for generated clients and
  console surfaces to explain blocked sync.

## Required Gates

- Protocol and wire-format gates when schema metadata enters protocol payloads.
- Runtime/native store tests for local migration behavior.
- Browser/WASM tests for worker-owned SQLite migration behavior.
- Server pull/artifact tests for schema-bound snapshot behavior.
- Generator checks for generated migration metadata.

## Accept / Reject Rule

- Retain only schema-evolution behavior that preserves independent
  client/server schemas and fail-closed sync.
- Reject shortcuts that apply snapshots, artifacts, commits, or local mutations
  against an unknown schema shape.
- Reject compatibility aliases unless explicitly recorded in
  `COMPATIBILITY_REGISTER.md`.

## Current Evidence

The product contract already requires independent client/server schemas, scoped
artifacts are schema-bound, and browser/native stores track runtime schema
state. This WP turns those pieces into a complete app-release safety story.

## Next Action

Extend the rolling-deploy coverage from the Rust/testkit HTTP path into the
browser worker or native event-stream path, proving the same
`sync.schema_mismatch` classification is visible through app-facing events.

## Progress

- `syncular-testkit` stateful `AppTestServer` / `AppTestHttpServer` can now
  simulate server `requiredSchemaVersion` and `latestSchemaVersion` values
  through constructor options or runtime setters.
- Added a rolling-deploy smoke where a client first bootstraps a stable row,
  the server then requires a future schema version and exposes another row, and
  the next sync fails closed with `sync.schema_mismatch` while local synced rows
  remain unchanged.

## Latest Evidence

- `cargo test --manifest-path rust/Cargo.toml -p syncular-testkit app_test_http_server_schema_mismatch_fails_closed --test testkit_smoke`
- `cargo test --manifest-path rust/Cargo.toml -p syncular-testkit`
- `cargo test --manifest-path rust/Cargo.toml -p syncular-runtime server_required_schema_version_newer_than_client_is_rejected --test protocol_contract --features native,crdt-yjs,demo-todo-native-fixture`
- `bun run rust:conformance:fast`
- `cargo fmt --manifest-path rust/Cargo.toml --all -- --check`
