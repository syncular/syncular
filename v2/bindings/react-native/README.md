# syncular · React Native module

`@syncular-v2/react-native` — the syncular native Rust core (over the C-ABI FFI)
surfaced to React Native as the **same `SyncClientLike` interface** the React
package normalizes, so `@syncular-v2/react` hooks (`useSyncQuery`, `useMutation`,
`usePresence`, …) work **unchanged** in an RN app. It is the fifth host of one
interface, after direct / worker-leader / multi-tab follower / Tauri.

## Why the native core (not JS syncular in Hermes)

Decided in [ROADMAP block 1](../../ROADMAP.md#1-native-bindings-block-the-one-real-parity-gap):
RN's Hermes runtime has **no OPFS and no sqlite-wasm**, and the v2 TS client's
persistent path depends on both. So RN uses the **native core** — `rusqlite` on
the device filesystem, HTTP+WS owned in Rust (`native-transport`) — bridged
through a TurboModule. The bridge is thin because the surface is already
JSON-command-shaped: `command_json` in, `{result|error}` out, bytes as
`{"$bytes":hex}`, and `poll_event` feeding an RN event emitter.

```
┌── JS (Hermes) ─────────────┐         ┌── native (per platform) ───────────┐
│ @syncular-v2/react hooks   │         │ TurboModule shim (ObjC++ / Kotlin)  │
│   │ SyncClientLike         │ Turbo-  │   syncular_client_command  ─┐       │
│ @syncular-v2/react-native ─┼─Module─▶│   syncular_client_query     ├─ FFI  │
│   createNativeSyncClient   │◀────────┤   syncular_client_poll_event┘  core │
└────────────────────────────┘ events  │   SyncClient (rusqlite FILE db)     │
                                        └─────────────────────────────────────┘
```

## What ships here (honest scoping)

A **full RN TurboModule** verified end-to-end needs an RN app harness + platform
builds — disproportionate to stand up headless. So this package ships the
**module, correctly structured for RN consumption**, with the JS bridge verified
hermetically:

- **`src/index.ts`** — `createNativeSyncClient()` implementing `SyncClientLike`
  over a `NativeModule` interface (the `{$bytes:hex}` + command-JSON protocol,
  mirroring `@syncular-v2/tauri`). Native module + event emitter are
  **injectable**, so the bridge unit-tests with a double.
- **`src/NativeSyncular.ts`** — the codegen-ready TurboModule spec (`.ts`), whose
  `codegenConfig` in `package.json` drives RN's codegen at the app's build.
- **`ios/Syncular.{h,mm}`** — the ObjC++ shim calling the C ABI (linked from
  `Syncular.xcframework`), pumping `poll_event` on a background queue and
  emitting on `syncular::event` via `RCTEventEmitter`.
- **`android/…/SyncularModule.kt` + `SyncularPackage.kt`** — the Kotlin shim
  calling the C ABI via **FFM** (`java.lang.foreign`, zero JNI C glue — same
  technique as [`bindings/kotlin`](../kotlin)), loading `libsyncular.so` from the
  APK's `jniLibs`.
- **`syncular-react-native.podspec` + `android/build.gradle`** — RN packaging.

An **RN example app is explicitly OUT** of scope for this rung.

## Usage

```tsx
import { createNativeSyncClient } from '@syncular-v2/react-native';
import { SyncProvider } from '@syncular-v2/react';
import { schema } from './syncular.generated';

const client = await createNativeSyncClient({
  clientId: 'device-1',
  schema,
  baseUrl: 'https://your.server/sync', // engages the native transport
});

// Every @syncular-v2/react hook works unchanged:
<SyncProvider client={client}>{/* … */}</SyncProvider>;
```

Bytes cross as `{$bytes:hex}`; the JS layer parses/stringifies so the native
shims marshal only strings. Lifecycle: `client.pause()` (stop the native event
pump + disconnect realtime — call from `AppState` `'background'`) and
`client.resume()`; `client.close()` releases the native core.

## Verification bar

`./check.sh` runs the automated gate:

- **`bun test`** — the JS bridge with an **injected NativeModule double** (the
  `@syncular-v2/tauri` pattern): the `SyncClientLike` contract, method → command
  mapping, the `query` fast path, `{$bytes:hex}` round-trip, event fanout to
  `onInvalidate`/`onPresence`, lifecycle (pause/resume/close driving the native
  pump), and a **parity test against the React `normalizeClient`** (so a drift in
  `SyncClientLike` breaks this suite).
- **`tsc --noEmit`** — the TypeScript (bridge + spec) compiles. A minimal
  ambient `react-native` stub (`types/react-native.d.ts`) lets the spec
  typecheck standalone; a consuming app's real RN types shadow it.

This package is **isolated from the main gates**: its tests are path-ignored from
`bun run test`, and its `.ts` is not in the root `tsconfig` (so it never enters
the main `typecheck`). It is registered in the root `workspaces` ONLY so
`workspace:*` links `@syncular-v2/web-client` / `@syncular-v2/react` for the
parity test.

### Verifying the native shims (manual recipe)

The iOS `.mm` and Android `.kt` shims compile at a **consuming app's build**
(they need the RN pods / Android Gradle Plugin + the codegen'd spec, plus the
native artifact). Standing up `xcodebuild`/`gradle` here would pull
Xcode/Android-SDK toolchains (>GB) for one compile — the tauri-job precedent's
honest scoping applies. To verify manually:

1. Build the native core: `rust/scripts/build-native.sh` →
   `Syncular.xcframework` (drop into `ios/`) and `libsyncular.so` per ABI (drop
   into `android/src/main/jniLibs/<abi>/`).
2. Add the package to a bare RN app (`npx react-native init`); autolinking wires
   the pod + gradle module.
3. iOS: `cd ios && pod install`; build in Xcode. Android: `./gradlew
   :app:assembleDebug`.
4. Run the app: `createNativeSyncClient` + a `useSyncQuery` view proves the
   round trip end-to-end (mirrors the tauri README's `cargo tauri dev` note).

## CI

The RN gate runs on the standard Ubuntu runner (bun test + tsc — no native
toolchain), as part of the `swift-kotlin-bindings` job in
`.github/workflows/v2.yml` (path-gated on `v2/bindings/**`).
