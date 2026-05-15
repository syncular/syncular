import dev.syncular.client.SyncularBoltClient
import dev.syncular.client.SyncularBoltClientConfig
import java.io.File
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonArray
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

private fun expect(condition: Boolean, message: String) {
    if (!condition) error(message)
}

private fun removeSqliteFiles(path: String) {
    for (suffix in listOf("", "-wal", "-shm", "-journal")) {
        File(path + suffix).delete()
    }
}

private fun setAuthorization(client: SyncularBoltClient, authorization: String, message: String) {
    expect(
        client.setAuthHeadersJson("""{"authorization":${smokeJsonString(authorization)}}"""),
        message,
    )
}

private fun configureServerSync(
    client: SyncularBoltClient,
    info: JsonObject,
    authorization: String = info.str("authorization"),
    actorId: String = info.str("actorId"),
) {
    setAuthorization(
        client,
        authorization,
        "Kotlin server sync client should accept auth headers",
    )
    expect(
        client.setSubscriptionsJson(
            syncularSubscriptionsJson(
                listOf(
                    taskSubscription(
                        SyncularSubscriptionArgs(
                            actorId = actorId,
                            projectId = info.optionalString("projectId"),
                        ),
                    ),
                ),
            ),
        ),
        "Kotlin server sync client should accept subscriptions",
    )
}

private fun configureFieldEncryption(client: SyncularBoltClient, e2ee: JsonObject, message: String) {
    val rule = e2ee["rule"]?.jsonObject ?: error("missing E2EE rule")
    expect(
        client.setFieldEncryptionJson(
            syncularGeneratedFieldEncryptionConfigJson(
                keys = mapOf("default" to e2ee.str("keyBase64")),
                envelopePrefix = e2ee.str("envelopePrefix"),
                additionalRules = listOf(
                    SyncularFieldEncryptionRule(
                        scope = rule.str("scope"),
                        table = rule.optionalString("table"),
                        fields = rule["fields"]?.jsonArray?.map { it.jsonPrimitive.content }
                            ?: error("missing E2EE rule fields"),
                        rowIdField = rule.optionalString("rowIdField"),
                    ),
                ),
            ),
        ),
        message,
    )
}

private fun JsonObject.str(key: String): String =
    this[key]?.jsonPrimitive?.content ?: error("missing server info string $key")

private fun JsonObject.optionalString(key: String): String? {
    val value = this[key] ?: return null
    if (value is JsonNull) return null
    return value.jsonPrimitive.contentOrNull
}

private fun JsonObject.longValue(key: String): Long =
    this[key]?.jsonPrimitive?.long ?: error("missing server info integer $key")

private fun queryTaskRowsById(client: SyncularBoltClient, id: String) =
    Json.parseToJsonElement(
        client.queryJson(
            TaskQuery
                .select()
                .filter(TaskQuery.id.eq(id))
                .readonlyQuery()
                .toJsonString(),
        ),
    ).jsonObject["rows"]?.jsonArray ?: error("missing server sync query rows")

private fun conflictSummaries(client: SyncularBoltClient) =
    Json.parseToJsonElement(client.conflictSummariesJson()).jsonArray

private fun blobRefFromJson(json: String): SyncularBlobRef {
    val payload = Json.parseToJsonElement(json).jsonObject
    return SyncularBlobRef(
        hash = payload.str("hash"),
        size = payload.longValue("size"),
        mimeType = payload.str("mimeType"),
    )
}

private fun blobRefObjectFromQueryValue(value: kotlinx.serialization.json.JsonElement): JsonObject =
    when (value) {
        is JsonObject -> value
        is JsonPrimitive -> Json.parseToJsonElement(value.content).jsonObject
        else -> error("unexpected blob ref JSON value")
    }

private fun expectUploadResult(actual: JsonObject, expected: JsonObject, message: String) {
    expect(actual.longValue("uploaded") == expected.longValue("uploaded"), "$message uploaded count")
    expect(actual.longValue("failed") == expected.longValue("failed"), "$message failed count")
}

