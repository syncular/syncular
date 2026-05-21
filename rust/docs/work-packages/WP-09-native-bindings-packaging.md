# WP-09 Native Bindings And Packaging

Status: `[!]` blocked on Windows runner evidence

## Goal

Make generated native bindings and packaging reliable enough for real Swift,
Kotlin, JVM, iOS, macOS, Android, Linux, and Windows app integration.

## Scope

- Swift/Kotlin/JVM generated query DSL polish.
- Event stream APIs.
- App lifecycle validation.
- Native library packaging.
- Windows/Linux validation.
- Release instructions.

## Acceptance Criteria

- Real app-shell lifecycle tests cover open, background/foreground, queued
  writes, sync, live queries, and shutdown.
- Windows packaging is validated on a real Windows host/runner.
- Generated APIs are documented and do not expose raw synced table writes.

## Required Gates

- Native runtime tests.
- Swift/Kotlin/JVM smoke tests where touched.
- Packaging commands from the native packaging reference doc.

## Accept / Reject Rule

- Retain generated binding changes only when they preserve the schema-agnostic
  low-level boundary and keep app-specific APIs generated outside the runtime.
- Reject packaging changes that pass only on the local host while making target
  platform layout less explicit.

## Current Evidence

Swift, Kotlin/JVM, iOS, and Android app lifecycle smoke fixtures exist. The
command-line native smoke validates generated Swift/Kotlin clients, the real
BoltFFI host wrappers, native event streams, queued writes, live queries,
server sync, auth refresh, conflicts, blobs, E2EE, revocation, and schema
negotiation. The iOS and Android app-shell smokes model real lifecycle policy
around foreground recovery, background budgets, queued blob work, compaction,
live-query refresh, CRDT writes, and shutdown.

Native packaging scripts produce Apple, Android AAR/local Maven, current-host
JVM, Linux x86_64 JVM, and host-only Windows JVM package shapes. No local macOS
work remains for the current acceptance criteria; Windows validation remains a
real Windows runner/host lane and cannot be completed from this workspace.

## Next Action

Run `bun run rust:native:package:java:windows` on a Windows host/runner and
record the DLL output evidence. Until then, treat WP-09 as externally blocked,
not locally in progress.

## Progress

- Added root scripts for the real native app-shell lifecycle smokes:
  `bun run rust:native:lifecycle:ios`,
  `bun run rust:native:lifecycle:android`, and
  `bun run rust:native:lifecycle`.
- Added `run-conformance-gates.sh --native-app-shell` so the real iOS/Android
  lifecycle smokes can be invoked through the same Rust-first conformance
  runner without making the default native lane require simulator/emulator
  infrastructure.
- Gate: `bun run rust:native:lifecycle:ios` passed on the iOS simulator. It
  built the `aarch64-apple-ios-sim` Rust runtime, generated the Xcode project,
  and ran `SyncularLifecycleAppTests` with `1` XCTest passing.
- Gate: `bun run rust:conformance:native` passed. It covered Swift generated
  client, Swift BoltFFI host, Swift lifecycle CLI, Kotlin generated client,
  JVM native packaging, Kotlin BoltFFI host, Kotlin lifecycle CLI, local Hono
  server sync, Swift native server sync, and Kotlin native server sync.
- Gate: `bun run rust:native:lifecycle:android` passed on the Android emulator.
  It built the `aarch64-linux-android` Rust runtime, linked
  `libsyncular_runtime.so`, and ran `1` connected instrumentation test with a
  successful Gradle build.
- Blocker: Windows JVM packaging still needs a real Windows host/runner to run
  `bun run rust:native:package:java:windows` and prove
  `.context/native-packages/java/native/windows-x86_64/syncular_runtime_jni.dll`.
