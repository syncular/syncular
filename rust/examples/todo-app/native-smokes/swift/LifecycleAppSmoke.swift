import Foundation

extension SyncularBoltClient: SyncularNativeJsonClient {}

private func expect(_ condition: Bool, _ message: String) {
    if !condition {
        fatalError(message)
    }
}

private func removeSqliteFiles(_ path: String) {
    let fileManager = FileManager.default
    for suffix in ["", "-wal", "-shm", "-journal"] {
        try? fileManager.removeItem(atPath: path + suffix)
    }
}

private func canonicalJson(_ object: Any) throws -> String {
    let data = try JSONSerialization.data(withJSONObject: object, options: [.sortedKeys])
    return String(data: data, encoding: .utf8)!
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
        if let eventJson = try client.pollEventJsonTimeout(timeoutMs: 100) {
            let event = try syncularDecodeNativeEvent(eventJson)
            let object = try JSONSerialization.jsonObject(with: Data(eventJson.utf8)) as! [String: Any]
            seen.append("\(event.kind):\(event.commandId ?? "-"):\(eventJson)")
            if event.kind == kind && (commandId == nil || event.commandId == commandId) {
                return (event, object)
            }
        }
    }
    fatalError("timed out waiting for native event \(kind) command \(commandId ?? "-"); seen \(seen.joined(separator: ", "))")
}

private func blobRef(fromPayload payload: [String: Any]) throws -> SyncularBlobRef {
    let data = try JSONSerialization.data(withJSONObject: payload, options: [.sortedKeys])
    return try JSONDecoder().decode(SyncularBlobRef.self, from: data)
}

@main
private enum LifecycleAppSmoke {
    static func main() throws {
        let outDir = CommandLine.arguments.dropFirst().first ?? NSTemporaryDirectory()
        try FileManager.default.createDirectory(atPath: outDir, withIntermediateDirectories: true)
        let dbPath = outDir + "/swift-lifecycle-app.sqlite"
        let blobPath = outDir + "/swift-lifecycle-blob.txt"
        removeSqliteFiles(dbPath)
        try Data("swift lifecycle blob".utf8).write(to: URL(fileURLWithPath: blobPath))

        let native = try SyncularBoltClient(open: SyncularBoltClientConfig(
            dbPath: dbPath,
            baseUrl: "http://127.0.0.1:9/sync",
            clientId: "swift-lifecycle-app",
            actorId: "user-rust",
            projectId: "project-rust",
            appSchemaJson: syncularNativeGeneratedAppSchemaJson,
            autoSyncLocalWrites: false
        ))
        defer { _ = try? native.shutdown() }

        try assertSyncularNativeRuntimeManifestJson(try native.runtimeManifestJson())
        expect(try native.setAuthHeadersJson(headersJson: #"{"authorization":"Bearer lifecycle-swift"}"#), "Swift lifecycle app should accept auth headers")
        expect(try native.syncWorkerRunning(), "Swift lifecycle app should keep native worker hot")

        let query = TaskQuery
            .select()
            .filter(TaskQuery.userId.eq("user-rust"))
            .orderBy(TaskQuery.serverVersion.desc())
            .limit(20)
        let live = query.liveQuery(id: "swift-lifecycle-live", label: "Swift lifecycle")
        expect(try live.start(on: native).isEmpty, "Swift lifecycle live query should start empty")

        let blobCommandId = try native.enqueueStoreBlobFileJson(
            path: blobPath,
            optionsJson: #"{"mimeType":"text/plain"}"#
        )
        let (blobEvent, blobObject) = try waitForEvent(
            from: native,
            kind: "WorkerCommandCompleted",
            commandId: blobCommandId
        )
        expect(blobEvent.commandId == blobCommandId, "Swift lifecycle blob event should carry command id")
        let blobPayload = blobObject["payload_json"] as! [String: Any]
        let blobRef = try blobRef(fromPayload: blobPayload)

        let rowId = "task-swift-lifecycle"
        let mutationCommandId = try native.enqueueNewTask(NewTask(
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
        expect(mutationEvent.clientCommitId != nil, "Swift lifecycle mutation event should carry commit id")

        let crdtCommandId = try native.enqueueTaskTitleText(rowId: rowId, nextText: "Swift lifecycle title")
        let (crdtWriteEvent, _) = try waitForEvent(
            from: native,
            kind: "LocalWriteCommitted",
            commandId: crdtCommandId
        )
        expect(crdtWriteEvent.commandId == crdtCommandId, "Swift lifecycle CRDT write should carry command id")
        let (queryEvent, _) = try waitForEvent(from: native, kind: "QueriesChanged")
        _ = try waitForEvent(from: native, kind: "CrdtFieldChanged", commandId: crdtCommandId)

        let rows = try query.fetch(on: native)
        expect(rows.count == 1, "Swift lifecycle query should read queued row")
        expect(rows[0].id == rowId, "Swift lifecycle query should decode row id")
        expect(rows[0].title == "Swift lifecycle title", "Swift lifecycle query should decode CRDT title")
        expect(rows[0].image?.hash == blobRef.hash, "Swift lifecycle query should decode blob ref")
        expect(try live.refreshIfChanged(event: queryEvent, on: native)?.count == 1, "Swift lifecycle live query should refresh from native event")

        let syncCommandId = try native.enqueueSyncNow()
        let (syncEvent, _) = try waitForEvent(
            from: native,
            kind: "SyncFailed",
            commandId: syncCommandId,
            timeoutMs: 8_000
        )
        expect(syncEvent.commandId == syncCommandId, "Swift lifecycle sync failure should carry command id")

        let outbox = try native.outboxSummariesJson()
        expect(outbox.contains(mutationEvent.clientCommitId!), "Swift lifecycle outbox should contain queued mutation")
        expect(outbox.contains(crdtWriteEvent.clientCommitId!), "Swift lifecycle outbox should contain queued CRDT write")
        expect(try live.stop(on: native), "Swift lifecycle live query should unregister")
        expect(try native.shutdown(), "Swift lifecycle app should shut down native client")

        _ = try canonicalJson(blobPayload)
        print("Swift lifecycle app smoke passed")
    }
}
