# WP-09 Native Bindings And Packaging

Status: `[ ]` planned

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

Apple, Android, and JVM local smokes exist. Windows and broader app lifecycle
validation remain external or incomplete.

## Next Action

Pick one real lifecycle gap, preferably macOS app shell or Windows JVM package
validation, and turn it into a repeatable smoke/gate.
