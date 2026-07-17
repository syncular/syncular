# syncular · React Native module

`@syncular/react-native` — the syncular native Rust core (over the C-ABI FFI)
surfaced to React Native as the **same `SyncClientLike` interface** the React
package normalizes, so `@syncular/react` hooks (`useRawSql`, `useMutation`,
`usePresence`, …) work **unchanged** in an RN app. It is the fifth host of one
interface, after direct / worker-leader / multi-tab follower / Tauri.

## Why the native core (not JS syncular in Hermes)

Decided in [ROADMAP block 1](../../docs/ROADMAP.md#1-native-bindings-block-the-one-real-parity-gap):
RN's Hermes runtime has **no OPFS and no sqlite-wasm**, and the TS client's
persistent path depends on both. So RN uses the **native core** — `rusqlite` on
the device filesystem, HTTP+WS owned in Rust (`native-transport`) — bridged
through a TurboModule. The bridge is thin because the surface is already
JSON-command-shaped: `command_json` in, `{result|error}` out, bytes as
`{"$bytes":hex}`, and `poll_event` feeding an RN event emitter.

```
┌── JS (Hermes) ─────────────┐         ┌── native (per platform) ───────────┐
│ @syncular/react hooks   │         │ TurboModule shim (ObjC++ / Kotlin)  │
│   │ SyncClientLike         │ Turbo-  │   syncular_client_command  ─┐       │
│ @syncular/react-native ─┼─Module─▶│   syncular_client_query     ├─ FFI  │
│   createNativeSyncClient   │◀────────┤   syncular_client_poll_event┘  core │
└────────────────────────────┘ events  │   SyncClient (rusqlite FILE db)     │
                                        └─────────────────────────────────────┘
```

## What ships here (honest scoping)

A **full RN TurboModule** verified end-to-end on a device needs the platform
build toolchains (Xcode / Android SDK+NDK) + the native artifact. So this
package ships the **module, correctly structured for RN consumption**, with the
JS bridge verified hermetically AND a runnable **[example todo app](example)**
whose hooks↔module integration is proven headless:

- **`src/index.ts`** — `createNativeSyncClient()` implementing `SyncClientLike`
  over a `NativeModule` interface (the `{$bytes:hex}` + command-JSON protocol,
  mirroring `@syncular/tauri`). Native module + event emitter are
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
- **[`example/`](example)** — a bare-RN **todo app** over the hooks
  (`<SyncProvider client={await createNativeSyncClient(…)}>` +
  `useRawSql`/`useMutation`/`useSyncStatus`), the same clean interface as the
  web demos. Its real `App.tsx` is rendered headless against a NativeModule
  double as the hooks↔module integration proof (see the verification bar); the
  device build is a documented one-time overlay (no Xcode/Android SDK here).

## Usage

```tsx
import { createNativeSyncClient } from '@syncular/react-native';
import { SyncProvider } from '@syncular/react';
import { schema } from './syncular.generated';

const client = await createNativeSyncClient({
  schema,
  baseUrl: 'https://your.server/sync', // engages the native transport
});

// Every @syncular/react hook works unchanged:
<SyncProvider client={client}>{/* … */}</SyncProvider>;

// Native CRDT (needs the FFI `crdt-yjs` feature) — collaborative text on a
// `crdt` column, byte-compatible with the web `@syncular/crdt-yjs` helper:
const text = await client.crdtText('notes', 'n1', 'doc');
await client.crdtInsertText('notes', 'n1', 'doc', 0, 'Hi ');
await client.crdtDeleteText('notes', 'n1', 'doc', 0, 3);
```

Bytes cross as `{$bytes:hex}`; the JS layer parses/stringifies so the native
shims marshal only strings. Lifecycle: `client.pause()` (stop the native event
pump + disconnect realtime — call from `AppState` `'background'`) and
`client.resume()`; `client.close()` releases the native core.

Final commit outcomes use the same native SQLite journal as Tauri. Call
`commitOutcome`, `commitOutcomes`, and `resolveCommitOutcome`; active
conflicts/rejections and their losing operations survive app restarts.
Failed aggregate outcomes also carry the complete ordered local operation
envelope; it remains protected native SQLite payload and never enters the wire
protocol or ordinary application preferences.

`purgeLocalData({ purgeId, targets })` forwards an application-authorized,
bounded local purge to the native core. It removes exact synced rows and FTS
documents, rejects whole affected pending commits, replays safe optimistic
work, reconciles blob references, and returns counts only. The app must first
validate the directive and gate subscriptions, then separately remove
app-owned files and OS-secure-store keys.

## Verification bar

`./check.sh` runs the automated gate:

- **`bun test`** — two layers, no device:
  - *the JS bridge* with an **injected NativeModule double** (the
    `@syncular/tauri` pattern): the `SyncClientLike` contract, method →
    command mapping, atomic `querySnapshot`, typed `patch`, lossless bigint and
    bytes round-trip, exact `onChange` fanout, lifecycle (pause/resume/close driving
    the native pump), and a **parity test against the React `normalizeClient`**
    (so a drift in `SyncClientLike` breaks this suite);
  - *the App integration render* (`test/app.test.tsx`): the example's **real
    `App.tsx`** rendered with `@testing-library/react` against a **stateful**
    NativeModule double — the list renders the rows the native `querySnapshot`
    returns, and Add drives `useMutation` → `command('mutate')` → an exact
    revisioned `change` event → `useRawSql` re-run → the new row appears. This proves the
    `@syncular/react` hooks drive the native client end-to-end. `react-native`
    primitives are mocked to DOM tags by a bunfig preload (`test/setup-app.ts`) —
    the one thing bun can't resolve off-device.
- **`tsc --noEmit`** — the TypeScript (bridge + spec **+ the example `App.tsx`**)
  compiles. An ambient `react-native` stub (`types/react-native.d.ts`) declares
  the spec's + example's RN surface so both typecheck standalone; a consuming
  app's real RN types shadow it.

This package is **isolated from the main gates**: its tests are path-ignored from
`bun run test`, and its `.ts` is not in the root `tsconfig` (so it never enters
the main `typecheck`). It is registered in the root `workspaces` ONLY so
`workspace:*` links `@syncular/client` / `@syncular/react` (for the
parity + integration tests). The **`example/` app is deliberately OUTSIDE the
workspace** (RN apps pin exact react/react-native; `npm`, which RN tooling uses,
also can't resolve `workspace:*`) — Metro reaches the workspace source packages
via `watchFolders`.

### Verifying the native shims (manual recipe)

The iOS `.mm` and Android `.kt` shims compile at a **consuming app's build**
(they need the RN pods / Android Gradle Plugin + the codegen'd spec, plus the
native artifact). Standing up `xcodebuild`/`gradle` here would pull
Xcode/Android-SDK toolchains (>GB) for one compile — the tauri-job precedent's
honest scoping applies. To verify manually:

1. Build the native core: `rust/scripts/build-native.sh` →
   `Syncular.xcframework` (drop into `ios/`) and `libsyncular.so` per ABI (drop
   into `android/src/main/jniLibs/<abi>/`).
2. Add the package to a bare RN app; autolinking wires the pod + gradle module.
   The **[`example/`](example) app is exactly this app** — its `example/README.md`
   has the full per-platform run recipe (the one-time `ios/`+`android/` scaffold
   overlay + the artifact drop).
3. iOS: `cd ios && pod install`; build in Xcode. Android: `./gradlew
   :app:assembleDebug`.
4. Run the app: `createNativeSyncClient` + the `useRawSql` todo view proves
   the round trip end-to-end (mirrors the tauri README's `cargo tauri dev` note).

## CI

The RN gate runs on the standard Ubuntu runner (bun bridge tests + the App
integration render + tsc — **no native toolchain**), as part of the
`swift-kotlin-bindings` job in `.github/workflows/ci.yml` (path-gated on
`bindings/**`). This lane now also proves the example App's hooks↔module
integration, not just the bridge.

A full **device-build lane** (Android `assembleDebug` on the `example/`) is a
documented **follow-up**, deliberately not wired — it is the heaviest of all
binding lanes and can't be validated on this dev machine (no Android SDK/NDK), so
shipping it blind risks a flaky gate. The exact recipe it would run:

```yaml
# sketch — a separate job, path-gated, NOT yet enabled:
- uses: actions/setup-java@v4         # JDK 17 (AGP)
  with: { distribution: temurin, java-version: 17 }
- uses: android-actions/setup-android@v3   # SDK + NDK
- run: rustup target add aarch64-linux-android armv7-linux-androideabi \
       x86_64-linux-android i686-linux-android
- run: cargo install cargo-ndk
- run: rust/scripts/build-native.sh --android   # cdylib → jniLibs/<abi>/
- run: cd bindings/react-native/example && npm_config_workspace=false <install> \
       && npx react-native init overlay … && ./android/gradlew assembleDebug
```

The blocker to enabling it as-is: the example consumes `workspace:*` source
packages that `npm` (RN's package manager) can't resolve, so the lane needs
either published packages or a `file:`-link install step first — resolved before
this graduates from follow-up to a shipped lane.
