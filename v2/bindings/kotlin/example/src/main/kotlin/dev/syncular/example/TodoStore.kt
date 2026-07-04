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
 * The schema is NOT hand-built: `SyncularSchema.schema` and the typed `Notes`
 * row come from `Syncular.generated.kt`, produced by `syncular-v2 generate`
 * from this example's `syncular.json` + `migrations/` (check.sh gates its
 * freshness with `--check`).
 *
 * Everything below is plain wrapper calls: subscribe / mutate / query / sync.
 * No protocol logic lives here; the native core owns all of it.
 */
class TodoStore(clientId: String, baseUrl: String?) : AutoCloseable {
    private val client: SyncularClient = SyncularClient.create(
        clientId = clientId,
        schema = SyncularSchema.schema,
        config = SyncularConfig(
            baseUrl = baseUrl,
        ),
    )

    init {
        client.subscribe(
            id = "todos",
            table = SyncularSchema.Subscriptions.ListNotes.table,
            scopes = SyncularSchema.Subscriptions.ListNotes.scopes(listId = DEMO_LIST_ID),
        )
    }

    /** All todos in the list, id-ordered (the live-query fast path). Rows decode
     *  through the generated typed [Notes] row. */
    fun todos(): List<Todo> =
        client.query("SELECT id, list_id, body, updated_at_ms FROM notes ORDER BY id")
            .mapNotNull { row -> Notes.fromRow(row) }
            .map { note ->
                val done = note.body.startsWith("[x] ")
                // Strip the marker only when present, so foreign notes stay intact.
                val title = if (done || note.body.startsWith("[ ] ")) note.body.substring(4) else note.body
                Todo(id = note.id, title = title, done = done)
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
}
