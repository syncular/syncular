import java.io.File
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.long

private class MockNativeClient(private val imageJson: String? = null) : SyncularNativeJsonClient {
    val mutations = mutableListOf<String>()
    val crdtFieldRequests = mutableListOf<String>()
    val crdtTextRequests = mutableListOf<String>()
    val queuedCrdtTextRequests = mutableListOf<String>()
    val crdtUpdateRequests = mutableListOf<String>()
    val crdtCompactionRequests = mutableListOf<String>()
    val queuedCrdtCompactionRequests = mutableListOf<String>()
    val queryRequests = mutableListOf<String>()
    val registrations = mutableListOf<String>()
    val unregisteredIds = mutableListOf<String>()

    override fun applyMutationJson(mutationJson: String, localRowJson: String?): String {
        mutations += mutationJson
        return "commit-kotlin"
    }

    override fun enqueueMutationJson(mutationJson: String, localRowJson: String?): String {
        mutations += mutationJson
        return "command-kotlin"
    }

    override fun openCrdtFieldJson(requestJson: String): String {
        crdtFieldRequests += requestJson
        return """{"table":"tasks","rowId":"task-native","field":"title","stateColumn":"title_yjs_state","containerKey":"title","rowIdField":"id","kind":"text","syncMode":"server-merge"}"""
    }

    override fun applyCrdtFieldTextJson(requestJson: String): String {
        crdtTextRequests += requestJson
        return """{"clientCommitId":"commit-crdt-kotlin","syncMode":"server-merge"}"""
    }

    override fun applyCrdtFieldYjsUpdateJson(requestJson: String): String {
        crdtUpdateRequests += requestJson
        return """{"clientCommitId":"commit-crdt-yjs-kotlin","syncMode":"server-merge"}"""
    }

    override fun enqueueCrdtFieldYjsUpdateJson(requestJson: String): String {
        crdtUpdateRequests += requestJson
        return "command-crdt-kotlin"
    }

    override fun enqueueCrdtFieldTextJson(requestJson: String): String {
        queuedCrdtTextRequests += requestJson
        return "command-crdt-text-kotlin"
    }

    override fun enqueueCrdtFieldCompactionJson(requestJson: String): String {
        queuedCrdtCompactionRequests += requestJson
        return "command-crdt-compact-kotlin"
    }

    override fun materializeCrdtFieldJson(requestJson: String): String {
        crdtFieldRequests += requestJson
        return """{"value":"Native CRDT smoke","stateBase64":"state","stateVectorBase64":"vector"}"""
    }

    override fun snapshotCrdtFieldStateVectorJson(requestJson: String): String {
        crdtFieldRequests += requestJson
        return """{"stateVectorBase64":"vector"}"""
    }

    override fun compactCrdtFieldJson(requestJson: String): String {
        crdtCompactionRequests += requestJson
        return """{"checkpointCreated":false,"clientCommitId":null}"""
    }

    override fun queryJson(requestJson: String): String {
        queryRequests += requestJson
        val imageValue = imageJson?.let(::smokeJsonString) ?: "null"
        return """
            {"rows":[{"id":"task-native","title":"Native smoke","completed":1,"user_id":"user-rust","project_id":"project-rust","server_version":11,"image":$imageValue,"title_yjs_state":null}]}
        """.trimIndent()
    }

    override fun registerQueryJson(queryJson: String): String {
        registrations += queryJson
        return "live-tasks"
    }

    override fun unregisterQuery(id: String): Boolean {
        unregisteredIds += id
        return true
    }
}

private fun expect(condition: Boolean, message: String) {
    if (!condition) error(message)
}

private val smokeJson = Json { ignoreUnknownKeys = true }

private fun loadJsonFixture(args: Array<String>, index: Int, fallbackPath: String): JsonObject {
    val path = args.getOrNull(index) ?: fallbackPath
    return smokeJson.parseToJsonElement(File(path).readText()).jsonObject
}

private fun loadConformanceFixture(args: Array<String>): JsonObject =
    loadJsonFixture(args, 0, "rust/examples/todo-app/conformance/generated-client.json")

