import dev.syncular.client.SyncularBoltClient
import dev.syncular.client.SyncularBoltClientConfig
import java.io.File
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.long

private class BoltNativeClient(
    private val client: SyncularBoltClient,
) : SyncularNativeJsonClient {
    override fun applyMutationJson(mutationJson: String, localRowJson: String?): String =
        client.applyMutationJson(mutationJson, localRowJson)

    override fun enqueueMutationJson(mutationJson: String, localRowJson: String?): String =
        client.enqueueMutationJson(mutationJson, localRowJson)

    override fun openCrdtFieldJson(requestJson: String): String =
        client.openCrdtFieldJson(requestJson)

    override fun applyCrdtFieldTextJson(requestJson: String): String =
        client.applyCrdtFieldTextJson(requestJson)

    override fun applyCrdtFieldYjsUpdateJson(requestJson: String): String =
        client.applyCrdtFieldYjsUpdateJson(requestJson)

    override fun enqueueCrdtFieldYjsUpdateJson(requestJson: String): String =
        client.enqueueCrdtFieldYjsUpdateJson(requestJson)

    override fun enqueueCrdtFieldTextJson(requestJson: String): String =
        client.enqueueCrdtFieldTextJson(requestJson)

    override fun enqueueCrdtFieldCompactionJson(requestJson: String): String =
        client.enqueueCrdtFieldCompactionJson(requestJson)

    override fun materializeCrdtFieldJson(requestJson: String): String =
        client.materializeCrdtFieldJson(requestJson)

    override fun snapshotCrdtFieldStateVectorJson(requestJson: String): String =
        client.snapshotCrdtFieldStateVectorJson(requestJson)

    override fun compactCrdtFieldJson(requestJson: String): String =
        client.compactCrdtFieldJson(requestJson)

    override fun queryJson(requestJson: String): String =
        client.queryJson(requestJson)

    override fun registerQueryJson(queryJson: String): String =
        client.registerQueryJson(queryJson)

    override fun unregisterQuery(id: String): Boolean =
        client.unregisterQuery(id)
}

private data class NativeEventEnvelope(
    val event: SyncularNativeEvent,
    val json: JsonObject,
)

private fun expect(condition: Boolean, message: String) {
    if (!condition) error(message)
}

private val lifecycleJson = Json { ignoreUnknownKeys = true }

private fun removeSqliteFiles(path: String) {
    listOf("", "-wal", "-shm", "-journal").forEach { suffix ->
        File(path + suffix).delete()
    }
}

private fun waitForEvent(
    client: SyncularBoltClient,
    kind: String,
    commandId: String? = null,
    timeoutMs: Long = 5_000,
): NativeEventEnvelope {
    val deadline = System.currentTimeMillis() + timeoutMs
    val seen = mutableListOf<String>()
    while (System.currentTimeMillis() < deadline) {
        val eventJson = client.pollEventJsonTimeout(100uL) ?: continue
        val event = syncularDecodeNativeEvent(eventJson)
        val json = lifecycleJson.parseToJsonElement(eventJson).jsonObject
        seen += "${event.kind}:${event.commandId ?: "-"}"
        if (event.kind == kind && (commandId == null || event.commandId == commandId)) {
            return NativeEventEnvelope(event, json)
        }
    }
    error("timed out waiting for native event $kind command ${commandId ?: "-"}; seen ${seen.joinToString()}")
}

private fun JsonObject.str(key: String): String =
    this[key]?.jsonPrimitive?.content ?: error("missing string field $key")

private fun JsonObject.longValue(key: String): Long =
    this[key]?.jsonPrimitive?.long ?: error("missing integer field $key")

