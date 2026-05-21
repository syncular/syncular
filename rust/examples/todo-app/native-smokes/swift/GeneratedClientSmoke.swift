import Foundation

private final class MockNativeClient: SyncularNativeJsonClient {
    private(set) var capturedMutations: [String] = []
    private(set) var crdtFieldRequests: [String] = []
    private(set) var crdtTextRequests: [String] = []
    private(set) var queuedCrdtTextRequests: [String] = []
    private(set) var crdtUpdateRequests: [String] = []
    private(set) var crdtCompactionRequests: [String] = []
    private(set) var queuedCrdtCompactionRequests: [String] = []
    private(set) var queryRequests: [SyncularReadonlyQuery] = []
    private(set) var registrations: [SyncularLiveQueryRegistration] = []
    private(set) var unregisteredIds: [String] = []
    private let imageJson: String?

    init(imageJson: String? = nil) {
        self.imageJson = imageJson
    }

    func applyMutationJson(mutationJson: String, localRowJson: String?) throws -> String {
        capturedMutations.append(mutationJson)
        return "commit-swift"
    }

    func applyLeasedMutationJson(mutationJson: String, localRowJson: String?) throws -> String {
        capturedMutations.append(mutationJson)
        return "commit-leased-swift"
    }

    func enqueueMutationJson(mutationJson: String, localRowJson: String?) throws -> String {
        capturedMutations.append(mutationJson)
        return "command-swift"
    }

    func enqueueLeasedMutationJson(mutationJson: String, localRowJson: String?) throws -> String {
        capturedMutations.append(mutationJson)
        return "command-leased-swift"
    }

    func diagnosticSnapshotJson() throws -> String {
        #"{"storage":{"backend":"mock"},"worker":{"running":false},"sync":{"pending":0},"outbox":{"pending":0},"blobs":{"pending":0},"events":{"running":false},"configuration":{"redacted":true}}"#
    }

    func openCrdtFieldJson(requestJson: String) throws -> String {
        crdtFieldRequests.append(requestJson)
        return #"{"table":"tasks","rowId":"task-native","field":"title","stateColumn":"title_yjs_state","containerKey":"title","rowIdField":"id","kind":"text","syncMode":"server-merge"}"#
    }

    func applyCrdtFieldTextJson(requestJson: String) throws -> String {
        crdtTextRequests.append(requestJson)
        return #"{"clientCommitId":"commit-crdt-swift","syncMode":"server-merge"}"#
    }

    func applyCrdtFieldYjsUpdateJson(requestJson: String) throws -> String {
        crdtUpdateRequests.append(requestJson)
        return #"{"clientCommitId":"commit-crdt-yjs-swift","syncMode":"server-merge"}"#
    }

    func enqueueCrdtFieldYjsUpdateJson(requestJson: String) throws -> String {
        crdtUpdateRequests.append(requestJson)
        return "command-crdt-swift"
    }

    func enqueueCrdtFieldTextJson(requestJson: String) throws -> String {
        queuedCrdtTextRequests.append(requestJson)
        return "command-crdt-text-swift"
    }

    func enqueueCrdtFieldCompactionJson(requestJson: String) throws -> String {
        queuedCrdtCompactionRequests.append(requestJson)
        return "command-crdt-compact-swift"
    }

    func materializeCrdtFieldJson(requestJson: String) throws -> String {
        crdtFieldRequests.append(requestJson)
        return #"{"value":"Native CRDT smoke","stateBase64":"state","stateVectorBase64":"vector"}"#
    }

    func snapshotCrdtFieldStateVectorJson(requestJson: String) throws -> String {
        crdtFieldRequests.append(requestJson)
        return #"{"stateVectorBase64":"vector"}"#
    }

    func compactCrdtFieldJson(requestJson: String) throws -> String {
        crdtCompactionRequests.append(requestJson)
        return #"{"checkpointCreated":false,"clientCommitId":null,"before":{"pendingUpdates":0,"flushedUpdates":0,"ackedUpdates":0,"logUpdates":0,"stateVectorBase64":"vector","updatedAt":1,"compactedAt":null},"after":{"pendingUpdates":0,"flushedUpdates":0,"ackedUpdates":0,"logUpdates":0,"stateVectorBase64":"vector","updatedAt":2,"compactedAt":2},"encryptedStreamBefore":null,"encryptedStreamAfter":null}"#
    }

