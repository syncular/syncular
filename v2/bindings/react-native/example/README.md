# syncular · react-native example

The syncular v2 **React Native todo** — proof that `@syncular-v2/react` hooks
work **unchanged** over the native core. Same clean interface as the web demos
(`apps/demo-react`); the only difference is the client host: instead of the
worker/OPFS client, `<SyncProvider>` is fed a `createNativeSyncClient()` — a
`SyncClientLike` over the TurboModule (Rust `rusqlite` on the device FS).

```tsx
// example/src/App.tsx — the whole interface, no hacks:
import { SyncProvider, useMutation, useSyncQuery, useSyncStatus } from '@syncular-v2/react';

export function App({ client }: { client: SyncClientLike }) {
  return (
    <SyncProvider client={client}>
      <TodoList />   {/* useSyncQuery / useMutation / useSyncStatus, unchanged */}
    </SyncProvider>
  );
}
```

`index.js` is the device boot: `createNativeSyncClient({ clientId, schema })`
auto-resolves the codegen `NativeSyncular` module, awaits the native `create`
(opens the file DB), then mounts `<App client={client}/>`. `AppState` drives
`client.pause()` / `resume()` (battery-friendly; the outbox keeps queuing
offline).

## What's in here

| File | Role |
|---|---|
| `src/App.tsx` | The todo UI over the hooks (framework-agnostic below `<SyncProvider>`). |
| `src/syncular.generated.ts` | The schema + row type (inlined stand-in for typegen output). |
| `index.js` | RN entry: builds the native client, wires `AppState`, registers `<App>`. |
| `app.json`, `babel.config.js`, `metro.config.js`, `package.json` | Bare-RN scaffold. |

The `metro.config.js` watches the v2 tree and forces a single `react` /
`react-native` copy, so the two workspace source packages
(`@syncular-v2/react`, `@syncular-v2/react-native`) resolve against the app's
React — the example is deliberately **outside** the bun workspace (RN apps pin
exact react/react-native; a hoisted workspace fights autolinking and Metro's
single-React rule).

## Running on a device

Standing up the iOS/Android build needs the platform toolchains (Xcode /
Android SDK+NDK) **and** the native syncular artifact — the same one-time overlay
the module README documents. This example ships the **JS side complete**; the
native `ios/` + `android/` project dirs are generated once by the RN CLI (they
are boilerplate no repo should vendor):

```bash
cd bindings/react-native/example

# 1. Install exact RN deps (this example is out of the bun workspace).
npm install

# 2. One-time: generate the native ios/ + android/ project scaffold.
#    (RN has no standalone "add native dirs to an existing app" command; the
#    least-friction path is to init a throwaway app and copy its ios/android in,
#    or `npx react-native@0.81 init SyncularExample` then overlay these JS files.)
npx react-native init SyncularExample --version 0.81.0
#    → copy this dir's index.js / app.json / src/ over the generated JS.

# 3. Build the native core and drop the artifacts (see the module README):
#      rust/scripts/build-native.sh
#    → Syncular.xcframework  → ios/
#    → libsyncular.so per ABI → android/app/src/main/jniLibs/<abi>/

# 4. Run:
npx react-native run-ios       # or: run-android
```

A `createNativeSyncClient` + `useSyncQuery` view then proves the round trip
end-to-end on the device (mirrors the tauri README's `cargo tauri dev` note).

## What is proven WITHOUT a device (the honest local bar)

No Xcode/Android toolchains on the dev machine can't build the app — but the
**JS graph is fully verified**, and the hooks↔module integration is proven
headless:

- **`tsc --noEmit`** (via the module's `check.sh`, which includes
  `example/src/**`): `App.tsx` + the schema typecheck against the real
  `@syncular-v2/react` hooks and the `SyncClientLike` surface — a drift breaks
  it. `react-native`'s primitives resolve through the module's ambient stub
  (`types/react-native.d.ts`).
- **`bun test` — `test/app.test.tsx`**: the **real `App.tsx`** (this file, the
  one that ships) is rendered with `@testing-library/react` against an injected
  **stateful NativeModule double**. It asserts the list renders the rows the
  native `query` returns, and that typing + Add drives `useMutation` →
  `command('mutate')` → an `invalidate` event → `useSyncQuery` re-run → the new
  row on screen. That is the whole hooks↔native-client data flow, with no device
  and no Metro (`react-native` primitives are mocked to DOM tags in
  `test/setup-app.ts`).

So: the interface compiles, the component renders, and mutations flow through
the bridge — everything except the platform-native compile, which is the
documented one-time overlay above.

## CI

The RN gate (bun bridge tests + the App integration test + `tsc`) runs on the
standard Ubuntu runner — no native toolchain — in `.github/workflows/v2.yml`. A
full **device-build lane** (Android `assembleDebug` with cargo-ndk cross-builds
of the cdylib) is the heaviest of all binding lanes; it is a documented
follow-up, not yet wired, to avoid shipping a flaky lane (see the module
README's CI note).
