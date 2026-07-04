package dev.syncular

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertNotNull
import kotlin.test.assertTrue

/**
 * Hermetic, offline-first tests for the Kotlin wrapper against the LOCALLY-built
 * libsyncular (check.sh builds it and passes its path via
 * `syncular.library.path`). No server — syncular is offline-first by design: a
 * `mutate` is optimistic and immediately visible via readRows/query.
 *
 * Coverage mirrors the Swift suite: init/create, command round-trip, mutate →
 * readRows (optimistic row), the query fast path, error surfacing, the offline
 * outbox, a network command reporting transport.unavailable on the lean core,
 * event-poll (none pending), close idempotence, and pause/resume.
 */
class SyncularClientTest {
    private fun todoSchema(): JsonValue = JsonValue.obj(
        "version" to JsonValue.of(1),
        "tables" to JsonValue.arr(
            listOf(
                JsonValue.obj(
                    "name" to JsonValue.of("todo"),
                    "primaryKey" to JsonValue.of("id"),
                    "scopes" to JsonValue.arr(emptyList()),
                    "columns" to JsonValue.arr(
                        listOf(
                            JsonValue.obj(
                                "name" to JsonValue.of("id"),
                                "type" to JsonValue.of("string"),
                                "nullable" to JsonValue.of(false),
                            ),
                            JsonValue.obj(
                                "name" to JsonValue.of("title"),
                                "type" to JsonValue.of("string"),
                                "nullable" to JsonValue.of(false),
                            ),
                        ),
                    ),
                ),
            ),
        ),
    )

    private fun makeClient(): SyncularClient =
        SyncularClient.create(clientId = "kotlin-test", schema = todoSchema())

    private fun upsert(id: String, title: String): JsonValue = JsonValue.obj(
        "op" to JsonValue.of("upsert"),
        "table" to JsonValue.of("todo"),
        "values" to JsonValue.obj("id" to JsonValue.of(id), "title" to JsonValue.of(title)),
    )

    @Test
    fun initCreatesClient() {
        makeClient().use { client ->
            client.subscribe(id = "s1", table = "todo")
            assertEquals("active", client.subscriptionState("s1"))
        }
    }

    @Test
    fun mutateThenReadRowsShowsOptimisticRow() {
        makeClient().use { client ->
            client.subscribe(id = "s1", table = "todo")
            val commitId = client.mutate(listOf(upsert("t1", "hello")))
            assertTrue(commitId.isNotEmpty())

            // Offline-first: the row is visible immediately.
            val rows = client.readRows("todo")
            assertEquals(1, rows.size)
            assertEquals("hello", rows[0]["values"]?.get("title")?.string)
            assertEquals(-1.0, rows[0]["version"]?.number)
        }
    }

    @Test
    fun queryFastPath() {
        makeClient().use { client ->
            client.subscribe(id = "s1", table = "todo")
            client.mutate(listOf(upsert("t1", "world")))
            val rows = client.query("SELECT title FROM todo WHERE id = ?", listOf(JsonValue.of("t1")))
            assertEquals(1, rows.size)
            assertEquals("world", rows[0]["title"]?.string)
        }
    }

    @Test
    fun rawCommandRoundTrip() {
        makeClient().use { client ->
            val result = client.command(
                "subscribe",
                JsonValue.obj(
                    "id" to JsonValue.of("s2"),
                    "table" to JsonValue.of("todo"),
                    "scopes" to JsonValue.Obj(emptyMap()),
                ),
            )
            assertNotNull(result.obj)
        }
    }

    @Test
    fun errorReplySurfacesAsSyncularException() {
        makeClient().use { client ->
            assertFailsWith<SyncularException> { client.readRows("does_not_exist") }
        }
    }

    @Test
    fun pendingCommitsAfterOfflineMutate() {
        makeClient().use { client ->
            client.subscribe(id = "s1", table = "todo")
            client.mutate(listOf(upsert("t1", "x")))
            assertTrue(client.pendingCommitIds().isNotEmpty())
        }
    }

    @Test
    fun networkCommandReportsTransportUnavailableOnLeanCore() {
        makeClient().use { client ->
            // Lean core: sync() never errors out-of-band — it returns
            // {ok:false, errorCode} so the caller sees the failed round.
            val outcome = client.sync()
            assertEquals(false, outcome["ok"]?.bool)
            assertTrue(outcome["errorCode"]?.string?.contains("transport") == true)
        }
    }

    @Test
    fun pollEventDeliversNothingWhenIdle() {
        makeClient().use { client ->
            val count = java.util.concurrent.atomic.AtomicInteger(0)
            client.listener = SyncularEventListener { count.incrementAndGet() }
            Thread.sleep(300)
            assertEquals(0, count.get())
        }
    }

    @Test
    fun closeIsIdempotentAndCommandsThrowAfter() {
        val client = makeClient()
        client.close()
        client.close() // idempotent
        val error = assertFailsWith<SyncularException> { client.readRows("todo") }
        assertEquals("client.closed", error.code)
    }

    @Test
    fun pauseResumeStopsAndRestartsPollLoop() {
        makeClient().use { client ->
            client.pause()
            client.resume()
            client.subscribe(id = "s1", table = "todo")
            assertEquals("active", client.subscriptionState("s1"))
        }
    }
}
