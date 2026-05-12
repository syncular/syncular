import dev.syncular.client.SyncularBoltClient
import dev.syncular.client.SyncularBoltClientConfig
import java.io.File

private class BoltNativeClient(
    private val client: SyncularBoltClient,
) : SyncularNativeJsonClient {
    override fun applyMutationJson(mutationJson: String, localRowJson: String?): String =
        client.applyMutationJson(mutationJson, localRowJson)

    override fun queryJson(requestJson: String): String =
        client.queryJson(requestJson)

    override fun registerQueryJson(queryJson: String): String =
        client.registerQueryJson(queryJson)

    override fun unregisterQuery(id: String): Boolean =
        client.unregisterQuery(id)
}

private fun expect(condition: Boolean, message: String) {
    if (!condition) error(message)
}

private fun removeSqliteFiles(path: String) {
    listOf("", "-wal", "-shm", "-journal").forEach { suffix ->
        File(path + suffix).delete()
    }
}

private fun pollEvents(client: SyncularBoltClient, maxCount: Int = 8): List<SyncularNativeEvent> {
    val events = mutableListOf<SyncularNativeEvent>()
    while (events.size < maxCount) {
        val eventJson = client.pollEventJsonTimeout(0uL) ?: break
        events += syncularDecodeNativeEvent(eventJson)
    }
    return events
}

fun main(args: Array<String>) {
    val dbPath = args.firstOrNull()
        ?: File(System.getProperty("java.io.tmpdir"), "syncular-kotlin-bolt-host.sqlite").absolutePath
    removeSqliteFiles(dbPath)

    val raw = SyncularBoltClient(
        SyncularBoltClientConfig(
            dbPath = dbPath,
            baseUrl = "http://127.0.0.1:9/sync",
            clientId = "kotlin-bolt-host",
            actorId = "user-rust",
            projectId = "project-rust",
            autoSyncLocalWrites = false,
        ),
    )
    val client = BoltNativeClient(raw)
    try {
        val manifest = raw.runtimeManifestJson()
        expect(manifest.contains("\"storage_backend\":\"diesel-sqlite\""), "Kotlin host should expose diesel sqlite manifest")
        expect(manifest.contains("\"query-observer-events\""), "Kotlin host manifest should expose query observer events")
        expect(raw.setAuthHeadersJson("""{"authorization":"Bearer local-kotlin"}"""), "Kotlin host should accept auth headers")

        expect(raw.syncWorkerRunning(), "Kotlin host worker should start")
        expect(raw.pauseSyncWorker(), "Kotlin host worker should pause")
        expect(!raw.syncWorkerRunning(), "Kotlin host worker should report paused")
        expect(raw.resumeSyncWorker(), "Kotlin host worker should resume")
        expect(raw.syncWorkerRunning(), "Kotlin host worker should report running")
        expect(raw.pauseSyncWorker(), "Kotlin host worker should pause before offline local writes")

        val query = TaskQuery
            .select()
            .filter(TaskQuery.userId.eq("user-rust"))
            .orderBy(TaskQuery.serverVersion.desc())
            .limit(10)
        val live = query.liveQuery(id = "kotlin-bolt-live", label = "Kotlin host")
        val initialRows = live.start(client)
        expect(initialRows.isEmpty(), "Kotlin host live query should start empty")
        expect(raw.observedQueriesJson().contains("kotlin-bolt-live"), "Kotlin host should register observed query")

        val commitId = client.applyNewTask(
            NewTask(
                id = "task-kotlin-bolt",
                title = "Kotlin Bolt host",
                completed = 1,
                userId = "user-rust",
                projectId = "project-rust",
            ),
        )
        expect(commitId.isNotEmpty(), "Kotlin host mutation should return a commit id")

        val events = pollEvents(raw)
        expect(events.any { it.kind == "RowsChanged" && it.tables == listOf("tasks") }, "Kotlin host should emit task rows changed")
        expect(events.any { it.kind == "QueriesChanged" && it.queries == listOf("kotlin-bolt-live") }, "Kotlin host should emit live query changed")

        val rows = query.fetch(client)
        expect(rows.size == 1, "Kotlin host query should read inserted task")
        expect(rows[0].id == "task-kotlin-bolt", "Kotlin host query should decode inserted id")
        expect(rows[0].title == "Kotlin Bolt host", "Kotlin host query should decode inserted title")

        val queryEvent = events.first { it.kind == "QueriesChanged" }
        val refreshedRows = live.refreshIfChanged(queryEvent, client)
        expect(refreshedRows?.size == 1, "Kotlin host live query should refresh from native event")

        val outbox = raw.outboxSummariesJson()
        expect(outbox.contains(commitId), "Kotlin host outbox summaries should contain commit")
        expect(live.stop(client), "Kotlin host live query should unregister")
        expect(!raw.observedQueriesJson().contains("kotlin-bolt-live"), "Kotlin host should remove observed query")
        expect(raw.shutdown(), "Kotlin host should shut down native client")

        println("Kotlin generated Bolt host smoke passed")
    } finally {
        runCatching { raw.shutdown() }
        raw.close()
    }
}
