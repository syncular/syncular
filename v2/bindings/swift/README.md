# syncular · Swift bindings

An idiomatic Swift wrapper over the **syncular-ffi** C-ABI native core (the five
functions in [`rust/ffi.h`](../../rust/ffi.h)). A `SyncularClient` class owns the
opaque handle, marshals JSON commands, offers typed conveniences over the common
command set, and runs the `poll_event` loop on a background queue — delivering
events on the main queue to a closure or delegate.

This is a **separate SwiftPM package**, isolated from the main workspaces exactly
like [`bindings/tauri`](../tauri): it never joins `bun run check` or the main
cargo gate. Its own gate is `./check.sh`.

## The surface

```swift
import Syncular

let client = try SyncularClient(
    clientId: "device-1",
    schema: schemaJSON,                 // JSONValue from your generated schema
    config: SyncularConfig(
        baseUrl: "https://your.server/sync",   // engages native transport
        dbPath: "\(appSupport)/syncular.db"    // file-backed persistence
    )
)

// Typed conveniences mirror the command surface:
try client.subscribe(id: "s1", table: "todo", scopes: ["project": ["p1"]])
let commit = try client.mutate([/* driver upsert/delete ops */])
let rows   = try client.readRows(table: "todo")          // RowState objects
let hits   = try client.query("SELECT * FROM todo WHERE done = ?", params: [.bool(false)])
let outcome = try client.sync()                          // needs native transport
let peers  = try client.presence(scopeKey: "project:p1")
try client.setPresence(scopeKey: "project:p1", doc: .object(["cursor": .number(3)]))

// Raw escape hatch for any method the conveniences don't cover:
let result = try client.command(method: "leaseState", params: .object([:]))

// Events (sync-needed / conflict / rejection / presence / schema-floor / lease)
// arrive on the main queue:
client.onEvent = { event in
    switch event.type {
    case "sync-needed": client.syncInBackground()
    case "conflict":    reloadConflicts()
    default:            break
    }
}
```

Everything speaks the driver-protocol JSON the core and the conformance shim
share: `{method, params}` in, `{result|error}` out, bytes as `{"$bytes":"<hex>"}`.
`readRows` returns `RowState` objects (`{rowId, version, values}`; `version == -1`
marks an optimistic, not-yet-synced row); `query` returns flat SQL rows.

## Binary linkage — two consumption modes

The wrapper links the native core; the core is built by
[`rust/scripts/build-native.sh`](../../rust/scripts/build-native.sh).

1. **Local dev / this package's tests.** `check.sh` builds the mac dylib and
   copies it to `vendor/`; `Package.swift`'s `Syncular` target links it via a
   `-L vendor -lsyncular` linker search path, and the loader finds it at runtime
   through `DYLD_LIBRARY_PATH=vendor` (set by `check.sh`). **No Xcode required** —
   a Command-Line-Tools mac builds and links the mac slice.

2. **Release (a consuming app).** Build the `Syncular.xcframework`
   (`build-native.sh apple` on a **full-Xcode** machine — iOS device + simulator
   + macOS slices) and consume it as a `.binaryTarget`:

   ```swift
   .binaryTarget(name: "CSyncular", path: "Syncular.xcframework"),
   .target(name: "Syncular", dependencies: ["CSyncular"]),  // drop linkerSettings
   ```

   The C module map here (`Sources/CSyncularFFI`) is a verbatim copy of
   `rust/ffi.h`; the xcframework embeds the same header, so the Swift target
   compiles unchanged against either linkage.

## Lifecycle (the wrapper owns it)

Per the roadmap, background/foreground and connectivity handling lives in the
wrapper, not the core. `SyncularClient` exposes:

- **`pause()`** — stops the event poll loop and disconnects the realtime socket.
  Call from `applicationDidEnterBackground` (SwiftUI: `.onChange(of: scenePhase)`
  → `.background`) or a connectivity-lost handler. The database and offline
  outbox are intact; mutations still queue offline.
- **`resume()`** — reconnects realtime (if a transport is present) and restarts
  the poll loop. Call from `applicationDidBecomeActive` / connectivity-restored.
- **`close()`** — releases the core (database, transport, socket thread). Blocks
  until the poll loop has left its in-flight `poll_event` call, so the handle is
  never freed under a waiter. Idempotent; commands throw `client.closed` after.

Honest scope: the core has no single "stop everything" command, so `pause()` is
`stop-poll-loop + disconnectRealtime` — it does not tear down the HTTP transport
(there is no persistent HTTP connection to hold). If a future need arises for a
harder freeze, that is an additive core command, coordinated through
`rust/crates/command`.

### SwiftUI wiring sketch

```swift
@Environment(\.scenePhase) private var scenePhase
// …
.onChange(of: scenePhase) { _, phase in
    switch phase {
    case .background: client.pause()
    case .active:     client.resume()
    default:          break
    }
}
```

## Example — the todo demo

[`example/`](example) is a runnable todo app over this wrapper: a **SwiftUI
macOS window** (`TodoUI`) and a **terminal** app (`todo`) sharing one ~30-line
integration, talking to the [quickstart](../../examples/quickstart) server. The
SwiftUI window compiles, links, and presents a real window on a
Command-Line-Tools-only mac (no full Xcode). `check.sh` builds it; see
[`example/README.md`](example/README.md) for the run recipe and the verified
end-to-end sync transcript.

## Tests & gate

`./check.sh` (from anywhere) runs the whole gate:

1. Asserts `Sources/CSyncularFFI/include/syncular_ffi.h` is byte-identical to
   `rust/ffi.h` (drift fails).
2. Builds the lean `libsyncular` dylib for this mac and vendors it.
3. `swift build` + `swift test` against it.

The tests are **hermetic and offline-first** — no server. Syncular is
offline-first by design: a `mutate` is optimistic and immediately visible via
`readRows`/`query`, so the offline path needs no HTTP server. Coverage:
init/create, raw command round-trip, mutate → readRows (the optimistic row with
`version == -1`), the query fast path, `{error}` surfacing as `SyncularError`,
the offline outbox (`pendingCommitIds`), a network command reporting
`transport.unavailable` on the lean core (by design `sync()` returns
`{ok:false, errorCode}` rather than erroring out-of-band), the non-blocking
event poll, `close()` idempotence, and a `pause()`/`resume()` cycle.

The tests use **Swift Testing** (`import Testing`) — the framework that ships
with the Swift toolchain, so `swift test` runs on a Command-Line-Tools-only mac
(unlike full XCTest, which needs Xcode). `check.sh` passes the toolchain's
`Testing.framework` search path + rpaths so the test bundle loads on CLT; on a
full-Xcode machine those flags are harmless.

## CI

Running `swift test` in CI needs a macOS runner (expensive). Per the tauri-job
precedent's honest scoping, the Swift gate is **not** run in CI — it is the local
`check.sh` bar documented here. The Kotlin gate (FFM, JDK-only) IS cheap enough
to compile-check on an Ubuntu runner; see [`../kotlin`](../kotlin) and the
`swift-kotlin-bindings` job in `.github/workflows/v2.yml`.