fun main(args: Array<String>) {
    val outDir = File(args.firstOrNull() ?: System.getProperty("java.io.tmpdir"))
    outDir.mkdirs()
    val dbPath = File(outDir, "kotlin-lifecycle-app.sqlite").absolutePath
    val blobPath = File(outDir, "kotlin-lifecycle-blob.txt")
    removeSqliteFiles(dbPath)
    blobPath.writeText("kotlin lifecycle blob")

    val raw = SyncularBoltClient(
        SyncularBoltClientConfig(
            dbPath = dbPath,
            baseUrl = "http://127.0.0.1:9/sync",
            clientId = "kotlin-lifecycle-app",
            actorId = "user-rust",
            projectId = "project-rust",
            appSchemaJson = syncularNativeGeneratedAppSchemaJson,
            autoSyncLocalWrites = false,
        ),
    )
    val client = BoltNativeClient(raw)
    try {
        val manifest = raw.runtimeManifestJson()
        expect(manifest.contains("\"storage_backend\":\"diesel-sqlite\""), "Kotlin lifecycle app should expose diesel sqlite manifest")
        expect(raw.setAuthHeadersJson("""{"authorization":"Bearer lifecycle-kotlin"}"""), "Kotlin lifecycle app should accept auth headers")
        expect(raw.syncWorkerRunning(), "Kotlin lifecycle app should keep native worker hot")

        val query = TaskQuery
            .select()
            .filter(TaskQuery.userId.eq("user-rust"))
            .orderBy(TaskQuery.serverVersion.desc())
            .limit(20)
        val live = query.liveQuery(id = "kotlin-lifecycle-live", label = "Kotlin lifecycle")
        expect(live.start(client).isEmpty(), "Kotlin lifecycle live query should start empty")

        val blobCommandId = raw.enqueueStoreBlobFileJson(
            blobPath.absolutePath,
            """{"mimeType":"text/plain"}""",
        )
        val blobEnvelope = waitForEvent(raw, kind = "WorkerCommandCompleted", commandId = blobCommandId)
        expect(blobEnvelope.event.commandId == blobCommandId, "Kotlin lifecycle blob event should carry command id")
        val blobPayload = blobEnvelope.json["payload_json"]!!.jsonObject
        val blobRef = SyncularBlobRef(
            hash = blobPayload.str("hash"),
            size = blobPayload.longValue("size"),
            mimeType = blobPayload.str("mimeType"),
        )

        val rowId = "task-kotlin-lifecycle"
        val mutationCommandId = client.enqueueNewTask(
            NewTask(
                id = rowId,
                title = "",
                completed = 0,
                userId = "user-rust",
                projectId = "project-rust",
                image = blobRef,
            ),
        )
        val mutationEvent = waitForEvent(raw, kind = "LocalWriteCommitted", commandId = mutationCommandId).event
        expect(mutationEvent.clientCommitId != null, "Kotlin lifecycle mutation event should carry commit id")

        val crdtCommandId = client.enqueueTaskTitleText(rowId = rowId, nextText = "Kotlin lifecycle title")
        val crdtWriteEvent = waitForEvent(raw, kind = "LocalWriteCommitted", commandId = crdtCommandId).event
        expect(crdtWriteEvent.commandId == crdtCommandId, "Kotlin lifecycle CRDT write should carry command id")
        val queryEvent = waitForEvent(raw, kind = "QueriesChanged").event
        waitForEvent(raw, kind = "CrdtFieldChanged", commandId = crdtCommandId)

        val rows = query.fetch(client)
        expect(rows.size == 1, "Kotlin lifecycle query should read queued row")
        expect(rows[0].id == rowId, "Kotlin lifecycle query should decode row id")
        expect(rows[0].title == "Kotlin lifecycle title", "Kotlin lifecycle query should decode CRDT title")
        expect(rows[0].image?.hash == blobRef.hash, "Kotlin lifecycle query should decode blob ref")
        expect(live.refreshIfChanged(queryEvent, client)?.size == 1, "Kotlin lifecycle live query should refresh from native event")

        val syncCommandId = raw.enqueueSyncNow()
        val syncEvent = waitForEvent(
            raw,
            kind = "SyncFailed",
            commandId = syncCommandId,
            timeoutMs = 8_000,
        ).event
        expect(syncEvent.commandId == syncCommandId, "Kotlin lifecycle sync failure should carry command id")

        val outbox = raw.outboxSummariesJson()
        expect(outbox.contains(mutationEvent.clientCommitId!!), "Kotlin lifecycle outbox should contain queued mutation")
        expect(outbox.contains(crdtWriteEvent.clientCommitId!!), "Kotlin lifecycle outbox should contain queued CRDT write")
        expect(live.stop(client), "Kotlin lifecycle live query should unregister")
        expect(raw.shutdown(), "Kotlin lifecycle app should shut down native client")

        println("Kotlin lifecycle app smoke passed")
    } finally {
        runCatching { raw.shutdown() }
        raw.close()
    }
}
