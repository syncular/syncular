import Foundation

extension SyncularBoltClient: SyncularNativeJsonClient {}

enum SyncularLifecycleScenarioError: Error, CustomStringConvertible {
    case failed(String)

    var description: String {
        switch self {
        case .failed(let message):
            message
        }
    }
}

private func lifecycleExpect(_ condition: Bool, _ message: String) throws {
    if !condition {
        throw SyncularLifecycleScenarioError.failed(message)
    }
}

private func removeSqliteFiles(_ path: String) {
    let fileManager = FileManager.default
    for suffix in ["", "-wal", "-shm", "-journal"] {
        try? fileManager.removeItem(atPath: path + suffix)
    }
}

private func waitForEvent(
    from client: SyncularBoltClient,
    kind: String,
    commandId: String? = nil,
    timeoutMs: UInt64 = 5_000
) throws -> (SyncularNativeEvent, [String: Any]) {
    let deadline = Date().addingTimeInterval(Double(timeoutMs) / 1_000.0)
    var seen: [String] = []
    while Date() < deadline {
        if let eventJson = try client.nextEventJsonTimeout(timeoutMs: 50) {
            let event = try syncularDecodeNativeEvent(eventJson)
            let object = try JSONSerialization.jsonObject(with: Data(eventJson.utf8)) as! [String: Any]
            seen.append("\(event.kind):\(event.commandId ?? "-")")
            if event.kind == kind && (commandId == nil || event.commandId == commandId) {
                return (event, object)
            }
        }
    }
    throw SyncularLifecycleScenarioError.failed(
        "timed out waiting for native event \(kind) command \(commandId ?? "-"); seen \(seen.joined(separator: ", "))"
    )
}

private func blobRef(fromPayload payload: [String: Any]) throws -> SyncularBlobRef {
    let data = try JSONSerialization.data(withJSONObject: payload, options: [.sortedKeys])
    return try JSONDecoder().decode(SyncularBlobRef.self, from: data)
}

enum SyncularIOSLifecycleScenario {
    static func run() throws {
        let outDir = FileManager.default.temporaryDirectory
            .appendingPathComponent("syncular-ios-lifecycle-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: outDir, withIntermediateDirectories: true)
        let dbPath = outDir.appendingPathComponent("ios-lifecycle.sqlite").path
        let blobPath = outDir.appendingPathComponent("ios-lifecycle-blob.txt").path
        removeSqliteFiles(dbPath)
        try Data("ios lifecycle blob".utf8).write(to: URL(fileURLWithPath: blobPath))

        let native = try SyncularBoltClient(open: SyncularBoltClientConfig(
            dbPath: dbPath,
            baseUrl: "http://127.0.0.1:9/sync",
            clientId: "ios-lifecycle-app",
            actorId: "user-rust",
            projectId: "project-rust",
            appSchemaJson: syncularNativeGeneratedAppSchemaJson,
            autoSyncLocalWrites: false
        ))
        defer { _ = try? native.shutdown() }
        try lifecycleExpect(try native.startEventStream(capacity: 256), "iOS lifecycle should start native event stream")

        try assertSyncularNativeRuntimeManifestJson(try native.runtimeManifestJson())
        try lifecycleExpect(
            try native.setAuthHeadersJson(headersJson: #"{"authorization":"Bearer lifecycle-ios"}"#),
            "iOS lifecycle app should accept auth headers"
        )
        try lifecycleExpect(try native.syncWorkerRunning(), "iOS lifecycle app should keep native worker hot")

        let query = TaskQuery
            .select()
            .filter(TaskQuery.userId.eq("user-rust"))
            .orderBy(TaskQuery.serverVersion.desc())
            .limit(20)
        let live = query.liveQuery(id: "ios-lifecycle-live", label: "iOS lifecycle")
        try lifecycleExpect(try live.start(on: native).isEmpty, "iOS lifecycle live query should start empty")

        let blobCommandId = try native.enqueueStoreBlobFileJson(
            path: blobPath,
            optionsJson: #"{"mimeType":"text/plain"}"#
        )
        let (blobEvent, blobObject) = try waitForEvent(
            from: native,
            kind: "WorkerCommandCompleted",
            commandId: blobCommandId
        )
        try lifecycleExpect(blobEvent.commandId == blobCommandId, "iOS lifecycle blob event should carry command id")
        let blobPayload = blobObject["payload_json"] as! [String: Any]
        let blobRef = try blobRef(fromPayload: blobPayload)

        let rowId = "task-ios-lifecycle"
        let mutationCommandId = try native.queuedMutations.tasks.insert(NewTask(
            id: rowId,
            title: "",
            completed: 0,
            userId: "user-rust",
            projectId: "project-rust",
            image: blobRef
        ))
        let (mutationEvent, _) = try waitForEvent(
            from: native,
            kind: "LocalWriteCommitted",
            commandId: mutationCommandId
        )
        try lifecycleExpect(mutationEvent.clientCommitId != nil, "iOS lifecycle mutation event should carry commit id")

        let crdtCommandId = try native.enqueueTaskTitleText(rowId: rowId, nextText: "iOS lifecycle title")
        let (crdtWriteEvent, _) = try waitForEvent(
            from: native,
            kind: "LocalWriteCommitted",
            commandId: crdtCommandId
        )
        try lifecycleExpect(crdtWriteEvent.commandId == crdtCommandId, "iOS lifecycle CRDT write should carry command id")
        let (queryEvent, _) = try waitForEvent(from: native, kind: "QueriesChanged")
        _ = try waitForEvent(from: native, kind: "CrdtFieldChanged", commandId: crdtCommandId)

        let rows = try query.fetch(on: native)
        try lifecycleExpect(rows.count == 1, "iOS lifecycle query should read queued row")
        try lifecycleExpect(rows[0].id == rowId, "iOS lifecycle query should decode row id")
        try lifecycleExpect(rows[0].title == "iOS lifecycle title", "iOS lifecycle query should decode CRDT title")
        try lifecycleExpect(rows[0].image?.hash == blobRef.hash, "iOS lifecycle query should decode blob ref")
        try lifecycleExpect(
            try live.refreshIfChanged(event: queryEvent, on: native)?.count == 1,
            "iOS lifecycle live query should refresh from native event"
        )

        let syncCommandId = try native.enqueueSyncNow()
        let (syncEvent, _) = try waitForEvent(
            from: native,
            kind: "SyncFailed",
            commandId: syncCommandId,
            timeoutMs: 8_000
        )
        try lifecycleExpect(syncEvent.commandId == syncCommandId, "iOS lifecycle sync failure should carry command id")

        let outbox = try native.outboxSummariesJson()
        try lifecycleExpect(
            outbox.contains(mutationEvent.clientCommitId!),
            "iOS lifecycle outbox should contain queued mutation"
        )
        try lifecycleExpect(
            outbox.contains(crdtWriteEvent.clientCommitId!),
            "iOS lifecycle outbox should contain queued CRDT write"
        )
        try lifecycleExpect(try live.stop(on: native), "iOS lifecycle live query should unregister")
        try lifecycleExpect(try native.shutdown(), "iOS lifecycle app should shut down native client")
    }
}
