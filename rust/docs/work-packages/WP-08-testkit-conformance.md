# WP-08 Testkit And Conformance

Status: `[~]` in progress

## Goal

Make the Rust testkit strong enough that apps can test against real Syncular
behavior instead of mocking the client everywhere.

## Scope

- Disposable SQLite clients.
- In-process transports.
- Stateful app test server.
- Protocol response builders.
- Event waiters/assertions.
- CRDT helpers.
- Fault injection.
- Shared conformance runner across TS, Rust, Swift, Kotlin, and JVM.

## Acceptance Criteria

- App projects can replace generic local Syncular helpers with testkit.
- Stateful server can accept arbitrary app schema rows, track commits, serve
  later pulls, and emit realtime wakeups.
- Conformance scenarios cover auth, sync, conflicts, realtime, blobs, E2EE,
  and CRDT where supported.

## Required Gates

- `syncular-testkit` tests.
- Runtime tests using testkit helpers.
- At least one app-style/stateful server convergence test.

## Accept / Reject Rule

- Retain helpers that remove app-side mocking while exercising real Syncular
  behavior.
- Reject testkit APIs that merely script fixed responses when a stateful server
  model is needed for convergence, commits, scopes, or CRDT materialization.

## Current Evidence

The JS `@syncular/testkit` was both internal infrastructure and a public app
testing story. The Rust testkit now has both an in-process `AppTestServer` and
an `AppTestHttpServer` wrapper for production-shaped HTTP/WebSocket app tests.
The stateful server accepts generated app schemas, stores rows, applies pushed
commits, serves later pulls, emits realtime wakeups, and covers CRDT/Yjs merge
behavior in smoke tests.

## Next Action

Move the next app conformance slice onto this fixture: shared scenarios for
auth, conflicts, blobs, E2EE, and CRDT across Rust/native/browser bindings.
Keep the stateful server generic; app-specific fixture rows should stay in app
tests.

## Progress

- Added `AppTestHttpServer`, a disposable HTTP/WebSocket wrapper around
  `AppTestServer`.
- Added smoke coverage proving HTTP push writes server state, WebSocket clients
  receive sync wakeups, and a second client pulls the committed row through the
  production native HTTP transport shape.
- Added smoke coverage proving production `RealtimeTransport::push_commit`
  works against the reusable stateful HTTP server, writes server state, returns
  a websocket push response, and wakes other websocket subscribers.
- Added stateful HTTP/WebSocket request capture so app tests can assert
  production auth and schema-version headers without replacing the real
  transport.
- Added a scoped stateful server smoke proving bootstrap rows, later commits,
  and deletes are all filtered by the generated app schema scopes.
- Added stateful encrypted-field sync coverage proving server-side stored rows
  stay ciphertext while a second client pulls and decrypts plaintext through the
  normal app sync path.
- Added stateful blob coverage proving queued upload into `AppTestServer`,
  queue drain, local cache clear, remote download, and recache through real
  client APIs.
- Moved the Rust loader for
  `examples/todo-app/conformance/sync-scenarios.json` into `syncular-testkit`
  so runtime, SDK, and app tests can share one conformance scenario source.
- Updated native blob transport tests to consume the same `syncular-testkit`
  conformance loader instead of parsing a private fixture copy.
- Added a shared TypeScript conformance loader next to
  `sync-scenarios.json`, then pointed browser fixture tests and native Hono
  smoke server setup at it so native smokes no longer import browser test
  internals.
- Updated browser generated-app conformance tests to use the shared TypeScript
  sync scenario loader for field-encryption scenarios.
- Added a stateful HTTP conflict smoke proving version conflicts are reported
  through the production native HTTP transport shape while the same sync can
  pull the server-winning row.
- Replaced the Rust perf binary's private stateful HTTP/WebSocket server copy
  with the shared testkit fixture to keep performance and app tests aligned.
- Gate: `cargo test --manifest-path rust/Cargo.toml -p syncular-testkit`
  passed with `28` smoke tests.
- Gate: `cargo test --manifest-path rust/Cargo.toml -p syncular-runtime --test
  protocol_contract` passed with `40` protocol tests.
- Gate: `cargo test --manifest-path rust/Cargo.toml -p syncular-runtime --test
  blob_transport` passed with `3` blob tests.
- Gate: `bun -e "import('./rust/bindings/browser/src/__tests__/fixtures/sync-conformance.ts')..."`
  passed and proved the browser fixture resolves the shared TypeScript loader.
- Gate: `bun test ./rust/bindings/browser/src/__tests__/fixtures/sync-conformance.ts`
  passed as a no-test import smoke.
- Gate: `bun test ./rust/bindings/browser/src/generated-app-conformance.test.ts`
  passed with `5` browser generated-app conformance tests.
- Gate: `cargo test --manifest-path rust/Cargo.toml -p syncular-client
  --no-default-features --features cli --bin syncular-rust-perf --no-run`
  passed.
