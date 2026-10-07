# Kotlin (Android & JVM)

`SyncularClient` gives a Kotlin app a local SQLite replica, an outbox, and a sync loop. This page shows the shape of the SDK and a first sync in six calls; the sub-pages cover install, daily use, lifecycle, platform details, and fixes.

::meta{for="Android and JVM developers" time="4 minutes"}

| Property | Value |
|---|---|
| **Runs on** | JDK 21 or newer on desktop and server JVMs; Android through an AAR with `jniLibs` |
| **Package** | `dev.syncular`, a Gradle project in [`bindings/kotlin`](https://github.com/syncular/syncular/tree/main/bindings/kotlin) (`kotlin("jvm")`, Kotlin 2.4.20) |
| **Core** | Rust core through the C ABI, bound with FFM (`java.lang.foreign`); no JNI glue |
| **Threading** | Call from any thread; an internal lock serializes commands. Events arrive on the `syncular-poll` thread |
| **Reading time** | 4 minutes here, about 20 for the full set |

:::figure{title="How Kotlin reaches the core" note="The JDK is the only runtime dependency" ticks}
<div class="d-row">
<div class="node hot"><span class="t">Your app</span>Android or JVM<br>typed rows from typegen</div>
<span class="d-arrow"></span>
<div class="node"><span class="t">dev.syncular</span><code>SyncularClient</code><br>command lock, poll thread</div>
<span class="d-arrow"></span>
<div class="node cool"><span class="t">FFM downcalls</span><code>SyncularFfi</code> binds the<br>5 C functions</div>
<span class="d-arrow"></span>
<div class="node ok"><span class="t">libsyncular</span>Rust core<br>SQLite, native transport</div>
</div>

::caption[The three native SDKs share this model. [Native client API](/native-client-api/) documents the shared half.]
:::

## First sync

The calls below assume the library is on the classpath and `libsyncular` is loadable ([Install & first sync](/platform-kotlin-install/)), and `syncular generate` emitted `Syncular.generated.kt`.

```kotlin
import dev.syncular.*

val client = SyncularClient.create(
    schema = SyncularSchema.schema,
    config = SyncularConfig(baseUrl = "http://localhost:8787", dbPath = dbPath),
)
client.subscribe("todos", "todos", mapOf("list_id" to listOf("groceries")))
client.mutate(listOf(JsonValue.obj(
    "table" to JsonValue.of("todos"), "op" to JsonValue.of("upsert"),
    "values" to JsonValue.obj(
        "id" to JsonValue.of("t1"), "list_id" to JsonValue.of("groceries"),
        "title" to JsonValue.of("Buy milk"), "done" to JsonValue.of(false),
        "position" to JsonValue.of(1), "updated_at_ms" to JsonValue.of(1),
    ),
)))
client.syncUntilIdle()
println(client.query("SELECT id, title FROM todos"))
```

`mutate` is visible to `query` at once. `syncUntilIdle` pushes the outbox and pulls the subscribed list, so a second device with the same subscription reads `t1`.

## The pages

- **[Install & first sync](/platform-kotlin-install/)**: JDK flags, loading the core, and a first client.
- **[Reads & writes](/platform-kotlin-reads-writes/)**: subscribe, mutate, query, `JsonValue`, and collaborative text.
- **[Realtime & lifecycle](/platform-kotlin-realtime/)**: events, `pause()`, `resume()`, `close()`, and the Android connectivity adapter.
- **[Platform specifics](/platform-kotlin-specifics/)**: library loading, Android packaging, transport policy, and threading.
- **[Troubleshooting](/platform-kotlin-troubleshooting/)**: FFM errors, missing library, and offline results.

The behavior shared with Swift and Flutter (configuration, events, snapshot and outcome methods) is on [Native client API](/native-client-api/).
