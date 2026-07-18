// Hermetic, offline-first tests for the Swift wrapper against the LOCALLY-built
// libsyncular dylib (check.sh builds it and points the loader at vendor/).
//
// Uses Swift Testing (`import Testing`) — the framework that ships with the
// Swift toolchain (works on Command-Line-Tools, unlike the full XCTest
// framework which needs Xcode). `swift test` runs it directly.
//
// No server required — the syncular client is offline-first by design: a
// `mutate` is optimistic and immediately visible via `readRows`/`query`. That
// is the elegant hermetic path the roadmap calls for. We cover:
//   init/create · command round-trip · mutate → readRows (optimistic row) ·
//   query fast path · error surfacing · event poll (none pending) · close
//   idempotence · a network command failing loudly on the lean core.

import Testing
import Foundation
@testable import Syncular

/// The minimal single-table schema the offline tests use.
private func todoSchema() -> JSONValue {
    .object([
        "version": .number(1),
        "tables": .array([
            .object([
                "name": .string("todo"),
                "primaryKey": .string("id"),
                "scopes": .array([]),
                "columns": .array([
                    .object([
                        "name": .string("id"),
                        "type": .string("string"),
                        "nullable": .bool(false),
                    ]),
                    .object([
                        "name": .string("title"),
                        "type": .string("string"),
                        "nullable": .bool(false),
                    ]),
                ]),
            ])
        ]),
    ])
}

private func makeClient() throws -> SyncularClient {
    try SyncularClient(clientId: "swift-test", schema: todoSchema())
}

private func upsert(id: String, title: String) -> JSONValue {
    .object([
        "op": .string("upsert"),
        "table": .string("todo"),
        "values": .object(["id": .string(id), "title": .string(title)]),
    ])
}

@Test func initCreatesClient() throws {
    let client = try makeClient()
    defer { client.close() }
    try client.subscribe(id: "s1", table: "todo")
    #expect(try client.subscriptionState(id: "s1") == "active")
}

@Test func mutateThenReadRowsShowsOptimisticRow() throws {
    let client = try makeClient()
    defer { client.close() }
    try client.subscribe(id: "s1", table: "todo")

    let commitId = try client.mutate([upsert(id: "t1", title: "hello")])
    #expect(!commitId.isEmpty)

    // Offline-first: the row is visible immediately, no server round trip.
    // readRows yields RowState objects; the column values live under `values`.
    let rows = try client.readRows(table: "todo")
    #expect(rows.count == 1)
    #expect(rows.first?["values"]?["title"]?.stringValue == "hello")
    // Optimistic rows carry version -1 until a sync assigns the server version.
    #expect(rows.first?["version"]?.numberValue == -1)
}

@Test func queryFastPath() throws {
    let client = try makeClient()
    defer { client.close() }
    try client.subscribe(id: "s1", table: "todo")
    _ = try client.mutate([upsert(id: "t1", title: "world")])
    let rows = try client.query("SELECT title FROM todo WHERE id = ?", params: [.string("t1")])
    #expect(rows.count == 1)
    #expect(rows.first?["title"]?.stringValue == "world")
}

@Test func rawCommandRoundTrip() throws {
    let client = try makeClient()
    defer { client.close() }
    let result = try client.command(
        method: "subscribe",
        params: .object(["id": .string("s2"), "table": .string("todo"), "scopes": .object([:])])
    )
    #expect(result.objectValue != nil)
}

@Test func errorReplySurfacesAsSyncularError() throws {
    let client = try makeClient()
    defer { client.close() }
    #expect(throws: SyncularError.self) {
        try client.readRows(table: "does_not_exist")
    }
}

@Test func pollEventNonBlockingWhenNoneQueued() async throws {
    let client = try makeClient()
    defer { client.close() }
    // Creation emits one privacy-safe diagnostics snapshot. Once startup
    // evidence has drained, idle polling must not invent repeated events.
    let box = EventBox()
    client.onEvent = { _ in box.mark() }
    try await Task.sleep(nanoseconds: 300_000_000)
    let startupCount = box.count
    try await Task.sleep(nanoseconds: 300_000_000)
    #expect(box.count == startupCount)
}

@Test func pendingCommitsAfterOfflineMutate() throws {
    let client = try makeClient()
    defer { client.close() }
    try client.subscribe(id: "s1", table: "todo")
    _ = try client.mutate([upsert(id: "t1", title: "x")])
    // The offline outbox holds the unsynced commit (the honest "unsynced work"
    // signal; `syncNeeded` reflects a server-push wake, not local mutations).
    #expect(try !client.pendingCommitIds().isEmpty)
}

@Test func networkCommandReportsTransportUnavailableOnLeanCore() throws {
    // The default dylib is the lean build (no native-transport). By design
    // `sync()` never errors out-of-band — it returns {ok:false, errorCode} so
    // the caller sees the failed round honestly rather than a silent no-op.
    let client = try makeClient()
    defer { client.close() }
    let outcome = try client.sync()
    #expect(outcome["ok"]?.boolValue == false)
    #expect(outcome["errorCode"]?.stringValue?.contains("transport") == true)
}

@Test func closeIsIdempotentAndCommandsThrowAfter() throws {
    let client = try makeClient()
    client.close()
    client.close() // idempotent
    var caught: SyncularError?
    #expect(throws: SyncularError.self) {
        do { _ = try client.readRows(table: "todo") }
        catch let error as SyncularError { caught = error; throw error }
    }
    #expect(caught?.code == "client.closed")
}

@Test func pauseResumeStopsAndRestartsPollLoop() throws {
    let client = try makeClient()
    defer { client.close() }
    client.pause()  // stops the loop; disconnectRealtime best-effort no-ops
    client.resume() // restarts the loop
    // Still functional after a pause/resume cycle.
    try client.subscribe(id: "s1", table: "todo")
    #expect(try client.subscriptionState(id: "s1") == "active")
}

/// A tiny thread-safe counter for the inverted event-poll assertion.
private final class EventBox: @unchecked Sendable {
    private let lock = NSLock()
    private var value = 0
    func mark() { lock.lock(); value += 1; lock.unlock() }
    var count: Int { lock.lock(); defer { lock.unlock() }; return value }
}