private fun expectUploadStats(actual: JsonObject, expected: JsonObject, message: String) {
    expect(actual.longValue("pending") == expected.longValue("pending"), "$message pending count")
    expect(actual.longValue("uploading") == expected.longValue("uploading"), "$message uploading count")
    expect(actual.longValue("failed") == expected.longValue("failed"), "$message failed count")
}

private fun smokeJsonString(value: String): String = buildString {
    append('"')
    for (ch in value) {
        when (ch) {
            '\\' -> append("\\\\")
            '"' -> append("\\\"")
            '\n' -> append("\\n")
            '\r' -> append("\\r")
            '\t' -> append("\\t")
            else -> append(ch)
        }
    }
    append('"')
}

private fun waitForEvent(
    client: SyncularBoltClient,
    kind: String,
    commandId: String?,
    timeoutMs: Long = 5_000,
): SyncularNativeEvent = waitForEventJson(client, kind, commandId, timeoutMs).first

private fun waitForEventJson(
    client: SyncularBoltClient,
    kind: String,
    commandId: String?,
    timeoutMs: Long = 5_000,
): Pair<SyncularNativeEvent, String> {
    val deadline = System.currentTimeMillis() + timeoutMs
    while (System.currentTimeMillis() < deadline) {
        val eventJson = client.nextEventJson() ?: continue
        val event = syncularDecodeNativeEvent(eventJson)
        if (event.kind == kind && (commandId == null || event.commandId == commandId)) {
            return event to eventJson
        }
    }
    error("Timed out waiting for $kind")
}

private fun createServerConflict(
    client: SyncularBoltClient,
    info: JsonObject,
    conflict: JsonObject,
    label: String,
): JsonObject {
    val writeCommandId = client.enqueueMutationJson(
        SyncularAppOperations.patchTask(
            rowId = conflict.str("rowId"),
            patch = TaskPatch(
                title = conflict.str("localTitle"),
                completed = 0L,
                userId = info.str("actorId"),
            ),
            baseVersion = conflict.longValue("staleBaseVersion"),
        ).toJsonString(),
        null,
    )
    waitForEvent(client, kind = "LocalWriteCommitted", commandId = writeCommandId)
    val syncCommandId = client.enqueueSyncNow()
    waitForEvent(client, kind = "SyncCompleted", commandId = syncCommandId)
    val conflicts = conflictSummaries(client)
    expect(
        conflicts.size == conflict.longValue("expectedInitialConflictCount").toInt(),
        "$label should persist one conflict",
    )
    val conflictSummary = conflicts[0].jsonObject
    expect(conflictSummary.str("result_status") == "conflict", "$label conflict should keep result status")
    expect(conflictSummary.optionalString("code") == conflict.str("conflictCode"), "$label conflict should keep code")
    expect(
        conflictSummary.longValue("server_version") == conflict.longValue("serverVersion"),
        "$label conflict should keep server version",
    )
    return conflictSummary
}

