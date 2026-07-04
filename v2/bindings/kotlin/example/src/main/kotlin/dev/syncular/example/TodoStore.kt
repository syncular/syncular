package dev.syncular.example

import dev.syncular.JsonValue
import dev.syncular.SyncularClient
import dev.syncular.SyncularConfig
import java.util.UUID

/** One todo, projected out of a `notes` row. */
data class Todo(val id: String, val title: String, val done: Boolean)

/** The demo's list scope. The quickstart server authorizes every list (`['*']`). */
const val DEMO_LIST_ID = "welcome"

/**
 * The whole syncular integration for the Kotlin todo demo, in one place — the
 * ~30-line surface the terminal app sits on. It talks to the quickstart
 * server's `notes` table (id, list_id, body, updated_at_ms) — the SAME schema
 * examples/quickstart ships and its TS clients use — over the SyncularClient
 * wrapper. A todo is a `notes` row: `body` carries the title, and done-state
 * rides as a leading "[x] " / "[ ] " marker (the quickstart schema has no
 * `done` column and the example is read-only, so completion is modeled in the
 * body — an honest fit, no schema fork).
 *
 * Everything below is plain wrapper calls: subscribe / mutate / query / sync.
 * No protocol logic lives here; the native core owns all of it.
 */
class TodoStore(clientId: String, baseUrl: String?) : AutoCloseable {
    private val client: SyncularClient = SyncularClient.create(
        clientId = clientId,
        schema = schema(),
        config = SyncularConfig(
            baseUrl = baseUrl,
        ),
    )

    init {
        client.subscribe(id = "todos", table = "notes", scopes = mapOf("list_id" to listOf(DEMO_LIST_ID)))
    }

    /** All todos in the list, id-ordered (the live-query fast path). */
    fun todos(): List<Todo> =
        client.query("SELECT id, body FROM notes ORDER BY id").map { row ->
            val body = row["body"]?.string ?: ""
            val done = body.startsWith("[x] ")
            // Strip the marker only when present, so foreign notes stay intact.
            val title = if (done || body.startsWith("[ ] ")) body.substring(4) else body
            Todo(id = row["id"]?.string ?: "", title = title, done = done)
        }

    /** Add a todo (optimistic — visible immediately, queued for the next sync). */
    fun add(title: String): Todo {
        val id = "todo-${UUID.randomUUID().toString().take(8)}"
        upsert(id, title, done = false)
        return Todo(id, title, done = false)
    }

    /** Toggle a todo's done flag (re-upserts the row with a flipped marker). */
    fun toggle(id: String) {
        val t = todos().firstOrNull { it.id == id } ?: return
        upsert(id, t.title, done = !t.done)
    }

    /** Push local writes and pull remote ones. True if the round synced. */
    fun sync(): Boolean = client.syncUntilIdle()["ok"]?.bool ?: false

    /** Unsynced local writes still in the outbox. */
    fun pendingCount(): Int = client.pendingCommitIds().size

    override fun close() = client.close()

    private fun upsert(id: String, title: String, done: Boolean) {
        val now = System.currentTimeMillis()
        val body = (if (done) "[x] " else "[ ] ") + title
        client.mutate(
            listOf(
                JsonValue.obj(
                    "op" to JsonValue.of("upsert"),
                    "table" to JsonValue.of("notes"),
                    "values" to JsonValue.obj(
                        "id" to JsonValue.of(id),
                        "list_id" to JsonValue.of(DEMO_LIST_ID),
                        "body" to JsonValue.of(body),
                        "updated_at_ms" to JsonValue.of(now.toDouble()),
                    ),
                ),
            ),
        )
    }

    companion object {
        /** The quickstart `notes` schema — matches examples/quickstart's
         *  generated schema (id, list_id, body, updated_at_ms; scoped by list). */
        private fun schema(): JsonValue = JsonValue.obj(
            "version" to JsonValue.of(1),
            "tables" to JsonValue.arr(
                listOf(
                    JsonValue.obj(
                        "name" to JsonValue.of("notes"),
                        "primaryKey" to JsonValue.of("id"),
                        "scopes" to JsonValue.arr(
                            listOf(
                                JsonValue.obj(
                                    "pattern" to JsonValue.of("list:{list_id}"),
                                    "column" to JsonValue.of("list_id"),
                                ),
                            ),
                        ),
                        "columns" to JsonValue.arr(
                            listOf(
                                col("id"), col("list_id"), col("body"), col("updated_at_ms", "integer"),
                            ),
                        ),
                    ),
                ),
            ),
        )

        private fun col(name: String, type: String = "string"): JsonValue = JsonValue.obj(
            "name" to JsonValue.of(name),
            "type" to JsonValue.of(type),
            "nullable" to JsonValue.of(false),
        )
    }
}