private fun loadSyncScenariosFixture(args: Array<String>): JsonObject =
    loadJsonFixture(args, 1, "rust/examples/todo-app/conformance/sync-scenarios.json")

private fun JsonObject.obj(key: String): JsonObject =
    this[key]?.jsonObject ?: error("missing conformance object $key")

private fun JsonObject.str(key: String): String =
    this[key]?.jsonPrimitive?.content ?: error("missing conformance string $key")

private fun JsonObject.longValue(key: String): Long =
    this[key]?.jsonPrimitive?.long ?: error("missing conformance integer $key")

private fun parseJson(json: String) = smokeJson.parseToJsonElement(json)

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

fun main(args: Array<String>) {
    val conformance = loadConformanceFixture(args)
    val syncScenarios = loadSyncScenariosFixture(args)
    val taskFixture = conformance.obj("task")
    val taskInput = taskFixture.obj("newInput")
    val nativeQuery = taskFixture.obj("nativeQuery")
    val crdtFixture = conformance.obj("crdt")
    val crdtField = crdtFixture.obj("field")
    val e2eeFixture = syncScenarios.obj("e2ee")
    val e2eeRule = e2eeFixture.obj("rule")
    val blobFixture = syncScenarios.obj("blob")
    val blobReference = blobFixture.obj("referenceSync")
    val blobTask = blobReference.obj("task")
    val blobImage = blobReference.obj("image")
    val blobRef = SyncularBlobRef(
        hash = blobImage.str("hash"),
        size = blobImage.longValue("size"),
        mimeType = blobImage.str("mimeType"),
    )
    val client = MockNativeClient(imageJson = blobImage.toString())
    val query = TaskQuery
        .select()
        .filter(TaskQuery.userId.eq(taskInput.str("user_id")))
        .orderBy(TaskQuery.serverVersion.desc())
        .limit(5)

    val readonly = query.readonlyQuery()
    expect(parseJson(readonly.toJsonString()) == nativeQuery, "unexpected Kotlin query contract")

    val subscriptionArgs = SyncularSubscriptionArgs(
        actorId = taskInput.str("user_id"),
        projectId = taskInput.str("project_id"),
    )
    expect(
        parseJson(taskSubscription(subscriptionArgs).toJsonString()) == taskFixture["subscription"],
        "unexpected Kotlin subscription contract",
    )
    expect(
        parseJson(syncularSubscriptionsJson(listOf(taskSubscription(subscriptionArgs)))).jsonArray[0] == taskFixture["subscription"],
        "unexpected Kotlin subscription array contract",
    )

    val advancedQuery = TaskQuery
        .select()
        .filter(
            (TaskQuery.userId.eq(taskInput.str("user_id")) and TaskQuery.serverVersion.gte(3L)) or TaskQuery.projectId.isNull(),
        )
        .filter(TaskQuery.id.isIn(listOf(taskInput.str("id"), "task-native-other")))
        .filter(TaskQuery.image.isNotNull())
        .filter(TaskQuery.completed.notEq(0L))
        .orderBy(TaskQuery.title.asc())
        .limit(2)
    val advancedReadonly = advancedQuery.readonlyQuery()
    expect(
        advancedReadonly.sql == """select "id", "title", "completed", "user_id", "project_id", "server_version", "image", "title_yjs_state" from "tasks" where (((("user_id" = ?) and ("server_version" >= ?))) or ("project_id" is null)) and "id" in (?, ?) and "image" is not null and "completed" != ? order by "title" asc limit 2""",
        "unexpected Kotlin advanced query SQL",
    )
    expect(
        advancedReadonly.params == listOf(taskInput.str("user_id"), 3L, taskInput.str("id"), "task-native-other", 0L),
        "unexpected Kotlin advanced query params",
    )
    expect(TaskQuery.id.isIn(emptyList()).sql == "0 = 1", "Kotlin empty IN should be false")
    expect(TaskQuery.id.notIn(emptyList()).sql == "1 = 1", "Kotlin empty NOT IN should be true")

    val rows = query.fetch(client)
    expect(rows.size == 1, "Kotlin fetch should decode one row")
    expect(rows[0].id == taskInput.str("id"), "Kotlin fetch should decode id")
    expect(rows[0].completed == taskInput.longValue("completed"), "Kotlin fetch should decode completed")
    expect(rows[0].image?.hash == blobImage.str("hash"), "Kotlin fetch should decode blob ref hash")
    expect(rows[0].image?.size == blobImage.longValue("size"), "Kotlin fetch should decode blob ref size")
    expect(rows[0].image?.mimeType == blobImage.str("mimeType"), "Kotlin fetch should decode blob ref MIME type")

    val commitId = client.applyNewTask(
        NewTask(
            id = taskInput.str("id"),
            title = taskInput.str("title"),
            completed = taskInput.longValue("completed"),
            userId = taskInput.str("user_id"),
            projectId = taskInput.str("project_id"),
        ),
    )
    expect(commitId == "commit-kotlin", "Kotlin mutation helper should return commit id")
    expect(client.mutations.size == 1, "Kotlin mutation helper should call applyMutationJson once")
    expect(parseJson(client.mutations[0]) == taskFixture["newOperation"], "Kotlin mutation should match shared new task operation")

    client.applyTaskPatch(rowId = taskInput.str("id"), patch = TaskPatch(completed = 0), baseVersion = 11)
    expect(parseJson(client.mutations[1]) == taskFixture["patchOperation"], "Kotlin patch should match shared task patch operation")
    client.applyTaskDelete(rowId = taskInput.str("id"), baseVersion = 12)
    expect(parseJson(client.mutations[2]) == taskFixture["deleteOperation"], "Kotlin delete should match shared task delete operation")

    val enqueueCommandId = client.enqueueNewTask(
        NewTask(
            id = taskInput.str("id"),
            title = taskInput.str("title"),
            completed = taskInput.longValue("completed"),
            userId = taskInput.str("user_id"),
            projectId = taskInput.str("project_id"),
        ),
    )
    expect(enqueueCommandId == "command-kotlin", "Kotlin enqueue mutation helper should return command id")
    expect(parseJson(client.mutations[3]) == taskFixture["newOperation"], "Kotlin enqueue mutation should match shared new task operation")

    val blobOperation = parseJson(
        SyncularAppOperations.newTask(
            NewTask(
                id = blobTask.str("id"),
                title = blobTask.str("title"),
                completed = 0,
                userId = taskInput.str("user_id"),
                image = blobRef,
            ),
        ).toJsonString(),
    ).jsonObject
    expect(blobOperation.obj("payload")["image"] == blobImage, "Kotlin blob ref mutation payload should be app-shaped JSON")

    val fieldEncryptionConfig = parseJson(
        syncularGeneratedFieldEncryptionConfigJson(
            keys = mapOf("default" to e2eeFixture.str("keyBase64")),
            envelopePrefix = e2eeFixture.str("envelopePrefix"),
            additionalRules = listOf(
                SyncularFieldEncryptionRule(
                    scope = e2eeRule.str("scope"),
                    table = e2eeRule.str("table"),
                    fields = e2eeRule["fields"]!!.jsonArray.map { it.jsonPrimitive.content },
                    rowIdField = null,
                ),
            ),
        ),
    ).jsonObject
    val fieldEncryptionRules = fieldEncryptionConfig["rules"]?.jsonArray ?: error("missing E2EE rules")
    expect(fieldEncryptionRules.size == 1 && fieldEncryptionRules[0] == e2eeRule, "Kotlin E2EE rules should match shared sync scenario")
    expect(fieldEncryptionConfig.obj("keys").str("default") == e2eeFixture.str("keyBase64"), "Kotlin E2EE keys should match shared sync scenario")
    expect(fieldEncryptionConfig.str("envelopePrefix") == e2eeFixture.str("envelopePrefix"), "Kotlin E2EE envelope prefix should match shared sync scenario")

    val rowId = crdtField.str("rowId")
    val descriptor = client.openTaskTitleCrdtField(rowId = rowId)
    expect(descriptor.syncMode == "server-merge", "Kotlin CRDT helper should open server-merge field")
    expect(descriptor.rowIdField == "id", "Kotlin CRDT helper should decode row id field")
    expect(parseJson(client.crdtFieldRequests[0]) == crdtField, "Kotlin CRDT open request should match shared field")
    val applyTextRequest = crdtFixture.obj("applyTextRequest")
    val crdtReceipt = client.applyTaskTitleText(rowId = rowId, nextText = applyTextRequest.str("nextText"))
    expect(crdtReceipt.clientCommitId == "commit-crdt-kotlin", "Kotlin CRDT text helper should return write receipt")
    expect(crdtReceipt.syncMode == "server-merge", "Kotlin CRDT text helper should decode sync mode")
    expect(client.crdtTextRequests.size == 1, "Kotlin CRDT text helper should call native text API once")
    expect(parseJson(client.crdtTextRequests[0]) == applyTextRequest, "Kotlin CRDT text request should match shared envelope")
    val queuedTextRequest = crdtFixture.obj("enqueueTextRequest")
    val queuedTextCommandId = client.enqueueTaskTitleText(rowId = rowId, nextText = queuedTextRequest.str("nextText"))
    expect(queuedTextCommandId == "command-crdt-text-kotlin", "Kotlin queued CRDT text helper should return command id")
    expect(client.queuedCrdtTextRequests.size == 1, "Kotlin queued CRDT text helper should call native enqueue text API once")
    expect(parseJson(client.queuedCrdtTextRequests[0]) == queuedTextRequest, "Kotlin queued CRDT text request should match shared envelope")
    val materialized = client.materializeTaskTitle(rowId = rowId)
    expect(materialized.value.jsonPrimitive.content == "Native CRDT smoke", "Kotlin CRDT materialize helper should return typed field value")
    val snapshot = client.snapshotTaskTitleStateVector(rowId = rowId)
    expect(snapshot.stateVectorBase64 == "vector", "Kotlin CRDT snapshot helper should return typed state vector")
    val compactionRequest = crdtFixture.obj("compactionRequest")
    val compact = client.compactTaskTitle(rowId = rowId, minUncheckpointedUpdates = compactionRequest.longValue("minUncheckpointedUpdates"))
    expect(!compact.checkpointCreated, "Kotlin CRDT compact helper should return typed compaction receipt")
    expect(parseJson(client.crdtCompactionRequests[0]) == compactionRequest, "Kotlin CRDT compaction request should match shared envelope")
    val queuedCompactionCommandId = client.enqueueTaskTitleCompaction(rowId = rowId, minUncheckpointedUpdates = compactionRequest.longValue("minUncheckpointedUpdates"))
    expect(queuedCompactionCommandId == "command-crdt-compact-kotlin", "Kotlin queued CRDT compaction helper should return command id")
    expect(client.queuedCrdtCompactionRequests.size == 1, "Kotlin queued CRDT compaction helper should call native enqueue compaction API once")
    expect(parseJson(client.queuedCrdtCompactionRequests[0]) == compactionRequest, "Kotlin queued CRDT compaction request should match shared envelope")

    val live = query.liveQuery(id = "live-tasks", label = "Tasks")
    val initialRows = live.start(client)
    expect(initialRows.size == 1, "Kotlin live query start should refresh rows")
    expect(client.registrations.size == 1, "Kotlin live query should register once")
    expect(client.registrations[0].contains("\"id\":\"live-tasks\""), "Kotlin live query registration id")
    expect(client.registrations[0].contains("\"tables\":[\"tasks\"]"), "Kotlin live query registration tables")

    val ignored = live.refreshIfChanged(
        SyncularNativeEvent(kind = "QueriesChanged", queries = listOf("other-query")),
        client,
    )
    expect(ignored == null, "Kotlin live query should ignore unrelated query changes")

    val refreshed = live.refreshIfChanged(
        SyncularNativeEvent(kind = "QueriesChanged", queries = listOf("live-tasks")),
        client,
    )
    expect(refreshed?.size == 1, "Kotlin live query should refresh affected query")
    expect(client.queryRequests.size == 3, "Kotlin live query should run initial, start, and affected refresh queries")
    expect(live.stop(client), "Kotlin live query stop should unregister")
    expect(client.unregisteredIds == listOf("live-tasks"), "Kotlin live query unregister id")

    println("Kotlin generated client smoke passed")
}
