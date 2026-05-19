# WP-08 Testkit And Conformance

Status: `[ ]` planned

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
testing story. The Rust testkit covers useful primitives, but app projects
still need a stronger stateful app-server layer for multi-client convergence.

## Next Action

Implement or extend one stateful app-server fixture that accepts arbitrary app
schema rows, records commits, serves later pulls from state, and emits realtime
wakeups.
