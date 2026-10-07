# Swift (iOS & macOS)

`SyncularClient` gives a Swift app a local SQLite replica, an outbox, and a sync loop. This page shows the shape of the SDK and a first sync in six calls; the sub-pages cover install, daily use, lifecycle, platform details, and fixes.

::meta{for="iOS and macOS developers" time="4 minutes"}

| Property | Value |
|---|---|
| **Runs on** | iOS 14+ and macOS 12+ (SwiftPM `platforms`) |
| **Package** | `Syncular`, a SwiftPM package in [`bindings/swift`](https://github.com/syncular/syncular/tree/main/bindings/swift); consumed from a checkout, not a registry |
| **Core** | Rust core through the C ABI, linked as `libsyncular` or `Syncular.xcframework` |
| **Threading** | Call from any thread; the wrapper serializes commands on a private serial queue. Events arrive on the main queue |
| **Reading time** | 4 minutes here, about 20 for the full set |

:::figure{title="How Swift reaches the core" note="Everything below the JSON line is shared" ticks}
<div class="d-row">
<div class="node hot"><span class="t">Your app</span>SwiftUI or UIKit<br>typed rows from typegen</div>
<span class="d-arrow"></span>
<div class="node"><span class="t">Syncular package</span><code>SyncularClient</code><br>command queue, poll queue</div>
<span class="d-arrow"></span>
<div class="node cool"><span class="t">CSyncularFFI</span>Clang module over<br><code>rust/ffi.h</code></div>
<span class="d-arrow"></span>
<div class="node ok"><span class="t">libsyncular</span>Rust core<br>SQLite, native transport</div>
</div>

::caption[The three native SDKs share this model. [Native client API](/native-client-api/) documents the shared half.]
:::

## First sync

The calls below assume the package is linked ([Install & first sync](/platform-swift-install/)) and `syncular generate` emitted `Syncular.generated.swift`.

```swift
import Syncular

let client = try SyncularClient(
    schema: SyncularSchema.schema,
    config: SyncularConfig(baseUrl: "http://localhost:8787", dbPath: dbPath)
)
try client.subscribe(id: "todos", table: "todos", scopes: ["list_id": ["groceries"]])
try client.mutate([.object([
    "table": .string("todos"), "op": .string("upsert"),
    "values": .object(["id": .string("t1"), "list_id": .string("groceries"),
                       "title": .string("Buy milk"), "done": .bool(false),
                       "position": .number(1), "updated_at_ms": .number(1)]),
])])
try client.syncUntilIdle()
print(try client.query("SELECT id, title FROM todos"))
```

`mutate` is visible to `query` at once. `syncUntilIdle` pushes the outbox and pulls the subscribed list, so a second device with the same subscription reads `t1`.

## The pages

- **[Install & first sync](/platform-swift-install/)**: link the core, create a client against the quickstart server.
- **[Reads & writes](/platform-swift-reads-writes/)**: subscribe, mutate, query, and collaborative text.
- **[Realtime & lifecycle](/platform-swift-realtime/)**: events, `pause()`, `resume()`, `close()`, and the `NWPathMonitor` adapter.
- **[Platform specifics](/platform-swift-specifics/)**: linkage modes, transport policy, threading, and the example app.
- **[Troubleshooting](/platform-swift-troubleshooting/)**: link errors, `client.failed`, and offline results.

The behavior shared with Kotlin and Flutter (configuration, events, snapshot and outcome methods) is on [Native client API](/native-client-api/).
