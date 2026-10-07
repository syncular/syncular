# Install & first sync (Kotlin)

Put `dev.syncular` and `libsyncular` on a JDK 21 or newer runtime, create a `SyncularClient`, and sync one row with the quickstart server.

::meta{for="Android and JVM developers adding Syncular to a Gradle project" time="15 minutes"}

:::terms
- **FFM**: The Foreign Function and Memory API (`java.lang.foreign`). It binds `libsyncular` without JNI glue.
- **`libsyncular`**: The Rust core built as a C library (`.dylib`, `.so`, or `.dll`).
- **Native transport**: The core's HTTP and WebSocket stack, compiled in by the `native-transport` feature.
:::

You need JDK 21 or newer, a Rust toolchain, Gradle, and a Syncular server (the [Quickstart](/quickstart/) server on port 8787 works). Declare a `kotlin` output in `syncular.json` so `syncular generate` emits `Syncular.generated.kt` ([Schema & typegen](/guide-schema/)).

:::figure{title="What FFM needs from the JVM" note="JDK 21 or newer only"}
<div class="d-row">
<div class="node"><span class="t">JDK 21</span>FFM is a preview API:<br><code>--enable-preview</code></div>
<span class="d-arrow"></span>
<div class="node ok"><span class="t">JDK 22+</span>FFM is stable;<br>the preview flag is harmless</div>
<span class="d-arrow"></span>
<div class="node bad"><span class="t">JDK 20 or older</span>unsupported, no fallback</div>
</div>
:::

::::::steps
:::::step{title="Build the core" time="5 min"}
```sh title="terminal"
rust/scripts/build-native.sh desktop
```

`build-native.sh` compiles with `native-transport` on, which `baseUrl` requires. `desktop` produces the host library; `android` produces `arm64-v8a` and `x86_64` `.so` files through `cargo-ndk`.

::checkpoint[`rust/target/native` holds `libsyncular.dylib`, `.so`, or `syncular.dll` for your host.]
:::::

:::::step{title="Add the library and JVM flags" time="5 min"}
`bindings/kotlin` is a Gradle project; add it to your build as an included build or a subproject. The JVM that runs the app needs the FFM flags, and the JVM that runs the tests needs them too:

```kotlin title="build.gradle.kts"
kotlin { jvmToolchain(21) }
tasks.withType<JavaExec>().configureEach {
    jvmArgs("--enable-preview", "--enable-native-access=ALL-UNNAMED")
    systemProperty("syncular.library.path", "/abs/path/libsyncular.dylib")
}
```

`--enable-native-access` silences the restricted-method warning for the FFM downcalls. [Platform specifics](/platform-kotlin-specifics/#library-loading) lists the load order.

::checkpoint[`import dev.syncular.*` compiles, and the JVM starts with both flags.]
:::::

:::::step{title="Create a client" time="3 min"}
```kotlin title="Sync.kt"
import dev.syncular.*

val client = SyncularClient.create(
    schema = SyncularSchema.schema,
    config = SyncularConfig(
        baseUrl = "http://localhost:8787",
        dbPath = "$appData/syncular.db",
    ),
)
```

`create` loads the library, sends `create` with your schema, and starts the poll thread. Pass `clientId =` for an explicit id; without it the core generates one and keeps it in the database. Use a file path for `dbPath`: an in-memory database loses the outbox on restart. [Native client API](/native-client-api/#configuration) lists every `SyncularConfig` field.

::checkpoint[`create` returns without throwing `SyncularException`.]
:::::

:::::step{title="Write and sync" time="3 min"}
```kotlin title="Sync.kt"
client.subscribe("todos", "todos", mapOf("list_id" to listOf("groceries")))
client.mutate(listOf(JsonValue.obj(
    "table" to JsonValue.of("todos"), "op" to JsonValue.of("upsert"),
    "values" to JsonValue.obj(
        "id" to JsonValue.of("t1"), "list_id" to JsonValue.of("groceries"),
        "title" to JsonValue.of("Buy milk"), "done" to JsonValue.of(false),
        "position" to JsonValue.of(1), "updated_at_ms" to JsonValue.of(1),
    ),
)))
println(client.syncUntilIdle())
println(client.pendingCommitIds())
```

::checkpoint[`pendingCommitIds()` prints `[]`, and the quickstart server holds the row. Run `bun run clients` from the quickstart to read it from a second client.]
:::::
::::::

Next: [Reads & writes](/platform-kotlin-reads-writes/).