    func queryJson(requestJson: String) throws -> String {
        let query = try JSONDecoder().decode(SyncularReadonlyQuery.self, from: Data(requestJson.utf8))
        queryRequests.append(query)
        var row: [String: Any] = [
            "id": "task-native",
            "title": "Native smoke",
            "completed": 1,
            "user_id": "user-rust",
            "project_id": "project-rust",
            "server_version": 11,
            "title_yjs_state": NSNull(),
        ]
        if let imageJson {
            row["image"] = imageJson
        } else {
            row["image"] = NSNull()
        }
        let data = try JSONSerialization.data(withJSONObject: ["rows": [row]], options: [.sortedKeys])
        return String(data: data, encoding: .utf8)!
    }

    func registerQueryJson(queryJson: String) throws -> String {
        let registration = try JSONDecoder().decode(SyncularLiveQueryRegistration.self, from: Data(queryJson.utf8))
        registrations.append(registration)
        return registration.id
    }

    func unregisterQuery(id: String) throws -> Bool {
        unregisteredIds.append(id)
        return true
    }
}

private func expect(_ condition: @autoclosure () -> Bool, _ message: String) {
    if !condition() {
        fatalError(message)
    }
}

private func loadJsonFixture(argumentIndex: Int, fallbackPath: String) throws -> [String: Any] {
    let path = CommandLine.arguments.dropFirst().dropFirst(argumentIndex).first
        ?? fallbackPath
    let data = try Data(contentsOf: URL(fileURLWithPath: path))
    guard let object = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
        fatalError("conformance fixture must be a JSON object")
    }
    return object
}

private func loadConformanceFixture() throws -> [String: Any] {
    try loadJsonFixture(argumentIndex: 0, fallbackPath: "rust/examples/todo-app/conformance/generated-client.json")
}

private func loadSyncScenariosFixture() throws -> [String: Any] {
    try loadJsonFixture(argumentIndex: 1, fallbackPath: "rust/examples/todo-app/conformance/sync-scenarios.json")
}

private func jsonObject(_ object: Any, _ key: String) -> [String: Any] {
    guard let dict = object as? [String: Any], let child = dict[key] as? [String: Any] else {
        fatalError("missing conformance object \(key)")
    }
    return child
}

private func jsonValue(_ object: Any, _ key: String) -> Any {
    guard let dict = object as? [String: Any], let value = dict[key] else {
        fatalError("missing conformance value \(key)")
    }
    return value
}

private func jsonString(_ object: Any, _ key: String) -> String {
    guard let value = jsonValue(object, key) as? String else {
        fatalError("conformance value \(key) must be a string")
    }
    return value
}

private func jsonStringArray(_ object: Any, _ key: String) -> [String] {
    guard let value = jsonValue(object, key) as? [String] else {
        fatalError("conformance value \(key) must be a string array")
    }
    return value
}

private func jsonInt(_ object: Any, _ key: String) -> Int64 {
    guard let value = jsonValue(object, key) as? NSNumber else {
        fatalError("conformance value \(key) must be an integer")
    }
    return value.int64Value
}

private func parseJson(_ json: String) throws -> Any {
    try JSONSerialization.jsonObject(with: Data(json.utf8))
}

private func encodedJsonObject<T: Encodable>(_ value: T) throws -> Any {
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.sortedKeys]
    return try JSONSerialization.jsonObject(with: encoder.encode(value))
}

private func canonicalJson(_ object: Any) throws -> String {
    let data = try JSONSerialization.data(withJSONObject: object, options: [.sortedKeys])
    return String(data: data, encoding: .utf8)!
}

private func expectJsonEqual(_ lhs: Any, _ rhs: Any, _ message: String) throws {
    let lhsJson = try canonicalJson(lhs)
    let rhsJson = try canonicalJson(rhs)
    expect(lhsJson == rhsJson, message)
}

