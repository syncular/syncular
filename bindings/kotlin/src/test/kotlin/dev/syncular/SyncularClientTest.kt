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
 * close idempotence, and pause/resume.
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
    fun positionalConstructionKeepsDbPathAsTheFourthArgument() {
        // The original four-argument order (baseUrl, wsUrl, headers, dbPath)
        // must keep compiling, so the new policy fields are appended after it.
        val config =
            SyncularConfig("https://api.example.com", null, emptyMap(), "/tmp/replica.db")
        assertEquals("https://api.example.com", config.baseUrl)
        assertEquals("/tmp/replica.db", config.dbPath)
        assertEquals(null, config.requestTimeoutMs)
    }

    @Test
    fun nativeTransportPolicySerializesIntoTheCoreConfig() {
        val config = SyncularConfig(
            baseUrl = "https://api.example.com",
            requestTimeoutMs = 1000,
            roundDeadlineMs = 2000,
            maxRequestBytes = 1024,
            maxResponseBytes = 2048,
            redirects = "deny",
        ).newConfigJson()
        assertEquals(JsonValue.Num(1000.0), config["requestTimeoutMs"])
        assertEquals(JsonValue.Num(2000.0), config["roundDeadlineMs"])
        assertEquals(JsonValue.Num(1024.0), config["maxRequestBytes"])
        assertEquals(JsonValue.Num(2048.0), config["maxResponseBytes"])
        assertEquals(JsonValue.Str("deny"), config["redirects"])
    }

    @Test
    fun policyBoundsStayExactIntegersOnTheWire() {
        // 2^53 and 10^18 are configurable bounds; the serializer must not turn
        // them into an exponent form the core reads as a float and refuses.
        val config = SyncularConfig(
            baseUrl = "https://api.example.com",
            requestTimeoutMs = 9_007_199_254_740_992,
            maxRequestBytes = 1_000_000_000_000_000_000,
        ).newConfigJson()
        val encoded = config.encode()
        assertTrue(encoded.contains("\"requestTimeoutMs\":9007199254740992"), encoded)
        assertTrue(encoded.contains("\"maxRequestBytes\":1000000000000000000"), encoded)
    }

    @Test
    fun aPolicyBoundThatNeedsRoundingIsRefusedInsteadOfSerialized() {
        val error = assertFailsWith<IllegalArgumentException> {
            SyncularConfig(
                baseUrl = "https://api.example.com",
                maxResponseBytes = 9_007_199_254_740_993,
            ).newConfigJson()
        }
        assertTrue(error.message!!.contains("maxResponseBytes"), error.message!!)
    }

    @Test
    fun localAuthorityPathSerializesIntoTheCoreConfig() {
        val config = SyncularConfig(localAuthorityPath = "/data/authority.sqlite").newConfigJson()
        assertEquals(JsonValue.Str("/data/authority.sqlite"), config["localAuthorityPath"])
        assertEquals(null, SyncularConfig().newConfigJson()["localAuthorityPath"])
    }

    @Test
    fun emptyLocalAuthorityPathIsRejectedByTheCoreConfig() {
        val error = assertFailsWith<SyncularException> {
            SyncularClient.create(schema = todoSchema(), config = SyncularConfig(localAuthorityPath = ""))
        }
        assertEquals("client.failed", error.code)
    }

    @Test
    fun localAuthorityCommandsWithoutAuthorityPathReportUnconfigured() {
        makeClient().use { client ->
            assertEquals(null, client.localAuthorityState())
            val attach = assertFailsWith<SyncularException> { client.attachLocalAuthority() }
            assertEquals("client.local_authority_unconfigured", attach.code)
            val abandon = assertFailsWith<SyncularException> { client.abandonLocalAuthorityAttach() }
            assertEquals("client.local_authority_unconfigured", abandon.code)
        }
    }

    @Test
    fun localAuthorityServesRoundsInProcess() {
        val directory = java.nio.file.Files.createTempDirectory("syncular-authority")
        try {
            // The authority serves only scoped tables (SPEC §3.1).
            val column = { name: String ->
                JsonValue.obj("name" to JsonValue.of(name), "type" to JsonValue.of("string"), "nullable" to JsonValue.of(false))
            }
            val schema = JsonValue.obj(
                "version" to JsonValue.of(1),
                "tables" to JsonValue.arr(
                    listOf(
                        JsonValue.obj(
                            "name" to JsonValue.of("todo"),
                            "primaryKey" to JsonValue.of("id"),
                            "scopes" to JsonValue.arr(
                                listOf(JsonValue.obj("pattern" to JsonValue.of("list:{list_id}"), "column" to JsonValue.of("list_id"))),
                            ),
                            "columns" to JsonValue.arr(listOf(column("id"), column("list_id"))),
                        ),
                    ),
                ),
            )
            SyncularClient.create(
                clientId = "kotlin-authority",
                schema = schema,
                config = SyncularConfig(localAuthorityPath = directory.resolve("authority.sqlite").toString()),
            ).use { client ->
                assertEquals(SyncularClient.LocalAuthorityState.LOCAL, client.localAuthorityState())
                client.subscribe(id = "s1", table = "todo", scopes = mapOf("list_id" to listOf("l1")))
                client.mutate(
                    listOf(
                        JsonValue.obj(
                            "op" to JsonValue.of("upsert"),
                            "table" to JsonValue.of("todo"),
                            "values" to JsonValue.obj("id" to JsonValue.of("t1"), "list_id" to JsonValue.of("l1")),
                        ),
                    ),
                )
                client.syncUntilIdle()
                assertEquals(emptyList<String>(), client.pendingCommitIds())
                // The authority acknowledged the commit: the row carries a server version.
                assertEquals(1.0, client.readRows("todo")[0]["version"]?.number)
            }
        } finally {
            directory.toFile().deleteRecursively()
        }
    }

    @Test
    fun exceptionCarriesStructuredDetails() {
        val details = JsonValue.obj("reason" to JsonValue.of("r"))
        val error = SyncularException("sync.attach_rejected", "m", details)
        assertEquals(details, error.details)
        assertEquals(null, SyncularException("x", "m").details)
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
    fun rotatesTransportHeadersWithoutRecreatingTheClient() {
        makeClient().use { client ->
            client.setHeaders(mapOf("authorization" to "Bearer fresh"))
            client.subscribe(id = "after-rotation", table = "todo")
            assertEquals("active", client.subscriptionState("after-rotation"))
        }
    }

    @Test
    fun connectivityAdapterPausesResumesAndDetaches() {
        makeClient().use { client ->
            var listener: ((Boolean) -> Unit)? = null
            val signal = AndroidConnectivitySignal(
                current = { false },
                observe = { callback ->
                    listener = callback
                    SyncularConnectivitySubscription { listener = null }
                },
            )
            val adapter = SyncularConnectivityAdapter(client, signal)
            assertNotNull(listener)
            listener?.invoke(true)
            client.subscribe(id = "after-connectivity", table = "todo")
            adapter.close()
            assertEquals(null, listener)
        }
    }

    @Test
    fun errorReplySurfacesAsSyncularException() {
        makeClient().use { client ->
            assertFailsWith<SyncularException> { client.readRows("does_not_exist") }
        }
    }

    @Test
    fun snapshotsAndPendingOutcomesAfterOfflineMutate() {
        makeClient().use { client ->
            client.subscribe(id = "s1", table = "todo")
            val id = client.mutate(listOf(upsert("t1", "x")))
            assertEquals(listOf(id), client.pendingCommitIds())
            assertEquals(1.0, client.statusSnapshot()["outbox"]?.number)
            assertEquals(1, client.querySnapshot("SELECT title FROM todo")["rows"]?.array?.size)
            assertEquals(1.0, client.diagnosticsSnapshot()["replica"]?.get("pendingOutbox")?.number)
            assertEquals(null, client.commitOutcome(id))
            assertTrue(client.commitOutcomes().isEmpty())
            assertTrue(client.rejections().isEmpty())
            assertFailsWith<SyncularException> {
                client.resolveCommitOutcome(JsonValue.obj("clientCommitId" to JsonValue.of(id), "resolution" to JsonValue.of("dismissed")))
            }
            for (method in listOf("schemaFloor", "leaseState", "upgrading", "syncNeeded")) {
                assertFailsWith<SyncularException> { client.command(method, JsonValue.Obj(emptyMap())) }
            }
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
