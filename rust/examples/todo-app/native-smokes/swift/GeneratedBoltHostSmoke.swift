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

private func pollEvents(from client: SyncularBoltClient, maxCount: Int = 8) throws -> [SyncularNativeEvent] {
    var events: [SyncularNativeEvent] = []
    for _ in 0..<maxCount {
        guard let eventJson = try client.pollEventJsonTimeout(timeoutMs: 0) else {
            break
        }
        events.append(try syncularDecodeNativeEvent(eventJson))
    }
    return events
}

@main
private enum GeneratedBoltHostSmoke {
    static func main() throws {
        let dbPath = CommandLine.arguments.dropFirst().first
            ?? NSTemporaryDirectory() + "/syncular-swift-bolt-host.sqlite"
        removeSqliteFiles(dbPath)

        let client = try SyncularBoltClient(open: SyncularBoltClientConfig(
            dbPath: dbPath,
            baseUrl: "http://127.0.0.1:9/sync",
            clientId: "swift-bolt-host",
            actorId: "user-rust",
            projectId: "project-rust",
            autoSyncLocalWrites: false
        ))
        defer { _ = try? client.shutdown() }

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

        let commitId = try client.applyNewTask(NewTask(
            id: "task-swift-bolt",
            title: "Swift Bolt host",
            completed: 1,
            userId: "user-rust",
            projectId: "project-rust"
        ))
        expect(!commitId.isEmpty, "Swift host mutation should return a commit id")

        let events = try pollEvents(from: client)
        expect(events.contains(where: { $0.kind == "RowsChanged" && $0.tables == ["tasks"] }), "Swift host should emit task rows changed")
        expect(events.contains(where: { $0.kind == "QueriesChanged" && $0.queries == ["swift-bolt-live"] }), "Swift host should emit live query changed")

        let rows = try query.fetch(on: client)
        expect(rows.count == 1, "Swift host query should read inserted task")
        expect(rows[0].id == "task-swift-bolt", "Swift host query should decode inserted id")
        expect(rows[0].title == "Swift Bolt host", "Swift host query should decode inserted title")

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