@main
private enum GeneratedClientSmoke {
    static func main() throws {
        let conformance = try loadConformanceFixture()
        let syncScenarios = try loadSyncScenariosFixture()
        let taskFixture = jsonObject(conformance, "task")
        let taskInput = jsonObject(taskFixture, "newInput")
        let nativeQuery = jsonObject(taskFixture, "nativeQuery")
        let crdtFixture = jsonObject(conformance, "crdt")
        let crdtField = jsonObject(crdtFixture, "field")
        let e2eeFixture = jsonObject(syncScenarios, "e2ee")
        let e2eeRule = jsonObject(e2eeFixture, "rule")
        let blobFixture = jsonObject(syncScenarios, "blob")
        let blobReference = jsonObject(blobFixture, "referenceSync")
        let blobTask = jsonObject(blobReference, "task")
        let blobImage = jsonObject(blobReference, "image")
        let blobImageJson = try canonicalJson(blobImage)
        let blobRef = SyncularBlobRef(
            hash: jsonString(blobImage, "hash"),
            size: jsonInt(blobImage, "size"),
            mimeType: jsonString(blobImage, "mimeType")
        )
        let client = MockNativeClient(imageJson: blobImageJson)
        let diagnostics = try client.diagnosticSnapshot()
        if case .object(let diagnosticObject) = diagnostics {
            expect(diagnosticObject["configuration"] != nil, "Swift diagnostics helper should decode snapshot JSON")
        } else {
            fatalError("Swift diagnostics helper should return a JSON object")
        }
        let query = TaskQuery
            .select()
            .filter(TaskQuery.userId.eq(jsonString(taskInput, "user_id")))
            .orderBy(TaskQuery.serverVersion.desc())
            .limit(5)

        let readonly = query.readonlyQuery()
        let readonlyObject = try encodedJsonObject(readonly) as! [String: Any]
        expect(readonly.sql == jsonString(nativeQuery, "sql"), "unexpected Swift query SQL")
        try expectJsonEqual(jsonValue(readonlyObject, "params"), jsonValue(nativeQuery, "params"), "unexpected Swift query params")
        try expectJsonEqual(jsonValue(readonlyObject, "tables"), jsonValue(nativeQuery, "tables"), "unexpected Swift query tables")

        let subscriptionArgs = SyncularSubscriptionArgs(
            actorId: jsonString(taskInput, "user_id"),
            projectId: jsonString(taskInput, "project_id")
        )
        let taskSubscriptionObject = try parseJson(taskSubscription(args: subscriptionArgs).jsonString())
        try expectJsonEqual(taskSubscriptionObject, jsonObject(taskFixture, "subscription"), "unexpected Swift subscription contract")
        let taskSubscriptionsObject = try parseJson(syncularSubscriptionsJson([taskSubscription(args: subscriptionArgs)]))
        try expectJsonEqual(taskSubscriptionsObject, [jsonObject(taskFixture, "subscription")], "unexpected Swift subscription array contract")

        let advancedQuery = TaskQuery
            .select()
            .filter(
                TaskQuery.userId.eq(jsonString(taskInput, "user_id"))
                    .and(TaskQuery.serverVersion.gte(3))
                    .or(TaskQuery.projectId.isNull())
            )
            .filter(TaskQuery.id.isIn([jsonString(taskInput, "id"), "task-native-other"]))
            .filter(TaskQuery.image.isNotNull())
            .filter(TaskQuery.completed.notEq(0))
            .orderBy(TaskQuery.title.asc())
            .limit(2)
        let advancedReadonly = advancedQuery.readonlyQuery()
        expect(
            advancedReadonly.sql == #"select "id", "title", "completed", "user_id", "project_id", "server_version", "image", "title_yjs_state" from "tasks" where (((("user_id" = ?) and ("server_version" >= ?))) or ("project_id" is null)) and "id" in (?, ?) and "image" is not null and "completed" != ? order by "title" asc limit 2"#,
            "unexpected Swift advanced query SQL"
        )
        expect(
            advancedReadonly.params == [.string(jsonString(taskInput, "user_id")), .int(3), .string(jsonString(taskInput, "id")), .string("task-native-other"), .int(0)],
            "unexpected Swift advanced query params"
        )
        expect(TaskQuery.id.isIn([]).sql == "0 = 1", "Swift empty IN should be false")
        expect(TaskQuery.id.notIn([]).sql == "1 = 1", "Swift empty NOT IN should be true")

        let rows = try query.fetch(on: client)
        expect(rows.count == 1, "Swift fetch should decode one row")
        expect(rows[0].id == jsonString(taskInput, "id"), "Swift fetch should decode id")
        expect(rows[0].completed == jsonInt(taskInput, "completed"), "Swift fetch should decode completed")
        expect(rows[0].image?.hash == jsonString(blobImage, "hash"), "Swift fetch should decode blob ref hash")
        expect(rows[0].image?.size == jsonInt(blobImage, "size"), "Swift fetch should decode blob ref size")
        expect(rows[0].image?.mimeType == jsonString(blobImage, "mimeType"), "Swift fetch should decode blob ref MIME type")

        let errorEvent = try syncularDecodeNativeEvent(
            #"{"kind":"SyncFailed","error":{"kind":"Transport","code":"sync.forbidden","category":"forbidden","retryable":false,"recommendedAction":"checkPermissions","message":"Forbidden","debug":"Transport: Forbidden"}}"#
        )
        expect(errorEvent.error?.code == "sync.forbidden", "Swift native event should decode error code")
        expect(errorEvent.error?.category == "forbidden", "Swift native event should decode error category")
        expect(errorEvent.error?.retryable == false, "Swift native event should decode retryable")
        expect(errorEvent.error?.recommendedAction == "checkPermissions", "Swift native event should decode recommended action")

        let rowDeltaEvent = SyncularNativeEvent(
            kind: "RowsChanged",
            changedRows: [
                SyncularChangedRow(
                    table: "tasks",
                    rowId: jsonString(taskInput, "id"),
                    operation: "update",
                    changedFields: ["title", "title_yjs_state", "unknown_column"],
                    crdtFields: ["title_yjs_state"],
                    commitId: "commit-delta",
                    commitSeq: 7,
                    subscriptionId: "sub-tasks",
                    serverVersion: 11
                ),
                SyncularChangedRow(
                    table: "projects",
                    rowId: "project-rust",
                    operation: "delete",
                    changedFields: ["name"]
                ),
            ]
        )
        let taskDeltas = taskChangedRows(in: rowDeltaEvent)
        expect(taskDeltas.count == 1, "Swift changed-row helper should filter task deltas")
        let taskDelta = taskDeltas[0]
        expect(taskDelta.rowId == jsonString(taskInput, "id"), "Swift changed-row helper should expose row id")
        expect(taskDelta.isUpdate && !taskDelta.isInsert, "Swift changed-row helper should expose operation flags")
        expect(taskDelta.changed.title, "Swift changed fields should include title")
        expect(taskDelta.changed.titleYjsState, "Swift changed fields should include CRDT state column")
        expect(!taskDelta.changed.completed, "Swift changed fields should default absent columns to false")
        expect(taskDelta.changed.contains("title"), "Swift changed fields should support contains")
        expect(!taskDelta.changed.contains("unknown_column"), "Swift changed fields should ignore unknown columns")
        expect(taskDelta.crdt.titleYjsState, "Swift CRDT fields should include CRDT state column")
        expect(taskDelta.raw.commitId == "commit-delta", "Swift changed-row helper should retain raw metadata")
        expect(projectChangedRows(in: rowDeltaEvent).first?.isDelete == true, "Swift changed-row helper should expose project deletes")
        expect(commentChangedRows(in: rowDeltaEvent).isEmpty, "Swift changed-row helper should ignore unrelated tables")

        let commitId = try client.mutations.tasks.insert(NewTask(
            id: jsonString(taskInput, "id"),
            title: jsonString(taskInput, "title"),
            completed: jsonInt(taskInput, "completed"),
            userId: jsonString(taskInput, "user_id"),
            projectId: jsonString(taskInput, "project_id")
        ))
        expect(commitId == "commit-swift", "Swift mutation helper should return commit id")
        expect(client.capturedMutations.count == 1, "Swift mutation helper should call applyMutationJson once")
        try expectJsonEqual(try parseJson(client.capturedMutations[0]), jsonValue(taskFixture, "newOperation"), "Swift mutation should match shared new task operation")

        _ = try client.mutations.tasks.update(rowId: jsonString(taskInput, "id"), patch: TaskPatch(completed: 0), baseVersion: 11)
        try expectJsonEqual(try parseJson(client.capturedMutations[1]), jsonValue(taskFixture, "patchOperation"), "Swift patch should match shared task patch operation")
        _ = try client.mutations.tasks.delete(rowId: jsonString(taskInput, "id"), baseVersion: 12)
        try expectJsonEqual(try parseJson(client.capturedMutations[2]), jsonValue(taskFixture, "deleteOperation"), "Swift delete should match shared task delete operation")

        let enqueueCommandId = try client.queuedMutations.tasks.insert(NewTask(
            id: jsonString(taskInput, "id"),
            title: jsonString(taskInput, "title"),
            completed: jsonInt(taskInput, "completed"),
            userId: jsonString(taskInput, "user_id"),
            projectId: jsonString(taskInput, "project_id")
        ))
        expect(enqueueCommandId == "command-swift", "Swift enqueue mutation helper should return command id")
        try expectJsonEqual(try parseJson(client.capturedMutations[3]), jsonValue(taskFixture, "newOperation"), "Swift enqueue mutation should match shared new task operation")

        let leasedCommitId = try client.leasedMutations.tasks.insert(NewTask(
            id: jsonString(taskInput, "id"),
            title: jsonString(taskInput, "title"),
            completed: jsonInt(taskInput, "completed"),
            userId: jsonString(taskInput, "user_id"),
            projectId: jsonString(taskInput, "project_id")
        ))
        expect(leasedCommitId == "commit-leased-swift", "Swift leased mutation helper should return commit id")
        try expectJsonEqual(try parseJson(client.capturedMutations[4]), jsonValue(taskFixture, "newOperation"), "Swift leased mutation should match shared new task operation")

        let queuedLeasedCommandId = try client.queuedLeasedMutations.tasks.insert(NewTask(
            id: jsonString(taskInput, "id"),
            title: jsonString(taskInput, "title"),
            completed: jsonInt(taskInput, "completed"),
            userId: jsonString(taskInput, "user_id"),
            projectId: jsonString(taskInput, "project_id")
        ))
        expect(queuedLeasedCommandId == "command-leased-swift", "Swift queued leased mutation helper should return command id")
        try expectJsonEqual(try parseJson(client.capturedMutations[5]), jsonValue(taskFixture, "newOperation"), "Swift queued leased mutation should match shared new task operation")

        let blobOperation = try encodedJsonObject(SyncularAppOperations.newTask(NewTask(
            id: jsonString(blobTask, "id"),
            title: jsonString(blobTask, "title"),
            completed: 0,
            userId: jsonString(taskInput, "user_id"),
            image: blobRef
        )))
        let blobPayload = jsonObject(blobOperation, "payload")
        try expectJsonEqual(jsonValue(blobPayload, "image"), blobImage, "Swift blob ref mutation payload should be app-shaped JSON")

        let fieldEncryptionConfig = try parseJson(syncularGeneratedFieldEncryptionConfigJson(
            keys: ["default": jsonString(e2eeFixture, "keyBase64")],
            envelopePrefix: jsonString(e2eeFixture, "envelopePrefix"),
            additionalRules: [SyncularFieldEncryptionRule(
                scope: jsonString(e2eeRule, "scope"),
                table: jsonString(e2eeRule, "table"),
                fields: jsonStringArray(e2eeRule, "fields"),
                rowIdField: nil
            )]
        ))
        let fieldEncryptionConfigObject = fieldEncryptionConfig as! [String: Any]
        try expectJsonEqual(jsonValue(fieldEncryptionConfigObject, "rules"), [e2eeRule], "Swift E2EE rules should match shared sync scenario")
        try expectJsonEqual(jsonValue(fieldEncryptionConfigObject, "keys"), ["default": jsonString(e2eeFixture, "keyBase64")], "Swift E2EE keys should match shared sync scenario")
        expect(jsonString(fieldEncryptionConfigObject, "envelopePrefix") == jsonString(e2eeFixture, "envelopePrefix"), "Swift E2EE envelope prefix should match shared sync scenario")

        let rowId = jsonString(crdtField, "rowId")
        let descriptor = try client.openTaskTitleCrdtField(rowId: rowId)
        expect(descriptor.syncMode == "server-merge", "Swift CRDT helper should open server-merge field")
        expect(descriptor.rowIdField == "id", "Swift CRDT helper should decode row id field")
        try expectJsonEqual(try parseJson(client.crdtFieldRequests[0]), crdtField, "Swift CRDT open request should match shared field")
        let applyTextRequest = jsonObject(crdtFixture, "applyTextRequest")
        let crdtReceipt = try client.applyTaskTitleText(rowId: rowId, nextText: jsonString(applyTextRequest, "nextText"))
        expect(crdtReceipt.clientCommitId == "commit-crdt-swift", "Swift CRDT text helper should return write receipt")
        expect(crdtReceipt.syncMode == "server-merge", "Swift CRDT text helper should decode sync mode")
        expect(client.crdtTextRequests.count == 1, "Swift CRDT text helper should call native text API once")
        try expectJsonEqual(try parseJson(client.crdtTextRequests[0]), applyTextRequest, "Swift CRDT text request should match shared envelope")
        let queuedTextRequest = jsonObject(crdtFixture, "enqueueTextRequest")
        let queuedTextCommandId = try client.enqueueTaskTitleText(rowId: rowId, nextText: jsonString(queuedTextRequest, "nextText"))
        expect(queuedTextCommandId == "command-crdt-text-swift", "Swift queued CRDT text helper should return command id")
        expect(client.queuedCrdtTextRequests.count == 1, "Swift queued CRDT text helper should call native enqueue text API once")
        try expectJsonEqual(try parseJson(client.queuedCrdtTextRequests[0]), queuedTextRequest, "Swift queued CRDT text request should match shared envelope")
        let materialized = try client.materializeTaskTitle(rowId: rowId)
        expect(materialized.value == .string("Native CRDT smoke"), "Swift CRDT materialize helper should return typed field value")
        let snapshot = try client.snapshotTaskTitleStateVector(rowId: rowId)
        expect(snapshot.stateVectorBase64 == "vector", "Swift CRDT snapshot helper should return typed state vector")
        let compactionRequest = jsonObject(crdtFixture, "compactionRequest")
        let compact = try client.compactTaskTitle(rowId: rowId, minUncheckpointedUpdates: jsonInt(compactionRequest, "minUncheckpointedUpdates"))
        expect(compact.checkpointCreated == false, "Swift CRDT compact helper should return typed compaction receipt")
        try expectJsonEqual(try parseJson(client.crdtCompactionRequests[0]), compactionRequest, "Swift CRDT compaction request should match shared envelope")
        let queuedCompactionCommandId = try client.enqueueTaskTitleCompaction(rowId: rowId, minUncheckpointedUpdates: jsonInt(compactionRequest, "minUncheckpointedUpdates"))
        expect(queuedCompactionCommandId == "command-crdt-compact-swift", "Swift queued CRDT compaction helper should return command id")
        expect(client.queuedCrdtCompactionRequests.count == 1, "Swift queued CRDT compaction helper should call native enqueue compaction API once")
        try expectJsonEqual(try parseJson(client.queuedCrdtCompactionRequests[0]), compactionRequest, "Swift queued CRDT compaction request should match shared envelope")

        let live = query.liveQuery(id: "live-tasks", label: "Tasks")
        let initialRows = try live.start(on: client)
        expect(initialRows.count == 1, "Swift live query start should refresh rows")
        expect(client.registrations.count == 1, "Swift live query should register once")
        expect(client.registrations[0].id == "live-tasks", "Swift live query registration id")
        expect(client.registrations[0].tables == ["tasks"], "Swift live query registration tables")

        let ignored = try live.refreshIfChanged(
            event: SyncularNativeEvent(kind: "QueriesChanged", queries: ["other-query"]),
            on: client
        )
        expect(ignored == nil, "Swift live query should ignore unrelated query changes")

        let refreshed = try live.refreshIfChanged(
            event: SyncularNativeEvent(kind: "QueriesChanged", queries: ["live-tasks"]),
            on: client
        )
        expect(refreshed?.count == 1, "Swift live query should refresh affected query")
        expect(client.queryRequests.count == 3, "Swift live query should run initial, start, and affected refresh queries")
        let stopped = try live.stop(on: client)
        expect(stopped, "Swift live query stop should unregister")
        expect(client.unregisteredIds == ["live-tasks"], "Swift live query unregister id")

        print("Swift generated client smoke passed")
    }
}
