# Live demos

Every demo in the repo is the same very simple todo list, built to prove two
things per platform: syncular compiles and works there, and the integration is
a few plain lines of code. This page tells you how to run the two browser
demos locally and where the native platform examples live.

## Two-pane convergence demo (`apps/demo`)

The vanilla-DOM headline demo: **two independent client cores** from
`@syncular/client`, each a Web Worker running the whole core
(`SyncClient` + transports + sqlite-wasm on persistent OPFS), syncing a todo
list through one server (`@syncular/server-hono` over bun:sqlite) in a single
Bun process. The page drives each core over the `SyncClientHandle` RPC.

```sh
git clone https://github.com/syncular/syncular
cd syncular
bun install
bun run --cwd apps/demo dev     # http://localhost:8787 (PORT=… to override)
```

One process serves everything on one port: `POST /sync` and
`GET /segments/:id`, the `/realtime` WebSocket, and the frontend + worker
bundles. Server storage is in-memory by default;
`SYNCULAR_DEMO_DB=path bun run --cwd apps/demo dev` persists it to a file.

What to try:

- **Convergence** — add, toggle, or delete todos in pane A; they appear in
  pane B via realtime deltas, and vice versa.
- **Offline replay** — "Go offline" in a pane and keep editing: the **outbox
  counter** grows. "Go online" drains it with idempotent retry.
- **Conflict surfacing** — "Simulate conflict" stages a stale write in an
  offline pane; bringing it back online surfaces a conflict record in that
  pane, and the app decides the resolution.

Two URL modes change the client topology:

- `?multitab` — open the demo in **two browser tabs** with `?multitab` on
  both. The first tab's pane becomes the leader (spawns the worker, owns the
  OPFS database, holds the socket); the second becomes a follower proxying to
  it over a BroadcastChannel. The badge shows `leader` / `follower`. Close
  the leader tab and the follower promotes and keeps syncing.
- `?ephemeral` — the explicit in-memory main-thread mode, labeled in the UI;
  nothing survives a reload.

Details: the [demo README](https://github.com/syncular/syncular/tree/main/apps/demo).

## React demo (`apps/demo-react`)

The hooks counterpart: a single-pane todo app on `@syncular/react` against the
same server core, with the whole client core in a Web Worker on persistent
OPFS. It dogfoods the full hook surface: an async client resource,
`useQuery` with generated dependencies/window coverage/row identity,
`useRawSql` as the guarded escape hatch, typed `useMutation` helpers, and
`useSyncStatus`.

```sh
bun run --cwd apps/demo-react dev   # http://localhost:8788 (PORT=… to override)
```

Change a todo and the list re-renders instantly; the query re-runs only when
its exact dependency changes. The three seed lists (`groceries`, `work`,
`travel`) are separate scope values. Picking one changes query params; its
generated coverage claims the new list and the atomic result phase prevents a
pending or zero-row bootstrap from appearing as a false empty state
([windowed sync](/concepts-windowing/)). Adding a todo shows the optimistic
path: it appears immediately, the `outbox` badge ticks up, then drains as the
sync loop pushes it.

The [demo-react README](https://github.com/syncular/syncular/tree/main/apps/demo-react)
has the full walkthrough.

## Native platform examples

Each binding ships a runnable example: the same todo list over the native
Rust core, with run recipes in each example's README.

- **Swift (macOS)**: a SwiftUI todo window (plus a terminal variant) over the
  Swift `SyncularClient`; the whole integration is a ~30-line `TodoStore`.
  [bindings/swift/example](https://github.com/syncular/syncular/tree/main/bindings/swift/example)
- **Kotlin (JVM)** — a terminal todo app over the Kotlin `SyncularClient`
  (FFM, JDK 21+), same `TodoStore` shape.
  [bindings/kotlin/example](https://github.com/syncular/syncular/tree/main/bindings/kotlin/example)
- **Flutter** builds the todo list in ~150 lines over the Dart
  `SyncularClient` via `dart:ffi`.
  [bindings/flutter/example](https://github.com/syncular/syncular/tree/main/bindings/flutter/example)
- **React Native** runs the `@syncular/react` hooks unchanged over
  `createNativeSyncClient()` (a Rust-core TurboModule).
  [bindings/react-native/example](https://github.com/syncular/syncular/tree/main/bindings/react-native/example)
- **Tauri** uses the same hooks over `createTauriSyncClient()`, with a native
  syncular instance in the Tauri host process.
  [bindings/tauri/example](https://github.com/syncular/syncular/tree/main/bindings/tauri/example)

Taken together: `apps/demo` covers the browser core loop, `apps/demo-react`
covers the typed hook surface, and the native examples show that React web,
Tauri, and React Native run identical hook code while Swift, Kotlin, and Dart
mirror one wrapper surface over the same conformance-locked JSON command
router. The full per-platform verification matrix is
[DEMOS.md](https://github.com/syncular/syncular/blob/main/docs/DEMOS.md).

## Where to go next

- [Quickstart](/quickstart/) — scaffold your own app in five minutes.
- [React bindings](/platform-react/) — the hook surface the demos use.
- [Windowed sync](/concepts-windowing/) — what the window dropdown exercises.
- [Benchmarks](/benchmarks/) — the measured numbers behind the demos.
