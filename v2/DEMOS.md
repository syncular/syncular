# Demo apps — one todo list, six platforms, one interface

Every demo is the same very simple todo list, proving two things per
platform: **syncular compiles/works there**, and **the integration is a
handful of clean lines — no hacks**. All demos speak to a stock server
(`apps/demo`/`apps/demo-react` serve the `todos` schema on :8787/:8788;
`examples/quickstart` serves the `notes` schema).

| Platform | Where | Client core | Interface | Proven locally (this repo, CLT-only mac) | Proven in CI | Needs human hands |
|---|---|---|---|---|---|---|
| **React web** | `apps/demo-react` | TS core, worker + OPFS | `SyncProvider` + hooks | boots, serves, browser-verified (typed reads, window filter, outbox drain) | main gate + budgets | — |
| **Tauri + React** | `bindings/tauri/example` | Rust core in-process (plugin) | same hooks over `createTauriSyncClient` — one Tauri-specific line | cargo build + frontend bundle + tsc | tauri-bindings job | `cargo tauri dev` (opens the window) |
| **React Native** | `bindings/react-native/example` | Rust core via FFI TurboModule | same hooks over `createNativeSyncClient` | tsc + the real `App.tsx` rendered against the module double | check.sh in CI | device build (`react-native init` overlay + Xcode/AGP; recipe in README) |
| **Swift (macOS)** | `bindings/swift/example` | Rust core via FFI | `SyncularClient` — `TodoStore` is ~30 lines | **SwiftUI window opens under CLT**; terminal variant synced a todo to a real server, read back by an independent TS client | swift stays a local gate (macOS runner cost) | — (SwiftUI runs here) |
| **Kotlin (JVM)** | `bindings/kotlin/example` | Rust core via FFI (FFM) | `SyncularClient` — same `TodoStore` shape | detect-and-skip (no JDK here) | gradle test + scripted example smoke against a live server | Android AAR path (cargo-ndk; recipe) |
| **Flutter** | `bindings/flutter/example` | Rust core via `dart:ffi` | `SyncularClient` (Dart) — same surface | detect-and-skip (no Flutter SDK here) | dart analyze + `dart test` against the real built `.so` | `flutter create` platform overlay + `flutter run` (recipe) |

The "one interface" claim, concretely: React web, Tauri, and RN run the
*identical* hook code — only the provider's client constructor differs
(direct/worker vs `createTauriSyncClient` vs `createNativeSyncClient`,
three hosts of one `SyncClientLike`). Swift, Kotlin, and Dart mirror one
wrapper surface (`command` + the same typed conveniences + an event
stream) over the same conformance-locked JSON command router the stdio
shim locks.

Run recipes live in each demo's README. The bindings doctrine (what a
wrapper must prove) is `bindings/README.md`.
