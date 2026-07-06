# Kotlin (Android & JVM)

The Kotlin binding is a **Kotlin/JVM library** (`dev.syncular`) over the Rust
native core's C FFI — bound via **FFM** (`java.lang.foreign`, JDK 21+), so
there is zero JNI glue: no C shim, no cbindgen, no second build step, and the
only runtime surface beyond `kotlin-stdlib` is the JDK itself. The binding is
thin marshaling over the shared Rust core — protocol behavior is identical on
every platform because every binding drives the same `syncular-command`
surface. See [FFI & the native core](/platform-ffi/) for the underlying C ABI.

## Install

The library lives at
[`bindings/kotlin`](https://github.com/syncular/syncular/tree/main/bindings/kotlin)
— a separate Gradle project (`kotlin("jvm")`, `jvmToolchain(21)`). FFM is
stable from JDK 22 and a preview feature on JDK 21, so the build passes
`--enable-preview` (benign on 22+) plus `--enable-native-access=ALL-UNNAMED`
for the downcalls. JDK 21+ with FFM is the one supported JVM path — there is
no JDK-below-21 fallback.

The native core itself (`libsyncular`) is built by
[`rust/scripts/build-native.sh`](https://github.com/syncular/syncular/blob/main/rust/scripts/build-native.sh)
and loaded at runtime — see the library-loading section below.

## Create a client

`SyncularClient.create` constructs the native core, issues `create` with your
schema and client id, and starts the event poll loop. The schema comes from
typegen — declare a `kotlin` output in `syncular.json` and
`syncular generate` emits a `Syncular.generated.kt` with a ready-made
`SyncularSchema.schema` value plus typed rows and subscription helpers (see
[Schema & typegen](/guide-schema/)).

```kotlin
import dev.syncular.*

val client = SyncularClient.create(
    clientId = "device-1",                    // stable per-device id
    schema = SyncularSchema.schema,           // from Syncular.generated.kt
    config = SyncularConfig(
        baseUrl = "https://your.server/sync", // engages the native transport
        dbPath = "$appData/syncular.db",      // file-backed persistence
    ),
)
```

`baseUrl` engages the native HTTP + WebSocket transport (a core built with the
`native-transport` feature); omit it for the dependency-lean, offline-only
core. `dbPath` installs a file-backed SQLite database for persistence across
launches; omit it for in-memory. `SyncularConfig` also takes `wsUrl` and
`headers` (auth, tenant, …) for the native transport.

## Reads & writes

```kotlin
// Subscribe: table + scope map. Local; sync fills it.
client.subscribe(id = "todos", table = "notes",
                 scopes = mapOf("list_id" to listOf("welcome")))

// Optimistic write — visible immediately, offline or not.
val commitId = client.mutate(listOf(
    JsonValue.obj(
        "table" to JsonValue.of("notes"), "op" to JsonValue.of("upsert"),
        "values" to JsonValue.obj(
            "id" to JsonValue.of("n1"), "list_id" to JsonValue.of("welcome"),
            "body" to JsonValue.of("Hello"), "updated_at_ms" to JsonValue.of(1),
        ),
    ),
))

// RowState objects: {rowId, version, values}; version == -1 = optimistic.
val rows = client.readRows("notes")

// The live-query fast path: arbitrary read-only SQL, flat rows.
val hits = client.query("SELECT id, body FROM notes WHERE list_id = ?",
                        listOf(JsonValue.of("welcome")))
```

`JsonValue` is the binding's hand-rolled JSON model (no third-party JSON
dependency). The scope map is the same authorization vocabulary as everywhere
else in syncular — see [Scopes & authorization](/concepts-scopes/). Anything
the typed conveniences do not cover is reachable through the raw escape hatch,
`client.command(method, params)`.

## Sync loop & events

```kotlin
val outcome = client.sync()        // one round; needs native-transport
client.syncUntilIdle(maxRounds = 10)

client.listener = SyncularEventListener { event ->
    when (event.type) {
        "sync-needed" -> scheduleSync()
        "conflict"    -> reloadConflicts()
    }
}
```

Events (`sync-needed`, `conflict`, `rejection`, `presence`, `schema-floor`,
`lease`) are drained from the core's `poll_event` queue on a background daemon
thread and delivered to the registered `listener` **on that poll thread** —
marshal to your UI thread as needed. Supporting reads: `syncNeeded()`,
`pendingCommitIds()`, `subscriptionState(id)`, `conflicts()`,
`presence(scopeKey)`, `setPresence(scopeKey, doc)`, and `connectRealtime()` /
`disconnectRealtime()`.

Failed commands throw `SyncularException` (a stable `code` plus a message) —
with one deliberate exception: `sync()` never errors out-of-band. Offline or
on the lean core it returns `{ok: false, errorCode: "transport.unavailable"}`,
and the mutation stays in the **offline outbox** (`pendingCommitIds()` is
non-empty until sync drains it). Writes are always optimistic: a `mutate` is
immediately visible via `readRows`/`query`, server or not.

## Collaborative text (CRDT)

With a core built with the `crdt-yjs` feature, `crdt` columns get native
helpers — byte-compatible with the web `@syncular/crdt-yjs` helper (see
[CRDT](/concepts-crdt/)):

```kotlin
val text = client.crdtText("notes", "n1", "doc")
client.crdtInsertText("notes", "n1", "doc", 0, "Hi ")
client.crdtDeleteText("notes", "n1", "doc", 0, 3)
```

`crdtApplyUpdate` applies an arbitrary Yjs update (a `ByteArray`) as an escape
hatch. Each editing helper pushes the update through the normal mutate path
and returns the enqueued `clientCommitId`.

## Library loading

The FFM `SymbolLookup` resolves `libsyncular` in a fixed order:

- **Explicit path** — the `syncular.library.path` system property, e.g.
  `-Dsyncular.library.path=/abs/path/libsyncular.dylib`. This is how the
  binding's own tests load the freshly built core.
- **By name** — failing that, `System.loadLibrary("syncular")` resolves
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

- **`pause()`** — stops the event poll loop and disconnects the realtime
  socket. Call from an Android `Activity.onStop()` or a connectivity-lost
  callback. Database and outbox intact; mutations still queue.
- **`resume()`** — reconnects realtime (if present) and restarts the poll loop.
- **`close()`** — releases the core. `SyncularClient` is `AutoCloseable`
  (use `client.use { … }` for scoped lifetimes). Idempotent; it joins the poll
  thread first so the handle is never freed under an in-flight `poll_event`,
  and commands throw `client.closed` afterwards.

The core is **thread-affine**: the wrapper serializes all command dispatch
through an internal lock, so you may call `SyncularClient` from any thread —
never call the FFI directly. The
[example](https://github.com/syncular/syncular/tree/main/bindings/kotlin/example)
is a terminal todo app against the [quickstart](/quickstart/) server; its CI
smoke pushes a write through a live server and reads it back from an
independent client.

## Where to go next

- [FFI & the native core](/platform-ffi/) — the C ABI every binding shares.
- [Scopes & authorization](/concepts-scopes/) — the scope maps you subscribe with.
- [Conflicts & optimistic writes](/concepts-conflicts/) — what the `conflict` event carries.
- [Quickstart](/quickstart/) — the server these examples talk to.