fun main(args: Array<String>) {
    val dbPath = args.getOrNull(0) ?: error("usage: ServerSyncSmoke <db-path> <server-info-json>")
    val infoPath = args.getOrNull(1) ?: error("usage: ServerSyncSmoke <db-path> <server-info-json>")
    removeSqliteFiles(dbPath)

    val info = Json.parseToJsonElement(File(infoPath).readText()).jsonObject
    val task = info["task"]?.jsonObject ?: error("missing server task")
    val conflictsInfo = info["conflicts"]?.jsonObject ?: error("missing server conflicts")
    val conflict = conflictsInfo["kotlin"]?.jsonObject
        ?: error("missing Kotlin server conflict")
    val keepServerConflict = conflictsInfo["kotlinKeepServer"]?.jsonObject
        ?: error("missing Kotlin keep-server conflict")
    val dismissConflict = conflictsInfo["kotlinDismiss"]?.jsonObject
        ?: error("missing Kotlin dismiss conflict")
    val schemaVersion = info["schemaVersion"]?.jsonObject ?: error("missing schema version server info")
    val ownerConflict = info["ownerConflict"]?.jsonObject ?: error("missing owner conflict server info")
    val e2ee = info["e2ee"]?.jsonObject ?: error("missing E2EE server info")
    val e2eeTask = e2ee["kotlinTask"]?.jsonObject ?: error("missing Kotlin E2EE task")
    val blob = info["blob"]?.jsonObject ?: error("missing blob server info")
    val client = SyncularBoltClient.openAsync(
        SyncularBoltClientConfig(
            dbPath = dbPath,
            baseUrl = info.str("baseUrl"),
            clientId = "kotlin-native-server-sync",
            actorId = info.str("actorId"),
            projectId = info.optionalString("projectId"),
            appSchemaJson = syncularNativeGeneratedAppSchemaJson,
            autoSyncLocalWrites = false,
        ),
    )

    try {
        expect(client.finishOpenTimeout(timeoutMs = 5_000uL), "Kotlin server sync client should open")
        expect(client.startEventStream(256uL), "Kotlin server sync client should start native event stream")

        val staleAuthorization = info.optionalString("staleAuthorization") ?: "Bearer stale-native"
        configureServerSync(client, info, authorization = staleAuthorization)
        val staleCommandId = client.enqueueSyncNow()
        val staleEvent = waitForEvent(client, kind = "AuthExpired", commandId = staleCommandId)
        expect(staleEvent.commandId == staleCommandId, "Kotlin auth expired event should carry command id")
        setAuthorization(
            client,
            info.str("authorization"),
            "Kotlin server sync client should accept refreshed auth headers",
        )

        val commandId = client.enqueueSyncNow()
        val event = waitForEvent(client, kind = "SyncCompleted", commandId = commandId)
        expect(event.commandId == commandId, "Kotlin server sync event should carry command id")

        val rows = queryTaskRowsById(client, task.str("id"))
        expect(rows.size == 1, "Kotlin server sync should pull one task")
        val row = rows[0].jsonObject
        expect(row.str("title") == task.str("title"), "Kotlin server sync should decode pulled title")
        expect(row.longValue("server_version") == task.longValue("serverVersion"), "Kotlin server sync should decode server version")

        configureServerSync(client, info, actorId = info.str("revokedActorId"))
        val revokedCommandId = client.enqueueSyncNow()
        waitForEvent(client, kind = "SyncCompleted", commandId = revokedCommandId)
        val revokedRows = queryTaskRowsById(client, task.str("id"))
        expect(revokedRows.isEmpty(), "Kotlin server sync should clear rows for revoked subscription")
        configureServerSync(client, info)
        val restoredCommandId = client.enqueueSyncNow()
        waitForEvent(client, kind = "SyncCompleted", commandId = restoredCommandId)
        val restoredRows = queryTaskRowsById(client, task.str("id"))
        expect(restoredRows.size == 1, "Kotlin server sync should restore rows after subscription scope returns")

        val requiredSchemaDbPath = "$dbPath.required-schema"
        removeSqliteFiles(requiredSchemaDbPath)
        val requiredSchemaClient = SyncularBoltClient.openAsync(
            SyncularBoltClientConfig(
                dbPath = requiredSchemaDbPath,
                baseUrl = schemaVersion.str("requiredFutureBaseUrl"),
                clientId = "kotlin-native-required-schema",
                actorId = info.str("actorId"),
                projectId = info.optionalString("projectId"),
                appSchemaJson = syncularNativeGeneratedAppSchemaJson,
                autoSyncLocalWrites = false,
            ),
        )
        try {
            expect(requiredSchemaClient.finishOpenTimeout(timeoutMs = 5_000uL), "Kotlin required-schema client should open")
            expect(requiredSchemaClient.startEventStream(256uL), "Kotlin required-schema client should start native event stream")
            configureServerSync(requiredSchemaClient, info)
            val requiredSchemaCommandId = requiredSchemaClient.enqueueSyncNow()
            val (requiredSchemaEvent, requiredSchemaJson) = waitForEventJson(
                requiredSchemaClient,
                kind = "SyncFailed",
                commandId = requiredSchemaCommandId,
            )
            expect(requiredSchemaEvent.commandId == requiredSchemaCommandId, "Kotlin required-schema failure should carry command id")
            expect(
                requiredSchemaJson.contains(schemaVersion.str("expectedRequiredErrorPattern")),
                "Kotlin required-schema failure should expose schema error",
            )
        } finally {
            requiredSchemaClient.shutdown()
        }

        val latestSchemaDbPath = "$dbPath.latest-schema"
        removeSqliteFiles(latestSchemaDbPath)
        val latestSchemaClient = SyncularBoltClient.openAsync(
            SyncularBoltClientConfig(
                dbPath = latestSchemaDbPath,
                baseUrl = schemaVersion.str("latestFutureBaseUrl"),
                clientId = "kotlin-native-latest-schema",
                actorId = info.str("actorId"),
                projectId = info.optionalString("projectId"),
                appSchemaJson = syncularNativeGeneratedAppSchemaJson,
                autoSyncLocalWrites = false,
            ),
        )
        try {
            expect(latestSchemaClient.finishOpenTimeout(timeoutMs = 5_000uL), "Kotlin latest-schema client should open")
            expect(latestSchemaClient.startEventStream(256uL), "Kotlin latest-schema client should start native event stream")
            configureServerSync(latestSchemaClient, info)
            val latestSchemaCommandId = latestSchemaClient.enqueueSyncNow()
            waitForEvent(latestSchemaClient, kind = "SyncCompleted", commandId = latestSchemaCommandId)
        } finally {
            latestSchemaClient.shutdown()
        }

        val ownerConflictClientId = "kotlin-native-owner-conflict"
        val ownerFirstDbPath = "$dbPath.owner-first"
        removeSqliteFiles(ownerFirstDbPath)
        val ownerFirst = SyncularBoltClient.openAsync(
            SyncularBoltClientConfig(
                dbPath = ownerFirstDbPath,
                baseUrl = info.str("baseUrl"),
                clientId = ownerConflictClientId,
                actorId = info.str("actorId"),
                projectId = info.optionalString("projectId"),
                appSchemaJson = syncularNativeGeneratedAppSchemaJson,
                autoSyncLocalWrites = false,
            ),
        )
        try {
            expect(ownerFirst.finishOpenTimeout(timeoutMs = 5_000uL), "Kotlin owner-conflict first client should open")
            expect(ownerFirst.startEventStream(256uL), "Kotlin owner-conflict first client should start native event stream")
            configureServerSync(ownerFirst, info)
            val ownerFirstCommandId = ownerFirst.enqueueSyncNow()
            waitForEvent(ownerFirst, kind = "SyncCompleted", commandId = ownerFirstCommandId)
        } finally {
            ownerFirst.shutdown()
        }

        val ownerSecondDbPath = "$dbPath.owner-second"
        removeSqliteFiles(ownerSecondDbPath)
        val ownerSecond = SyncularBoltClient.openAsync(
            SyncularBoltClientConfig(
                dbPath = ownerSecondDbPath,
                baseUrl = info.str("baseUrl"),
                clientId = ownerConflictClientId,
                actorId = ownerConflict.str("secondActorId"),
                projectId = info.optionalString("projectId"),
                appSchemaJson = syncularNativeGeneratedAppSchemaJson,
                autoSyncLocalWrites = false,
            ),
        )
        try {
            expect(ownerSecond.finishOpenTimeout(timeoutMs = 5_000uL), "Kotlin owner-conflict second client should open")
            expect(ownerSecond.startEventStream(256uL), "Kotlin owner-conflict second client should start native event stream")
            configureServerSync(
                ownerSecond,
                info,
                authorization = ownerConflict.str("secondAuthorization"),
                actorId = ownerConflict.str("secondActorId"),
            )
            val ownerSecondCommandId = ownerSecond.enqueueSyncNow()
            val (ownerSecondEvent, ownerSecondJson) = waitForEventJson(
                ownerSecond,
                kind = "SyncFailed",
                commandId = ownerSecondCommandId,
            )
            expect(ownerSecondEvent.commandId == ownerSecondCommandId, "Kotlin owner-conflict failure should carry command id")
            expect(
                ownerSecondJson.contains(ownerConflict.str("expectedErrorPattern")),
                "Kotlin owner-conflict failure should expose HTTP ownership error",
            )
        } finally {
            ownerSecond.shutdown()
        }

        val conflictSummary = createServerConflict(
            client = client,
            info = info,
            conflict = conflict,
            label = "Kotlin keep-local",
        )
        val resolveCommandId = client.enqueueResolveConflict(
            conflictSummary.str("id"),
            conflict.str("keepLocalResolution"),
        )
        val resolveEvent = waitForEvent(client, kind = "ConflictResolutionCompleted", commandId = resolveCommandId)
        expect(resolveEvent.clientCommitId != null, "Kotlin keep-local conflict resolution should enqueue retry commit")
        expect(
            conflictSummaries(client).size == conflict.longValue("expectedAfterRetryConflictCount").toInt(),
            "Kotlin keep-local conflict resolution should clear conflict summary",
        )
        val conflictRetrySyncCommandId = client.enqueueSyncNow()
        waitForEvent(client, kind = "SyncCompleted", commandId = conflictRetrySyncCommandId)

        val keepServerSummary = createServerConflict(
            client = client,
            info = info,
            conflict = keepServerConflict,
            label = "Kotlin keep-server",
        )
        val keepServerCommandId = client.enqueueResolveConflict(
            keepServerSummary.str("id"),
            keepServerConflict.str("keepServerResolution"),
        )
        val keepServerEvent = waitForEvent(client, kind = "ConflictResolutionCompleted", commandId = keepServerCommandId)
        expect(keepServerEvent.clientCommitId == null, "Kotlin keep-server conflict resolution should not enqueue retry commit")
        expect(
            conflictSummaries(client).size == keepServerConflict.longValue("expectedAfterResolveConflictCount").toInt(),
            "Kotlin keep-server conflict resolution should clear conflict summary",
        )

        val dismissSummary = createServerConflict(
            client = client,
            info = info,
            conflict = dismissConflict,
            label = "Kotlin dismiss",
        )
        val dismissCommandId = client.enqueueResolveConflict(
            dismissSummary.str("id"),
            dismissConflict.str("dismissResolution"),
        )
        val dismissEvent = waitForEvent(client, kind = "ConflictResolutionCompleted", commandId = dismissCommandId)
        expect(dismissEvent.clientCommitId == null, "Kotlin dismiss conflict resolution should not enqueue retry commit")
        expect(
            conflictSummaries(client).size == dismissConflict.longValue("expectedAfterResolveConflictCount").toInt(),
            "Kotlin dismiss conflict resolution should clear conflict summary",
        )

        val pushedTaskId = "native-kotlin-pushed-task"
        val writeCommandId = client.enqueueMutationJson(
            SyncularAppOperations.newTask(
                NewTask(
                    id = pushedTaskId,
                    title = "Kotlin pushed task",
                    completed = 0L,
                    userId = info.str("actorId"),
                    projectId = info.optionalString("projectId"),
                ),
            ).toJsonString(),
            null,
        )
        waitForEvent(client, kind = "LocalWriteCommitted", commandId = writeCommandId)
        val pushSyncCommandId = client.enqueueSyncNow()
        waitForEvent(client, kind = "SyncCompleted", commandId = pushSyncCommandId)

        val websocketTaskId = "native-kotlin-websocket-task"
        val websocketWriteCommandId = client.enqueueMutationJson(
            SyncularAppOperations.newTask(
                NewTask(
                    id = websocketTaskId,
                    title = "Kotlin websocket task",
                    completed = 0L,
                    userId = info.str("actorId"),
                    projectId = info.optionalString("projectId"),
                ),
            ).toJsonString(),
            null,
        )
        waitForEvent(client, kind = "LocalWriteCommitted", commandId = websocketWriteCommandId)
        val websocketSyncCommandId = client.enqueueSyncWebsocket()
        waitForEvent(client, kind = "SyncCompleted", commandId = websocketSyncCommandId)

        val authFailureBlobFile = File("$dbPath.kotlin-blob-auth-failure.txt")
        authFailureBlobFile.writeText(blob.str("authFailureText"))
        val authFailureBlobJson = client.storeBlobFileJson(
            authFailureBlobFile.absolutePath,
            """{"mimeType":"${blob.str("textMimeType")}"}""",
        )
        val authFailureBlob = blobRefFromJson(authFailureBlobJson)
        setAuthorization(
            client,
            info.optionalString("staleAuthorization") ?: "Bearer stale-native",
            "Kotlin blob auth-failure client should accept stale auth headers",
        )
        expectUploadResult(
            Json.parseToJsonElement(client.processBlobUploadQueueJson()).jsonObject,
            blob["expectedProcessRetryableFailure"]?.jsonObject ?: error("missing retryable blob expectation"),
            "Kotlin blob auth failure first retry",
        )
        expectUploadStats(
            Json.parseToJsonElement(client.blobUploadQueueStatsJson()).jsonObject,
            blob["expectedUploadQueueBefore"]?.jsonObject ?: error("missing queued blob expectation"),
            "Kotlin blob auth failure first queue state",
        )
        Thread.sleep(1_100)
        expectUploadResult(
            Json.parseToJsonElement(client.processBlobUploadQueueJson()).jsonObject,
            blob["expectedProcessRetryableFailure"]?.jsonObject ?: error("missing retryable blob expectation"),
            "Kotlin blob auth failure second retry",
        )
        expectUploadStats(
            Json.parseToJsonElement(client.blobUploadQueueStatsJson()).jsonObject,
            blob["expectedUploadQueueBefore"]?.jsonObject ?: error("missing queued blob expectation"),
            "Kotlin blob auth failure second queue state",
        )
        Thread.sleep(2_100)
        expectUploadResult(
            Json.parseToJsonElement(client.processBlobUploadQueueJson()).jsonObject,
            blob["expectedProcessPermanentFailure"]?.jsonObject ?: error("missing permanent blob expectation"),
            "Kotlin blob auth failure permanent failure",
        )
        expectUploadStats(
            Json.parseToJsonElement(client.blobUploadQueueStatsJson()).jsonObject,
            blob["expectedFailedQueue"]?.jsonObject ?: error("missing failed blob expectation"),
            "Kotlin blob auth failure final queue state",
        )
        expect(client.isBlobLocal(authFailureBlob.hash), "Kotlin failed blob upload should keep local cache")
        configureServerSync(client, info)

        val blobText = "Kotlin native server blob"
        val blobFile = File("$dbPath.kotlin-blob.txt")
        val blobDownloadFile = File("$dbPath.kotlin-blob-downloaded.txt")
        blobFile.writeText(blobText)
        blobDownloadFile.delete()
        val blobJson = client.storeBlobFileJson(
            blobFile.absolutePath,
            """{"mimeType":"${blob.str("textMimeType")}"}""",
        )
        val uploadResult = Json.parseToJsonElement(client.processBlobUploadQueueJson()).jsonObject
        expect(uploadResult.longValue("uploaded") == 1L, "Kotlin blob upload queue should upload one blob")
        expect(uploadResult.longValue("failed") == 0L, "Kotlin blob upload queue should not fail")
        val blobRef = blobRefFromJson(blobJson)
        val blobTaskId = "native-kotlin-blob-task"
        val blobWriteCommandId = client.enqueueMutationJson(
            SyncularAppOperations.newTask(
                NewTask(
                    id = blobTaskId,
                    title = "Kotlin blob task",
                    completed = 0L,
                    userId = info.str("actorId"),
                    projectId = info.optionalString("projectId"),
                    image = blobRef,
                ),
            ).toJsonString(),
            null,
        )
        waitForEvent(client, kind = "LocalWriteCommitted", commandId = blobWriteCommandId)
        val blobSyncCommandId = client.enqueueSyncNow()
        waitForEvent(client, kind = "SyncCompleted", commandId = blobSyncCommandId)

        configureFieldEncryption(
            client,
            e2ee,
            "Kotlin server sync client should accept field encryption config",
        )
        val encryptedTaskId = e2eeTask.str("id")
        val encryptedWriteCommandId = client.enqueueMutationJson(
            SyncularAppOperations.newTask(
                NewTask(
                    id = encryptedTaskId,
                    title = e2eeTask.str("title"),
                    completed = 0L,
                    userId = info.str("actorId"),
                    projectId = info.optionalString("projectId"),
                ),
            ).toJsonString(),
            null,
        )
        waitForEvent(client, kind = "LocalWriteCommitted", commandId = encryptedWriteCommandId)
        val encryptedSyncCommandId = client.enqueueSyncNow()
        waitForEvent(client, kind = "SyncCompleted", commandId = encryptedSyncCommandId)

        val readerDbPath = "$dbPath.reader"
        removeSqliteFiles(readerDbPath)
        val reader = SyncularBoltClient.openAsync(
            SyncularBoltClientConfig(
                dbPath = readerDbPath,
                baseUrl = info.str("baseUrl"),
                clientId = "kotlin-native-server-sync-reader",
                actorId = info.str("actorId"),
                projectId = info.optionalString("projectId"),
                appSchemaJson = syncularNativeGeneratedAppSchemaJson,
                autoSyncLocalWrites = false,
            ),
        )
        try {
            expect(reader.finishOpenTimeout(timeoutMs = 5_000uL), "Kotlin server sync reader should open")
            expect(reader.startEventStream(256uL), "Kotlin server sync reader should start native event stream")
            configureServerSync(reader, info)
            val readerNative = BoltNativeClient(reader)
            val liveQuery = TaskQuery
                .select()
                .filter(TaskQuery.userId.eq(info.str("actorId")))
                .liveQuery(id = "kotlin-native-server-live", label = "Kotlin server sync")
            val initialLiveRows = liveQuery.start(readerNative)
            expect(initialLiveRows.isEmpty(), "Kotlin server live query should start empty")
            val pullPushedCommandId = reader.enqueueSyncNow()
            waitForEvent(reader, kind = "SyncCompleted", commandId = pullPushedCommandId)
            val liveQueryEvent = waitForEvent(reader, kind = "QueriesChanged", commandId = null)
            val refreshedLiveRows = liveQuery.refreshIfChanged(liveQueryEvent, readerNative)
            expect(
                refreshedLiveRows?.any { it.id == pushedTaskId } == true,
                "Kotlin server live query should refresh after sync pull",
            )
            liveQuery.stop(readerNative)
            val pushedRows = queryTaskRowsById(reader, pushedTaskId)
            expect(pushedRows.size == 1, "Kotlin server sync reader should pull pushed task")
            expect(pushedRows[0].jsonObject.str("title") == "Kotlin pushed task", "Kotlin server sync reader should decode pushed title")
            val websocketRows = queryTaskRowsById(reader, websocketTaskId)
            expect(websocketRows.size == 1, "Kotlin server sync reader should pull websocket-pushed task")
            expect(websocketRows[0].jsonObject.str("title") == "Kotlin websocket task", "Kotlin server sync reader should decode websocket-pushed title")
            val blobRows = queryTaskRowsById(reader, blobTaskId)
            expect(blobRows.size == 1, "Kotlin server sync reader should pull blob task")
            val readerBlob = blobRows[0].jsonObject["image"]?.let(::blobRefObjectFromQueryValue) ?: error("missing Kotlin blob ref")
            expect(readerBlob.str("hash") == blobRef.hash, "Kotlin server sync reader should decode blob ref hash")
            expect(readerBlob.longValue("size") == blobRef.size, "Kotlin server sync reader should decode blob ref size")
            expect(readerBlob.str("mimeType") == blobRef.mimeType, "Kotlin server sync reader should decode blob ref MIME type")
            expect(
                reader.retrieveBlobFileJson(blobJson, blobDownloadFile.absolutePath, """{"cacheLocal":false}"""),
                "Kotlin server sync reader should retrieve blob file",
            )
            expect(blobDownloadFile.readText() == blobText, "Kotlin server sync reader should download blob bytes")
            val missingRefJson = blob["missingRef"]?.jsonObject ?: error("missing remote blob expectation")
            val missingRef = SyncularBlobRef(
                hash = missingRefJson.str("hash"),
                size = missingRefJson.longValue("size"),
                mimeType = missingRefJson.str("mimeType"),
            )
            val missingBlobDownloadFile = File("$dbPath.kotlin-missing-blob.bin")
            missingBlobDownloadFile.delete()
            try {
                reader.retrieveBlobFileJson(missingRef.toJsonString(), missingBlobDownloadFile.absolutePath, """{"cacheLocal":false}""")
                error("Kotlin missing remote blob retrieval should fail")
            } catch (error: Throwable) {
                expect(
                    error.message?.contains("HTTP 404") == true,
                    "Kotlin missing remote blob retrieval should expose HTTP 404",
                )
            }
            expect(!reader.isBlobLocal(missingRef.hash), "Kotlin missing remote blob should not be cached locally")
            val ciphertextRows = queryTaskRowsById(reader, encryptedTaskId)
            expect(ciphertextRows.size == 1, "Kotlin server sync reader should pull encrypted task")
            expect(
                ciphertextRows[0].jsonObject.str("title").startsWith(e2ee.str("envelopePrefix")),
                "Kotlin server sync reader without field encryption should see ciphertext envelope",
            )
            val conflictRows = queryTaskRowsById(reader, conflict.str("rowId"))
            expect(conflictRows.size == 1, "Kotlin server sync reader should pull resolved conflict task")
            expect(conflictRows[0].jsonObject.str("title") == conflict.str("localTitle"), "Kotlin server sync reader should pull keep-local title")
        } finally {
            reader.shutdown()
        }

        val encryptedReaderDbPath = "$dbPath.encrypted-reader"
        removeSqliteFiles(encryptedReaderDbPath)
        val encryptedReader = SyncularBoltClient.openAsync(
            SyncularBoltClientConfig(
                dbPath = encryptedReaderDbPath,
                baseUrl = info.str("baseUrl"),
                clientId = "kotlin-native-server-sync-encrypted-reader",
                actorId = info.str("actorId"),
                projectId = info.optionalString("projectId"),
                appSchemaJson = syncularNativeGeneratedAppSchemaJson,
                autoSyncLocalWrites = false,
            ),
        )
        try {
            expect(encryptedReader.finishOpenTimeout(timeoutMs = 5_000uL), "Kotlin encrypted server sync reader should open")
            expect(encryptedReader.startEventStream(256uL), "Kotlin encrypted server sync reader should start native event stream")
            configureServerSync(encryptedReader, info)
            configureFieldEncryption(
                encryptedReader,
                e2ee,
                "Kotlin encrypted reader should accept field encryption config",
            )
            val pullEncryptedCommandId = encryptedReader.enqueueSyncNow()
            waitForEvent(encryptedReader, kind = "SyncCompleted", commandId = pullEncryptedCommandId)
            val decryptedRows = queryTaskRowsById(encryptedReader, encryptedTaskId)
            expect(decryptedRows.size == 1, "Kotlin encrypted reader should pull encrypted task")
            expect(
                decryptedRows[0].jsonObject.str("title") == e2eeTask.str("title"),
                "Kotlin encrypted reader should decrypt pulled title",
            )
        } finally {
            encryptedReader.shutdown()
        }
    } finally {
        client.shutdown()
    }

    println("Kotlin native server sync smoke passed")
}
