# Kotlin (Android & JVM)

The Kotlin binding is a **Kotlin/JVM library** (`dev.syncular`) over the Rust
native core's C FFI, bound via **FFM** (`java.lang.foreign`, JDK 21+). FFM
downcalls bind the dylib directly, so the build is a single step with no
hand-written JNI layer, and the only runtime surface beyond `kotlin-stdlib`
is the JDK itself. See [FFI & the native core](/platform-ffi/) for the
underlying C ABI.

## Install

The library lives at
[`bindings/kotlin`](https://github.com/syncular/syncular/tree/main/bindings/kotlin),
a separate Gradle project (`kotlin("jvm")`, `jvmToolchain(21)`). FFM is
stable from JDK 22 and a preview feature on JDK 21, so the build passes
`--enable-preview` (benign on 22+) plus `--enable-native-access=ALL-UNNAMED`
for the downcalls. JDK 21+ with FFM is the only supported JVM path.

The native core itself (`libsyncular`) is built by
[`rust/scripts/build-native.sh`](https://github.com/syncular/syncular/blob/main/rust/scripts/build-native.sh)
and loaded at runtime; see the library-loading section below.

## Create a client

`SyncularClient.create` constructs the native core, issues `create` with your
schema and optional explicit client id, and starts the event poll loop. The schema comes from
typegen: declare a `kotlin` output in `syncular.json` and
`syncular generate` emits a `Syncular.generated.kt` with a ready-made
`SyncularSchema.schema` value plus typed rows and subscription helpers (see
[Schema & typegen](/guide-schema/)).

```kotlin
import dev.syncular.*

val client = SyncularClient.create(
    schema = SyncularSchema.schema,           // from Syncular.generated.kt
    config = SyncularConfig(
        baseUrl = "https://your.server/sync", // engages the native transport
        dbPath = "$appData/syncular.db",      // file-backed persistence
    ),
)
```

With a `baseUrl` the client runs the native HTTP and WebSocket transport;
without one it runs the offline-only core with no network stack. The native
transport requires a core built with the `native-transport` feature. Give the
client a persistent database path; an in-memory database loses rows, cursors,
client identity, and the outbox on restart. `SyncularConfig` also takes
`wsUrl` and `headers` (auth, tenant, …) for the native transport.

Rotate credentials without recreating the client:

```kotlin
client.setHeaders(mapOf("Authorization" to "Bearer $freshToken"))
```

The next HTTP request uses the new headers. An open WebSocket keeps the
headers from its handshake; call `pause()` and `resume()` when the new
credential must apply to the live socket immediately.

## Reads & writes

```kotlin
// Subscribe: table + scope map. Local; sync fills it.
client.subscribe(id = "todos", table = "todos",
                 scopes = mapOf("list_id" to listOf("groceries")))

// Optimistic write: visible in local reads immediately.
val commitId = client.mutate(listOf(
    JsonValue.obj(
        "table" to JsonValue.of("todos"), "op" to JsonValue.of("upsert"),
        "values" to JsonValue.obj(
            "id" to JsonValue.of("t1"), "list_id" to JsonValue.of("groceries"),
            "title" to JsonValue.of("Hello"), "updated_at_ms" to JsonValue.of(1),
        ),
    ),
))

// RowState objects: {rowId, version, values}; version == -1 = optimistic.
val rows = client.readRows("todos")

// Arbitrary read-only SQL, returned as flat rows.
val hits = client.query("SELECT id, title FROM todos WHERE list_id = ?",
                        listOf(JsonValue.of("groceries")))
```

`JsonValue` is the binding's hand-rolled JSON model (no third-party JSON
dependency). Scope maps carry the authorization vocabulary used throughout
syncular; see [Scopes & authorization](/concepts-scopes/). Anything the
typed conveniences do not cover is reachable through the raw
`client.command(method, params)`.

## Sync loop & events

```kotlin
val outcome = client.sync()        // one round; needs native-transport
client.syncUntilIdle(maxRounds = 10)

client.listener = SyncularEventListener { event ->
    when (event.type) {
        "sync-intent" -> scheduleSync()
        "change"      -> refreshVisibleState()
    }
}
```

Exact `change` batches, `sync-intent`, and `presence` are drained from the
core's `poll_event` queue on a background daemon
thread and delivered to the registered `listener` **on that poll thread**;
marshal to your UI thread as needed. Supporting reads: `syncNeeded()`,
`pendingCommitIds()`, `subscriptionState(id)`, `conflicts()`,
`presence(scopeKey)`, `setPresence(scopeKey, doc)`, and `connectRealtime()` /
`disconnectRealtime()`.

Failed commands throw `SyncularException` (a stable `code` plus a message).
`sync()` reports transport failure in its return value: offline, or on the
offline-only core, it returns
`{ok: false, errorCode: "transport.unavailable"}`, and the commit waits in
the outbox; `pendingCommitIds()` stays non-empty until a later sync drains
it. `mutate` applies locally at once and queues the commit for the next push.

## Collaborative text (CRDT)

`crdt` columns expose native editing helpers:

```kotlin
val text = client.crdtText("notes", "n1", "doc")
client.crdtInsertText("notes", "n1", "doc", 0, "Hi ")
client.crdtDeleteText("notes", "n1", "doc", 0, 3)
```

`crdtApplyUpdate` applies an arbitrary Yjs update as a `ByteArray` for cases
the text helpers do not cover; each helper pushes its update through the
normal mutate path and returns the enqueued `clientCommitId`. The merge
model, the `crdt-yjs` feature flag, and cross-core convergence guarantees are
on [CRDT columns](/concepts-crdt/).

## Library loading

The FFM `SymbolLookup` resolves `libsyncular` in a fixed order:

- **Explicit path**: the `syncular.library.path` system property, e.g.
  `-Dsyncular.library.path=/abs/path/libsyncular.dylib`. This is how the
  binding's own tests load the freshly built core.
- **By name**: failing that, `System.loadLibrary("syncular")` resolves
  `libsyncular.dylib`/`.so` / `syncular.dll` via `java.library.path`.

**Plain JVM / desktop:** ship the host cdylib (`build-native.sh desktop`) and
point one of the two mechanisms at it. **Android:** the wrapper compiles
JVM-neutral (no Android SDK dependency), so it drops into an Android library
module unchanged; the native `.so`s come from `build-native.sh android`
(`arm64-v8a` + `x86_64` via `cargo-ndk`) and land under `jniLibs/`. The `.so`
then loads by name from the APK, so no `syncular.library.path` is needed.
Packaging a real AAR needs the Android Gradle Plugin + `cargo-ndk`; FFM on
Android also requires a recent runtime.

## Lifecycle & threading

`AndroidConnectivitySignal` adapts the host's current network check and
`ConnectivityManager.NetworkCallback` registration:

```kotlin
fun online(): Boolean = connectivityManager
    .getNetworkCapabilities(connectivityManager.activeNetwork)
    ?.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED) == true

val signal = AndroidConnectivitySignal(
    current = ::online,
    observe = { listener ->
        val callback = object : ConnectivityManager.NetworkCallback() {
            override fun onCapabilitiesChanged(
                network: Network,
                capabilities: NetworkCapabilities,
            ) = listener(
                capabilities.hasCapability(
                    NetworkCapabilities.NET_CAPABILITY_VALIDATED,
                ),
            )
            override fun onLost(network: Network) = listener(false)
        }
        connectivityManager.registerDefaultNetworkCallback(callback)
        SyncularConnectivitySubscription {
            connectivityManager.unregisterNetworkCallback(callback)
        }
    },
)
val connectivity = SyncularConnectivityAdapter(client, signal)

// During client teardown:
connectivity.close()
```

The signal reports network availability only. If activity state also controls
the client, supply a combined foreground-and-online signal or close this
adapter in `onStop()`.

- **`pause()`** stops the event poll loop and disconnects the realtime
  socket. Call from an Android `Activity.onStop()` or a connectivity-lost
  callback. Database and outbox intact; mutations still queue.
- **`resume()`** reconnects realtime (if present) and restarts the poll loop.
- **`close()`** releases the core. `SyncularClient` is `AutoCloseable`
  (use `client.use { … }` for scoped lifetimes). Idempotent; it joins the poll
  thread first so the handle is never freed under an in-flight `poll_event`,
  and commands throw `client.closed` afterwards.

A schema bump on an installed app follows the wipe-and-re-bootstrap
flow in [Schema upgrades](/concepts-schema-upgrades/).

The core is thread-affine. The wrapper serializes every command through an
internal lock, so `SyncularClient` itself is safe to call from any thread;
leave the raw FFI functions to the wrapper. The
[example](https://github.com/syncular/syncular/tree/main/bindings/kotlin/example)
is a terminal todo app against the [quickstart](/quickstart/) server; its CI
smoke pushes a write through a live server and reads it back from an
independent client.

## Where to go next

- [FFI & the native core](/platform-ffi/): the five-function contract this wrapper binds with FFM.
- [Scopes & authorization](/concepts-scopes/): what a scope map means server-side.
- [Conflicts & optimistic writes](/concepts-conflicts/): background for the `conflict` event.
- [Quickstart](/quickstart/): the server used by the example.
