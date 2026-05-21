package dev.syncular.smoke

import android.content.Context
import dev.syncular.client.SyncularBoltClient
import dev.syncular.client.SyncularBoltClientConfig
import dev.syncular.client.generated.NewTask
import dev.syncular.client.generated.SyncularBlobRef
import dev.syncular.client.generated.SyncularNativeEvent
import dev.syncular.client.generated.SyncularNativeJsonClient
import dev.syncular.client.generated.TaskQuery
import dev.syncular.client.generated.enqueueTaskTitleText
import dev.syncular.client.generated.queuedMutations
import dev.syncular.client.generated.syncularDecodeNativeEvent
import dev.syncular.client.generated.syncularNativeGeneratedAppSchemaJson
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

    override fun applyLeasedMutationJson(mutationJson: String, localRowJson: String?): String =
        client.applyLeasedMutationJson(mutationJson, localRowJson)

    override fun enqueueMutationJson(mutationJson: String, localRowJson: String?): String =
        client.enqueueMutationJson(mutationJson, localRowJson)

    override fun enqueueLeasedMutationJson(mutationJson: String, localRowJson: String?): String =
        client.enqueueLeasedMutationJson(mutationJson, localRowJson)

    override fun diagnosticSnapshotJson(): String =
        client.diagnosticSnapshotJson()

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

private val lifecycleJson = Json { ignoreUnknownKeys = true }

private fun expect(condition: Boolean, message: String) {
    check(condition) { message }
}

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
        val eventJson = client.nextEventJsonTimeout(50uL) ?: continue
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

private data class HostMaintenancePolicy(
    val isForeground: Boolean,
    val allowsExpensiveNetwork: Boolean,
    val allowsBackgroundWork: Boolean,
    val remainingBackgroundBudgetMs: Long,
) {
    val canProcessBlobUploads: Boolean
        get() = allowsExpensiveNetwork && (isForeground || (allowsBackgroundWork && remainingBackgroundBudgetMs >= 2_000))

    val canRunCompaction: Boolean
        get() = isForeground || (allowsBackgroundWork && remainingBackgroundBudgetMs >= 1_000)
}

