# Swift (iOS & macOS)

The Swift binding is a **SwiftPM package** (`Syncular`) wrapping the Rust
native core via its C FFI: the five functions in
[`rust/ffi.h`](https://github.com/syncular/syncular/blob/main/rust/ffi.h). A
`SyncularClient` class owns the opaque handle, marshals JSON commands, and
delivers events to a closure on the main queue. Everything below the JSON
boundary is the shared core; [FFI & the native core](/platform-ffi/) covers
the C ABI and the command surface all bindings drive.

## Install

The package lives at
[`bindings/swift`](https://github.com/syncular/syncular/tree/main/bindings/swift).
It links `libsyncular`, the native core built by
[`rust/scripts/build-native.sh`](https://github.com/syncular/syncular/blob/main/rust/scripts/build-native.sh),
in one of two modes:

- **Local dev.** `./check.sh` builds the mac dylib into `vendor/`;
  `Package.swift` links it via `-L vendor -lsyncular` and the loader finds it
  through `DYLD_LIBRARY_PATH=vendor`. A Command-Line-Tools mac builds and
  tests the mac slice without Xcode.
- **Release (a consuming app).** Build the `Syncular.xcframework`
  (`build-native.sh apple` on a full-Xcode machine; iOS device, simulator,
  and macOS slices) and consume it as a `.binaryTarget`:

```swift
.binaryTarget(name: "CSyncular", path: "Syncular.xcframework"),
.target(name: "Syncular", dependencies: ["CSyncular"]),  // drop linkerSettings
```

The C module map in `Sources/CSyncularFFI` is a verbatim copy of `rust/ffi.h`
(the gate fails on drift), and the xcframework embeds the same header, so the
Swift target compiles unchanged against either linkage.

## Create a client

The initializer creates the native core, issues `create` with your schema and
optional explicit client id, and starts the background event poll loop. The schema comes from
typegen: declare a `swift` output in `syncular.json` and `syncular generate`
emits a `Syncular.generated.swift` with a ready-made `SyncularSchema.schema`
value plus typed row structs and subscription helpers (see
[Schema & typegen](/guide-schema/)).

```swift
import Syncular

let client = try SyncularClient(
    schema: SyncularSchema.schema,             // from Syncular.generated.swift
    config: SyncularConfig(
        baseUrl: "https://your.server/sync",   // engages the native transport
        dbPath: "\(appSupport)/syncular.db"    // file-backed persistence
    )
)
```

With a `baseUrl` the client runs the native HTTP and WebSocket transport;
without one it runs the offline-only core with no network stack. The native
transport requires a core built with the `native-transport` feature. Give the
client a persistent database path; an in-memory database loses rows, cursors,
client identity, and the outbox on restart. `SyncularConfig` also takes
`wsUrl` (derived from `baseUrl` if nil) and `headers` (auth, tenant, …) for
the native transport.

Rotate credentials without recreating the client:

```swift
try client.setHeaders(["Authorization": "Bearer \(freshToken)"])
```

The next HTTP request uses the new headers. An open WebSocket keeps the
headers from its handshake; call `pause()` and `resume()` when the new
credential must apply to the live socket immediately.

## Reads & writes

```swift
// Subscribe: table + scope map. Local; sync fills it.
try client.subscribe(id: "todos", table: "todos",
                     scopes: ["list_id": ["groceries"]])

// Optimistic write: visible in local reads immediately.
let commitId = try client.mutate([
    .object([
        "table": .string("todos"), "op": .string("upsert"),
        "values": .object([
            "id": .string("t1"), "list_id": .string("groceries"),
            "title": .string("Hello"), "updated_at_ms": .number(1),
        ]),
    ]),
])

// RowState objects: {rowId, version, values}; version == -1 = optimistic.
let rows = try client.readRows(table: "todos")

// Arbitrary read-only SQL, returned as flat rows.
let hits = try client.query("SELECT id, title FROM todos WHERE list_id = ?",
                            params: [.string("groceries")])
```

The scope map is the same authorization vocabulary used across syncular
(see [Scopes & authorization](/concepts-scopes/)). Anything the typed
conveniences do not cover is reachable through the raw command call:

```swift
let result = try client.command(method: "leaseState", params: .object([:]))
```

## Sync loop & events

```swift
let outcome = try client.sync()             // one round; needs native-transport
try client.syncUntilIdle(maxRounds: 10)     // drive to quiescence

client.onEvent = { event in
    switch event.type {
    case "sync-intent": scheduleSync()
    case "change":      refreshVisibleState()
    default:            break
    }
}
```

Exact `change` batches, `sync-intent`, and `presence` are drained from the
core's `poll_event` queue on a background queue
and delivered on the main queue; set the `onEvent` closure or a
`SyncularClientDelegate`. A different `deliveryQueue` can be passed to the
initializer. Supporting reads: `syncNeeded()`, `pendingCommitIds()`,
`subscriptionState(id:)`, `conflicts()`, `presence(scopeKey:)`,
`setPresence(scopeKey:doc:)`, and `connectRealtime()` /
`disconnectRealtime()`.

Failed commands throw `SyncularError` (a stable `code` plus a message).
`sync()` reports transport failure in its return value: offline, or on the
offline-only core, it returns
`{ok: false, errorCode: "transport.unavailable"}`, and the commit waits in
the outbox; `pendingCommitIds()` stays non-empty until a later sync drains
it. `mutate` applies locally at once and queues the commit for the next push.

## Collaborative text (CRDT)

`crdt` columns expose native editing helpers:

```swift
let text = try client.crdtText(table: "notes", rowId: "n1", column: "doc")
try client.crdtInsertText(table: "notes", rowId: "n1", column: "doc",
                          index: 0, value: "Hi ")
try client.crdtDeleteText(table: "notes", rowId: "n1", column: "doc",
                          index: 0, len: 3)
```

`crdtApplyUpdate` applies an arbitrary Yjs update (raw bytes) for cases the
text helpers do not cover; each helper pushes its update through the normal
mutate path and returns the enqueued `clientCommitId`. The merge model, the
`crdt-yjs` feature flag, and cross-core convergence guarantees are on
[CRDT columns](/concepts-crdt/).

## Lifecycle & threading

`IOSPathConnectivitySignal` adapts `NWPathMonitor` and drives the same
pause/resume lifecycle:

```swift
let pathSignal = IOSPathConnectivitySignal()
let connectivity = SyncularConnectivityAdapter(
    client: client,
    signal: pathSignal
)

// During client teardown:
connectivity.stop()
pathSignal.stop()
```

The path signal reports network availability only. If app background state
also controls the client, use one combined foreground-and-online signal or
stop this adapter while the app is backgrounded. Two independent lifecycle
owners could otherwise resume the client while the other still requires a
pause.

- **`pause()`** stops the event poll loop and disconnects the realtime
  socket. Call when the app backgrounds (SwiftUI: `.onChange(of: scenePhase)`
  → `.background`). The database and outbox are intact; mutations still queue.
- **`resume()`** reconnects realtime (if a transport is present) and
  restarts the poll loop.
- **`close()`** releases the core (database, transport, socket thread).
  Idempotent; it blocks until the poll loop has left its in-flight
  `poll_event` call, so the handle is never freed under a waiter. Commands
  throw `client.closed` afterwards.

A schema bump on an installed app follows the wipe-and-re-bootstrap
flow in [Schema upgrades](/concepts-schema-upgrades/).

The core is thread-affine. The wrapper serializes all command dispatch
through a private serial queue, so you may call `SyncularClient` from any
thread. Never call the FFI directly. The
[example todo app](https://github.com/syncular/syncular/tree/main/bindings/swift/example)
ships a SwiftUI macOS window and a terminal app over one shared ~30-line
integration against the [quickstart](/quickstart/) server.

## Where to go next

- [FFI & the native core](/platform-ffi/): the shared C ABI underneath this wrapper.
- [Scopes & authorization](/concepts-scopes/): how the scope maps you subscribe with are authorized.
- [Conflicts & optimistic writes](/concepts-conflicts/): the payload behind the `conflict` event.
- [Quickstart](/quickstart/): the server the examples above talk to.
