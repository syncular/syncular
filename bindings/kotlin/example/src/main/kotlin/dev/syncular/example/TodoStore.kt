package dev.syncular.example

import dev.syncular.JsonValue
import dev.syncular.SyncularClient
import dev.syncular.SyncularConfig
import java.util.UUID

/** One todo, projected out of a canonical quickstart `todos` row. */
data class Todo(val id: String, val title: String, val done: Boolean)

/** The demo's list scope. The quickstart server authorizes every list (`['*']`). */
const val DEMO_LIST_ID = "groceries"

/**
 * The whole syncular integration for the Kotlin todo demo, in one place — the
 * ~30-line surface the terminal app sits on. It talks to the quickstart
 * server's canonical `todos` table over the SyncularClient wrapper.
 *
 * The schema is NOT hand-built: `SyncularSchema.schema` and the typed `Todos`
 * row come from `Syncular.generated.kt`, produced by `syncular generate`
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
            table = SyncularSchema.Subscriptions.TodosInList.table,
            scopes = SyncularSchema.Subscriptions.TodosInList.scopes(listId = DEMO_LIST_ID),
        )
    }

    /** All todos in the list, id-ordered (the live-query fast path). This is a
     *  NAMED query: the SQL lives in `queries/list-todos.sql`, and typegen emits
     *  [SyncularSchemaQueries.listTodos] (typed `listId` param + the projection's
     *  own [ListTodosRow]) — no SQL string here, no drift. */
    fun todos(): List<Todo> =
        SyncularSchemaQueries.listTodos(client, listId = DEMO_LIST_ID)
            .map { todo ->
                Todo(id = todo.id, title = todo.title, done = todo.done)
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
        client.mutate(
            listOf(
                JsonValue.obj(
                    "op" to JsonValue.of("upsert"),
                    "table" to JsonValue.of("todos"),
                    "values" to JsonValue.obj(
                        "id" to JsonValue.of(id),
                        "list_id" to JsonValue.of(DEMO_LIST_ID),
                        "title" to JsonValue.of(title),
                        "done" to JsonValue.of(done),
                        "position" to JsonValue.of(now.toDouble()),
                        "updated_at_ms" to JsonValue.of(now.toDouble()),
                    ),
                ),
            ),
        )
    }
}