object SyncularAndroidLifecycleScenario {
    fun run(context: Context) {
        val outDir = File(context.filesDir, "syncular-android-lifecycle").also { it.mkdirs() }
        val dbPath = File(outDir, "android-lifecycle.sqlite").absolutePath
        val blobPath = File(outDir, "android-lifecycle-blob.txt")
        removeSqliteFiles(dbPath)
        blobPath.writeText("android lifecycle blob")

        val raw = SyncularBoltClient(
            SyncularBoltClientConfig(
                dbPath = dbPath,
                baseUrl = "http://127.0.0.1:9/sync",
                clientId = "android-lifecycle-app",
                actorId = "user-rust",
                projectId = "project-rust",
                appSchemaJson = syncularNativeGeneratedAppSchemaJson,
                autoSyncLocalWrites = false,
            ),
        )
        val client = BoltNativeClient(raw)
        try {
            expect(raw.startEventStream(256uL), "Android lifecycle should start native event stream")
            val manifest = raw.runtimeManifestJson()
            expect(manifest.contains("\"storage_backend\":\"diesel-sqlite\""), "Android app should expose diesel sqlite manifest")
            expect(raw.setAuthHeadersJson("""{"authorization":"Bearer lifecycle-android"}"""), "Android app should accept auth headers")
            expect(raw.syncWorkerRunning(), "Android app should keep native worker hot")

            val query = TaskQuery
                .select()
                .filter(TaskQuery.userId.eq("user-rust"))
                .orderBy(TaskQuery.serverVersion.desc())
                .limit(20)
            val live = query.liveQuery(id = "android-lifecycle-live", label = "Android lifecycle")
            expect(live.start(client).isEmpty(), "Android live query should start empty")

            val blobCommandId = raw.enqueueStoreBlobFileJson(
                blobPath.absolutePath,
                """{"mimeType":"text/plain"}""",
            )
            val blobEnvelope = waitForEvent(raw, kind = "WorkerCommandCompleted", commandId = blobCommandId)
            expect(blobEnvelope.event.commandId == blobCommandId, "Android blob event should carry command id")
            val blobPayload = blobEnvelope.json["payload_json"]!!.jsonObject
            val blobRef = SyncularBlobRef(
                hash = blobPayload.str("hash"),
                size = blobPayload.longValue("size"),
                mimeType = blobPayload.str("mimeType"),
            )
            val blobStateEvent = waitForEvent(raw, kind = "BlobUploadsChanged").event
            expect(blobStateEvent.lifecycle?.blobUploads?.pending == 1L, "Android lifecycle should observe pending blob uploads")

            val rowId = "task-android-lifecycle"
            val mutationCommandId = client.queuedMutations.tasks.insert(
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
            expect(mutationEvent.clientCommitId != null, "Android mutation event should carry commit id")

            val crdtCommandId = client.enqueueTaskTitleText(rowId = rowId, nextText = "Android lifecycle title")
            val crdtWriteEvent = waitForEvent(raw, kind = "LocalWriteCommitted", commandId = crdtCommandId).event
            expect(crdtWriteEvent.commandId == crdtCommandId, "Android CRDT write should carry command id")
            val queryEvent = waitForEvent(raw, kind = "QueriesChanged").event
            waitForEvent(raw, kind = "CrdtFieldChanged", commandId = crdtCommandId)

            val rows = query.fetch(client)
            expect(rows.size == 1, "Android query should read queued row")
            expect(rows[0].id == rowId, "Android query should decode row id")
            expect(rows[0].title == "Android lifecycle title", "Android query should decode CRDT title")
            expect(rows[0].image?.hash == blobRef.hash, "Android query should decode blob ref")
            expect(live.refreshIfChanged(queryEvent, client)?.size == 1, "Android live query should refresh from native event")

            val syncCommandId = raw.resumeFromBackground()
            val syncEvent = waitForEvent(
                raw,
                kind = "SyncFailed",
                commandId = syncCommandId,
                timeoutMs = 8_000,
            ).event
            expect(syncEvent.commandId == syncCommandId, "Android foreground resume sync failure should carry command id")

            val outbox = raw.outboxSummariesJson()
            expect(outbox.contains(mutationEvent.clientCommitId!!), "Android outbox should contain queued mutation")
            expect(outbox.contains(crdtWriteEvent.clientCommitId!!), "Android outbox should contain queued CRDT write")

            val restrictedBackground = HostMaintenancePolicy(
                isForeground = false,
                allowsExpensiveNetwork = false,
                allowsBackgroundWork = false,
                remainingBackgroundBudgetMs = 0,
            )
            expect(!restrictedBackground.canProcessBlobUploads, "Android restricted background policy should not process blob uploads")
            expect(!restrictedBackground.canRunCompaction, "Android restricted background policy should not run compaction")

            val foregroundPolicy = HostMaintenancePolicy(
                isForeground = true,
                allowsExpensiveNetwork = true,
                allowsBackgroundWork = false,
                remainingBackgroundBudgetMs = 0,
            )
            if (foregroundPolicy.canProcessBlobUploads) {
                val uploadCommandId = raw.enqueueProcessBlobUploadQueue()
                val uploadEvent = waitForEvent(
                    raw,
                    kind = "WorkerCommandCompleted",
                    commandId = uploadCommandId,
                    timeoutMs = 8_000,
                ).event
                expect(uploadEvent.commandId == uploadCommandId, "Android queued blob upload processing should carry command id")
            }
            if (foregroundPolicy.canRunCompaction) {
                val compactCommandId = raw.enqueueCompactStorageJson("""{"olderThanMs":0}""")
                val compactEvent = waitForEvent(raw, kind = "WorkerCommandCompleted", commandId = compactCommandId).event
                expect(compactEvent.commandId == compactCommandId, "Android queued compaction should carry command id")
            }

            expect(live.stop(client), "Android live query should unregister")
            expect(raw.shutdown(), "Android app should shut down native client")
        } finally {
            runCatching { raw.shutdown() }
            raw.close()
        }
    }
}
