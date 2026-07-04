# syncular · bindings

Host-integration packages over the syncular v2 core. Each binding is its **own
isolated build** — a separate cargo/SwiftPM/Gradle/npm project with its own
`check.sh` — and **none joins the main workspaces' gates** (`bun run check`, the
main cargo gate, `bench:ci`). This keeps heavy platform toolchains (Tauri's
webkit tree, Swift, the JVM, RN codegen) out of the core's fast, hermetic gate.

| Binding | What it is | Consumes the core via | Gate (`check.sh`) |
|---|---|---|---|
| [`tauri`](tauri) | Native syncular in the Tauri host + JS `SyncClientLike` bridge | the client crate DIRECTLY (no FFI) | cargo fmt/clippy/test + example build |
| [`swift`](swift) | `SyncularClient` SwiftPM package | the C-ABI FFI (dylib / xcframework) | `swift test` (offline hermetic) |
| [`kotlin`](kotlin) | `SyncularClient` Kotlin/JVM library | the C-ABI FFI via **FFM** (JDK 21+) | `gradle test` (offline hermetic) |
| [`flutter`](flutter) | `SyncularClient` Dart package + Flutter todo example | the C-ABI FFI via `dart:ffi` | `dart analyze` + `dart test` (offline hermetic) |
| [`react-native`](react-native) | `@syncular-v2/react-native` module | the C-ABI FFI via a TurboModule | `bun test` (bridge double) + `tsc` |

The Swift/Kotlin/Flutter/RN wrappers all speak the **one JSON command surface** the
`syncular-command` crate defines (`{method, params}` in, `{result|error}` out,
bytes as `{"$bytes":hex}`) — the exact surface the conformance shim locks and the
FFI/Tauri already consume.

## The bindings conformance doctrine

**The stdio conformance shim locks the CORE.** The shared `syncular-command`
router is exercised against the full conformance catalog (Rust client × TS
server, 68/68) through the shim. Every binding consumes that SAME router — the
FFI crate, the Tauri plugin, and (transitively) the Swift/Kotlin/RN wrappers —
so none of them re-implements protocol logic. There is exactly one command
router, and it is the one under test.

**Wrappers are protocol-thin, so they earn a thin bar.** A wrapper's job is
marshaling (JSON in/out, bytes envelope, event delivery, lifecycle), not
protocol. Re-running the full catalog per wrapper would test the router N more
times and the marshaling zero more times. So each wrapper ships:

- an **offline hermetic smoke** proving marshaling end-to-end against the REAL
  native core with **no server** — syncular is offline-first, so `mutate` →
  `readRows`/`query` shows the optimistic row, and `sync()` on the lean core
  honestly reports `transport.unavailable`. This exercises the actual FFI
  boundary (Swift `swift test`, Kotlin `gradle test`) — the elegant hermetic
  path.
- a **parity proof** where the wrapper feeds JS hooks: the RN JS bridge is
  accepted by the React `normalizeClient` and drives every `SyncClientLike`
  member (a `SyncClientLike` drift breaks the suite). The Tauri JS bridge carries
  the same proof.

**Anything that grows logic graduates to a pairing lane.** If a binding ever
adds behavior beyond marshaling (e.g. native CRDT editing, a windowing registry
that lives in the wrapper), that logic earns its own conformance scenarios — a
per-binding pairing lane — not a smoke. Today none does; the wrappers are thin,
so the smoke + parity bar is the honest floor.

### The per-binding smoke, concretely

- **Swift** — `bindings/swift/Tests` (Swift Testing): init/create, command
  round-trip, mutate → readRows (optimistic `version == -1`), the query fast
  path, `{error}` → `SyncularError`, the offline outbox, `transport.unavailable`
  on the lean core, the idle event poll, `close()` idempotence, `pause()`/`resume()`.
- **Kotlin** — `bindings/kotlin/src/test` (kotlin-test): the same suite over FFM.
- **Flutter/Dart** — `bindings/flutter/syncular/test` (`dart test`): the same
  suite over `dart:ffi` against the real native core.
- **React Native** — `bindings/react-native/test` (bun): the JS bridge over an
  injected NativeModule double + the `normalizeClient` parity test.
- **Tauri** — its plugin's Rust tests (router round-trip, event derivation,
  file-DB persistence) + `@syncular-v2/tauri`'s bridge/parity tests.

## Running the gates

Each binding: `cd bindings/<name> && ./check.sh`. The scripts **detect and skip**
missing toolchains (never fail the run), mirroring `rust/scripts/build-native.sh`:
Swift needs a Swift toolchain (Command-Line-Tools is enough for the mac slice);
Kotlin needs JDK 21+ and Gradle; Flutter/Dart needs a Dart SDK (bundled with
Flutter, or standalone); Tauri needs its cargo tree (+ webkit on Linux); RN needs
only bun. CI runs the cheap lanes (Kotlin/FFM + Flutter/Dart + RN on Ubuntu, Tauri
path-gated); the Swift lane is a documented local gate (a macOS runner is
expensive) — see each README's CI note and `.github/workflows/v2.yml`.
