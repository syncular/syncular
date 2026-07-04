# syncular · Kotlin/JVM bindings

An idiomatic Kotlin/JVM wrapper over the **syncular-ffi** C-ABI native core (the
five functions in [`rust/ffi.h`](../../rust/ffi.h)), via **FFM**
(`java.lang.foreign`, JDK 21+). A `SyncularClient` owns the opaque handle,
marshals JSON commands, offers typed conveniences over the common command set,
and runs the `poll_event` loop on a background thread delivering to a listener.

Like [`bindings/swift`](../swift), this is a **separate Gradle project** isolated
from the main workspaces: it never joins `bun run check` or the main cargo gate.
Its own gate is `./check.sh`.

## FFM, not JNA (the binding-technology decision)

The wrapper binds the C ABI through **`java.lang.foreign`** (Project Panama):
`Linker.nativeLinker()` + a `SymbolLookup` over the dylib + `downcallHandle` per
function. See [`SyncularFfi.kt`](src/main/kotlin/dev/syncular/SyncularFfi.kt).

Why FFM over JNA:

- **Zero native-glue code.** No JNI C shim, no cbindgen, no second build step —
  the five downcalls are pure Java/Kotlin. JNA would also avoid a C shim but adds
  a runtime dependency and reflection-based marshaling; FFM is in the JDK and is
  faster (direct downcall handles).
- **The ONLY runtime surface is the JDK.** No third-party jar. Even the JSON is
  hand-rolled ([`JsonValue.kt`](src/main/kotlin/dev/syncular/JsonValue.kt)) so
  the wrapper pulls in nothing beyond `kotlin-stdlib`.
- **Stable path:** FFM is preview in JDK 21 (`--enable-preview`) and **stable in
  JDK 22+**. The build targets a JDK-21 toolchain with the preview flag; on 22+
  the flag is benign.

**JNA fallback (documented, not shipped):** if you must run on JDK < 21, JNA is
the mechanical fallback — declare the same five functions on a `Library`
interface (`Pointer syncular_client_new(String)`, etc.) and marshal strings with
JNA's automatic `String`↔`char*` conversion, freeing returned pointers via
`syncular_free_string`. The surface (`SyncularClient`, conveniences, poll loop)
is identical; only the `SyncularFfi` object swaps its downcall mechanism. We do
not add JNA as a compile dependency because FFM is the target-JDK path.

## The surface

```kotlin
import dev.syncular.*

val client = SyncularClient.create(
    clientId = "device-1",
    schema = schemaJson,                      // JsonValue from your generated schema
    config = SyncularConfig(
        baseUrl = "https://your.server/sync", // engages native transport
        dbPath = "$appData/syncular.db",      // file-backed persistence
    ),
)

client.subscribe(id = "s1", table = "todo", scopes = mapOf("project" to listOf("p1")))
val commit = client.mutate(listOf(/* driver upsert/delete ops as JsonValue */))
val rows   = client.readRows("todo")          // RowState objects
val hits   = client.query("SELECT * FROM todo WHERE done = ?", listOf(JsonValue.of(false)))
val outcome = client.sync()                    // needs native transport
client.setPresence("project:p1", JsonValue.obj("cursor" to JsonValue.of(3)))

client.listener = SyncularEventListener { event ->
    when (event.type) {
        "sync-needed" -> scheduleSync()
        "conflict"    -> reloadConflicts()
    }
}

client.close() // AutoCloseable — use `client.use { … }` for scoped lifetimes
```

Everything speaks the driver-protocol JSON the core and the conformance shim
share: `{method, params}` in, `{result|error}` out, bytes as `{"$bytes":"<hex>"}`.
`readRows` returns RowState objects (`{rowId, version, values}`; `version == -1`
= optimistic/offline); `query` returns flat SQL rows.

## Lifecycle (the wrapper owns it)

Per the roadmap, background/foreground and connectivity handling lives here:

- **`pause()`** — stops the event poll loop and disconnects realtime. Call from
  an Android `Activity.onStop()` / a connectivity-lost callback. Database and
  offline outbox intact; mutations still queue.
- **`resume()`** — reconnects realtime (if present) and restarts the poll loop.
- **`close()`** — releases the core; joins the poll thread first so the handle is
  never freed under an in-flight `poll_event`. Idempotent; commands throw
  `client.closed` after. `SyncularClient` is `AutoCloseable`.

Honest scope: the core has no single "stop everything" command, so `pause()` is
`stop-poll + disconnectRealtime` — coordinate any harder freeze as an additive
core command through `rust/crates/command`.

## Consumption modes

**Plain JVM host / desktop.** Ship the host cdylib
(`build-native.sh desktop` → `.dylib`/`.so`/`.dll`) and put it where the loader
finds it: pass `-Dsyncular.library.path=/abs/path/libsyncular.dylib`, or place it
on `java.library.path` (the FFM lookup falls back to `System.loadLibrary("syncular")`).

**Android (AAR + jniLibs).** The wrapper compiles **JVM-neutral** — no Android
SDK dependency — so it drops into an Android library module unchanged. The
native `.so`s come from `build-native.sh android` (arm64-v8a + x86_64 via
`cargo-ndk`), which lands them under `jniLibs/`. The build script **detects and
skips** the Android slice when `cargo-ndk` / the NDK are absent (never fails the
run); building a real AAR needs the Android Gradle Plugin + `cargo-ndk`, so it
is a packaging step outside this pure-JVM gate. On Android the `.so` loads by
name from the APK's `jniLibs`, so no `syncular.library.path` is needed — FFM's
`System.loadLibrary("syncular")` path applies. (FFM on Android requires a recent
runtime; on older Android, use the JNA fallback above.)

## Example — the todo demo

[`example/`](example) is a runnable terminal todo app over this wrapper (a Gradle
`application` module), talking to the [quickstart](../../examples/quickstart)
server. Its [`ci-smoke.sh`](example/ci-smoke.sh) is the full
native-transport-to-real-server proof — the `swift-kotlin-bindings` CI job runs
the example against a live server and has an independent client read the synced
row back. See [`example/README.md`](example/README.md) for the run recipe.

## Tests & gate

`./check.sh` (from anywhere):

1. Builds the lean `libsyncular` for this machine and vendors it.
2. `gradle test` against it (the FFM `SymbolLookup` loads the vendored library
   via the `syncular.library.path` system property; `build.gradle.kts` sets the
   `--enable-native-access` / `--enable-preview` JVM args).

The tests are **hermetic and offline-first** — no server. Coverage mirrors the
Swift suite: init/create, raw command round-trip, mutate → readRows (the
optimistic row with `version == -1`), the query fast path, `{error}` surfacing as
`SyncularException`, the offline outbox (`pendingCommitIds`), a network command
reporting `transport.unavailable` on the lean core (`sync()` returns
`{ok:false, errorCode}` by design), the idle event poll, `close()` idempotence,
and a `pause()`/`resume()` cycle.

**Detect-and-skip:** the gate needs JDK 21+ and Gradle. On a machine without
them (e.g. a Command-Line-Tools-only mac, which ships a non-functional
`/usr/bin/java` stub) `check.sh` prints why and exits 0 — mirroring
`build-native.sh`'s doctrine. No `gradlew` wrapper is committed because
generating its jar itself needs Gradle; `check.sh` uses `./gradlew` if present,
else a system `gradle`.

## CI

Unlike Swift (which needs an expensive macOS runner and is a local-only gate),
the Kotlin/FFM gate is **cheap to compile-check on Ubuntu** with a JDK — so the
`swift-kotlin-bindings` job in `.github/workflows/v2.yml` sets up JDK 21, builds
the lean dylib, and runs `gradle test` on Linux. That exercises the real FFM
downcalls against the real native core.
