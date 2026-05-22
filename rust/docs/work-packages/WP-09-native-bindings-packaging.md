# WP-09 Native Bindings And Packaging

Status: `[x]` accepted for the current native packaging foundation

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
JVM, Linux x86_64 JVM, and Windows JVM package shapes. No local macOS work
remains for the current acceptance criteria, and the Windows JVM packaging lane
has now passed on a real GitHub `windows-latest` runner.

## Next Action

WP-09 is accepted for the current native packaging foundation. Future native
packaging work should be driven by concrete release/app-shell needs, such as
full app lifecycle validation on physical devices, signed release publication,
or additional host/architecture targets.

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
- Gate: `bun run rust:native:package:java:linux` passed locally after WP-13 was
  accepted, proving the current packaging script still emits the Linux x86_64
  JVM native library from this macOS workspace.
- Windows workflow run `26260376180` proved the Rust runtime library and JNI
  DLL compile on `windows-latest`, but failed during post-pack verification
  because the BoltFFI overlay used MSYS-style output paths from Git Bash. The
  packaging script now writes Windows-native overlay paths through `cygpath`
  while keeping shell verification paths unchanged.
- Gate: `bun run rust:native:package:java:linux` passed again after the overlay
  path normalization change.
- Gate: GitHub workflow run `26260787975`, job
  `rust-windows-jvm-package`, passed on `windows-latest`. It ran
  `bash rust/scripts/package-native-bindings.sh --java-windows-x86_64`,
  verified `.context/native-packages/java/native/windows-x86_64/syncular_runtime_jni.dll`,
  and uploaded artifact `syncular-jvm-windows-26260787975` (`2,617,849`
  bytes, artifact id `7150140731`, SHA-256 zip digest
  `e1e658cf39779b8c52d138f18012a4ea95d8d9ed60a1277f8b590c920ef36b22`).
