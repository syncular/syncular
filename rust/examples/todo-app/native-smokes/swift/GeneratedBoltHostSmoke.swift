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

private func readEvents(from client: SyncularBoltClient, count: Int) throws -> [SyncularNativeEvent] {
    var events: [SyncularNativeEvent] = []
    let deadline = Date().addingTimeInterval(5.0)
    while events.count < count && Date() < deadline {
        if let eventJson = try client.nextEventJsonTimeout(timeoutMs: 50) {
            events.append(try syncularDecodeNativeEvent(eventJson))
        }
    }
    expect(events.count == count, "Swift host expected \(count) native events, got \(events.count)")
    return events
}

@main
private enum GeneratedBoltHostSmoke {
    static func main() throws {
        let dbPath = CommandLine.arguments.dropFirst().first
            ?? NSTemporaryDirectory() + "/syncular-swift-bolt-host.sqlite"
        removeSqliteFiles(dbPath)

        let config = SyncularBoltClientConfig(
            dbPath: dbPath,
            baseUrl: "http://127.0.0.1:9/sync",
            clientId: "swift-bolt-host",
            actorId: "user-rust",
            projectId: "project-rust",
            appSchemaJson: syncularNativeGeneratedAppSchemaJson,
            autoSyncLocalWrites: false
        )
        let client = try SyncularBoltClient(openAsync: config)
        defer { _ = try? client.shutdown() }
        expect(try client.openCommandId()?.hasPrefix("native-open-") == true, "Swift host async open should expose command id")
        expect(try client.finishOpenTimeout(timeoutMs: 5_000), "Swift host async open should finish")
        expect(try client.isOpenFinished(), "Swift host async open should report finished")
        expect(try client.openCommandId() == nil, "Swift host async open command id should clear after ready")
        expect(try client.startEventStream(capacity: 256), "Swift host should start native event stream")

        try assertSyncularNativeRuntimeManifestJson(try client.runtimeManifestJson())
        expect(try client.setAuthHeadersJson(headersJson: #"{"authorization":"Bearer local-swift"}"#), "Swift host should accept auth headers")

        expect(try client.syncWorkerRunning(), "Swift host worker should start")
        expect(try client.pauseSyncWorker(), "Swift host worker should pause")
        expect(!(try client.syncWorkerRunning()), "Swift host worker should report paused")
        expect(try client.resumeSyncWorker(), "Swift host worker should resume")
        expect(try client.syncWorkerRunning(), "Swift host worker should report running")
        expect(try client.pauseSyncWorker(), "Swift host worker should pause before offline local writes")

        let query = TaskQuery
            .select()
            .filter(TaskQuery.userId.eq("user-rust"))
            .orderBy(TaskQuery.serverVersion.desc())
            .limit(10)
        let live = query.liveQuery(id: "swift-bolt-live", label: "Swift host")
        let initialRows = try live.start(on: client)
        expect(initialRows.isEmpty, "Swift host live query should start empty")
        expect(try client.observedQueriesJson().contains("swift-bolt-live"), "Swift host should register observed query")

        let commitId = try client.mutations.tasks.insert(NewTask(
            id: "task-swift-bolt",
            title: "",
            completed: 1,
            userId: "user-rust",
            projectId: "project-rust"
        ))
        expect(!commitId.isEmpty, "Swift host mutation should return a commit id")

        let crdtReceipt = try client.applyTaskTitleText(rowId: "task-swift-bolt", nextText: "Swift Bolt CRDT")
        expect(crdtReceipt.syncMode == "server-merge", "Swift host CRDT text helper should return server-merge receipt")
        let materializedTitle = try client.materializeTaskTitle(rowId: "task-swift-bolt")
        expect(materializedTitle.value == .string("Swift Bolt CRDT"), "Swift host CRDT materialize helper should read updated title")

        let events = try readEvents(from: client, count: 5)
        expect(events.contains(where: { $0.kind == "RowsChanged" && $0.tables == ["tasks"] }), "Swift host should emit task rows changed")
        expect(events.contains(where: { $0.kind == "QueriesChanged" && $0.queries == ["swift-bolt-live"] }), "Swift host should emit live query changed")
        expect(events.contains(where: { $0.kind == "CrdtFieldChanged" && $0.tables.contains("tasks") }), "Swift host should emit CRDT field changed")

        let rows = try query.fetch(on: client)
        expect(rows.count == 1, "Swift host query should read inserted task")
        expect(rows[0].id == "task-swift-bolt", "Swift host query should decode inserted id")
        expect(rows[0].title == "Swift Bolt CRDT", "Swift host query should decode CRDT title")

        let queryEvent = events.first { $0.kind == "QueriesChanged" }!
        let refreshedRows = try live.refreshIfChanged(event: queryEvent, on: client)
        expect(refreshedRows?.count == 1, "Swift host live query should refresh from native event")

        let outbox = try client.outboxSummariesJson()
        expect(outbox.contains(commitId), "Swift host outbox summaries should contain commit")
        expect(try live.stop(on: client), "Swift host live query should unregister")
        expect(!(try client.observedQueriesJson().contains("swift-bolt-live")), "Swift host should remove observed query")
        expect(try client.shutdown(), "Swift host should shut down native client")

        print("Swift generated Bolt host smoke passed")
    }
}
