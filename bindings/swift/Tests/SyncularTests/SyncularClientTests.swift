// Hermetic, offline-first tests for the Swift wrapper against the LOCALLY-built
// libsyncular dylib (check.sh builds it and points the loader at vendor/).
//
// Uses Swift Testing (`import Testing`) — the framework that ships with the
// Swift toolchain (works on Command-Line-Tools, unlike the full XCTest
// framework which needs Xcode). `swift test` runs it directly.
//
// No server required — the syncular client is offline-first by design: a
// `mutate` is optimistic and immediately visible via `readRows`/`query`. That
// is the hermetic path used here. We cover:
//   init/create · command round-trip · mutate → readRows (optimistic row) ·
//   query fast path · error surfacing · close idempotence · a network command
//   failing loudly on the lean core.

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
                "scopes": .array([.object(["pattern": .string("todo:{id}")])]),
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

private final class TestConnectivitySignal: SyncularConnectivitySignal {
    var online = false
    var listener: ((Bool) -> Void)?

    func subscribe(_ listener: @escaping (Bool) -> Void) -> () -> Void {
        self.listener = listener
        return { [weak self] in self?.listener = nil }
    }
}

@Test func initCreatesClient() throws {
    let client = try makeClient()
    defer { client.close() }
    let id = try client.subscribe(scopes: ["id": "t1"])
    #expect(try client.unit(id: id)?["status"]?.stringValue == "active")
    #expect(try client.unit(id: id)?["scopes"] == .object(["id": .string("t1")]))
}

@Test func unitsWindowsAndCatchupCrossTheCommandSurface() throws {
    let client = try makeClient()
    defer { client.close() }
    let ids = try client.subscribeMany(units: [["id": "a"], ["id": "b"]])
    #expect(ids.count == 2)
    #expect(try client.subscribe(scopes: ["id": "a"]) == ids[0])
    #expect(try client.units().count == 2)
    let catchup = try client.unitCatchup(id: ids[0])
    #expect(catchup["state"]?.stringValue == "known")
    #expect(catchup["bootstrapComplete"]?.boolValue == false)
    #expect(try client.unitCatchup(id: "absent")["state"]?.stringValue == "unknown")
    try client.unsubscribe(id: ids[1])
    #expect(try client.unit(id: ids[1]) == nil)

    try client.setWindow(variable: "id", units: ["c", "d"])
    let window = try client.windowState(variable: "id")
    #expect(window.units == ["c", "d"])
    #expect(window.pending == ["c", "d"])
    try client.setWindow(variable: "id", units: [])
    #expect(try client.windowState(variable: "id").units.isEmpty)
    #expect(throws: SyncularError.self) {
        try client.subscribe(scopes: ["id": "*"])
    }
}

@Test func originalConfigLabelsStillConstruct() {
    // The original four labels keep working, so the new policy fields are
    // appended after `dbPath` instead of displacing it.
    let config = SyncularConfig(
        baseUrl: "https://api.example.com",
        wsUrl: nil,
        headers: [:],
        dbPath: "/tmp/replica.db"
    )
    #expect(config.dbPath == "/tmp/replica.db")
    #expect(config.requestTimeoutMs == nil)
}

@Test func policyBoundsAboveDoublePrecisionReachTheCoreExactly() throws {
    // 2^53+1 has no exact Double, and Foundation writes 10^18 as `1e+18`,
    // which the core's u64 parser refuses. Both must travel as the caller's
    // UInt64 instead of a Double, and the core must accept the result.
    let config = SyncularConfig(
        maxRequestBytes: 9_007_199_254_740_993,
        maxResponseBytes: 1_000_000_000_000_000_000
    )
    let json = try config.newConfigJSON().encodedString()
    #expect(json.contains("\"maxRequestBytes\":9007199254740993"))
    #expect(json.contains("\"maxResponseBytes\":1000000000000000000"))
    let client = try SyncularClient(
        clientId: "swift-policy-large",
        schema: todoSchema(),
        config: config
    )
    client.close()
}

@Test func nativeTransportPolicyIsSerializedIntoTheCoreConfig() throws {
    // A valid policy is accepted, and an invalid bound is rejected by the
    // core's config validation, proving the field reaches the native config
    // JSON.
    let client = try SyncularClient(
        clientId: "swift-policy",
        schema: todoSchema(),
        config: SyncularConfig(
            requestTimeoutMs: 1000,
            roundDeadlineMs: 2000,
            maxRequestBytes: 1024,
            maxResponseBytes: 2048,
            redirects: "deny",
            realtimeHeartbeatMs: 5000
        )
    )
    client.close()
    #expect(try SyncularConfig(realtimeHeartbeatMs: 5000).newConfigJSON().encodedString().contains("\"realtimeHeartbeatMs\":5000"))
    #expect(throws: SyncularError.self) {
        _ = try SyncularClient(
            clientId: "swift-policy-bad",
            schema: todoSchema(),
            config: SyncularConfig(requestTimeoutMs: 0)
        )
    }
}

@Test func localAuthorityPathIsSerializedIntoTheCoreConfig() throws {
    let config = SyncularConfig(localAuthorityPath: "/data/authority.sqlite").newConfigJSON()
    #expect(config["localAuthorityPath"] == .string("/data/authority.sqlite"))
    #expect(SyncularConfig().newConfigJSON()["localAuthorityPath"] == nil)
}

@Test func emptyLocalAuthorityPathIsRejectedByTheCoreConfig() {
    var caught: SyncularError?
    do {
        _ = try SyncularClient(schema: todoSchema(), config: SyncularConfig(localAuthorityPath: ""))
    } catch let error as SyncularError { caught = error } catch {}
    #expect(caught?.code == "client.failed")
}

@Test func localAuthorityCommandsWithoutAuthorityPathReportUnconfigured() throws {
    let client = try makeClient()
    defer { client.close() }
    #expect(try client.localAuthorityState() == nil)
    for call in [client.attachLocalAuthority, client.abandonLocalAuthorityAttach] {
        var caught: SyncularError?
        #expect(throws: SyncularError.self) {
            do { try call() } catch let error as SyncularError { caught = error; throw error }
        }
        #expect(caught?.code == "client.local_authority_unconfigured")
    }
}

@Test func localAuthorityServesRoundsInProcess() throws {
    let directory = FileManager.default.temporaryDirectory
        .appendingPathComponent("syncular-authority-\(UUID().uuidString)")
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: directory) }
    // The authority serves only scoped tables (SPEC §3.1).
    let column: (String) -> JSONValue = { name in
        .object(["name": .string(name), "type": .string("string"), "nullable": .bool(false)])
    }
    let schema: JSONValue = .object([
        "version": .number(1),
        "tables": .array([
            .object([
                "name": .string("todo"),
                "primaryKey": .string("id"),
                "scopes": .array([.object(["pattern": .string("list:{list_id}"), "column": .string("list_id")])]),
                "columns": .array([column("id"), column("list_id")]),
            ])
        ]),
    ])
    let client = try SyncularClient(
        clientId: "swift-authority",
        schema: schema,
        config: SyncularConfig(localAuthorityPath: directory.appendingPathComponent("authority.sqlite").path)
    )
    defer { client.close() }
    #expect(try client.localAuthorityState() == .local)
    try client.subscribe(scopes: ["list_id": "l1"])
    _ = try client.mutate([
        .object([
            "op": .string("upsert"),
            "table": .string("todo"),
            "values": .object(["id": .string("t1"), "list_id": .string("l1")]),
        ])
    ])
    try client.syncUntilIdle()
    #expect(try client.pendingCommitIds().isEmpty)
    // The authority acknowledged the commit: the row carries a server version.
    #expect(try client.readRows(table: "todo").first?["version"]?.numberValue == 1)
}

@Test func errorCarriesStructuredDetails() {
    let details = JSONValue.object(["reason": .string("r")])
    #expect(SyncularError(code: "sync.attach_rejected", message: "m", details: details).details == details)
    #expect(SyncularError(code: "x", message: "m").details == nil)
}

@Test func mutateThenReadRowsShowsOptimisticRow() throws {
    let client = try makeClient()
    defer { client.close() }
    try client.subscribe(scopes: ["id": "t1"])

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
    try client.subscribe(scopes: ["id": "t1"])
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
        params: .object(["scopes": .object(["id": .string("t2")])])
    )
    #expect(result["id"]?.stringValue != nil)
}

@Test func rotatesTransportHeadersWithoutRecreatingTheClient() throws {
    let client = try makeClient()
    defer { client.close() }
    try client.setHeaders(["authorization": "Bearer fresh"])
    let id = try client.subscribe(scopes: ["id": "after-rotation"])
    #expect(try client.unit(id: id)?["status"]?.stringValue == "active")
}

@Test func connectivityAdapterPausesResumesAndDetaches() throws {
    let client = try makeClient()
    defer { client.close() }
    let signal = TestConnectivitySignal()
    let adapter = SyncularConnectivityAdapter(client: client, signal: signal)
    #expect(signal.listener != nil)
    signal.listener?(true)
    try client.subscribe(scopes: ["id": "after-connectivity"])
    adapter.stop()
    #expect(signal.listener == nil)
}

/// Answers the named methods with a fixed host reply; every other command (the
/// `create` in `init` included) reaches the core.
private final class StubbedReplyClient: SyncularClient {
    var replies: [String: JSONValue] = [:]

    override func command(method: String, params: JSONValue) throws -> JSONValue {
        if let reply = replies[method] { return reply }
        return try super.command(method: method, params: params)
    }
}

@Test func syncUntilIdleForwardsTimeoutMsToTheCore() throws {
    let client = try makeClient()
    defer { client.close() }
    var caught: SyncularError?
    do { try client.syncUntilIdle(timeoutMs: 0) } catch let error as SyncularError { caught = error } catch {}
    #expect(caught?.code == "sync.invalid_request")
    #expect(caught?.message.contains("timeoutMs") == true)
}

@Test func typedReadsThrowInvalidHostResponseWhenTheFieldIsMissing() throws {
    let client = try StubbedReplyClient(clientId: "swift-stub", schema: todoSchema())
    defer { client.close() }
    for method in ["readRows", "query", "pendingCommitIds", "conflicts", "presence"] {
        client.replies[method] = .object([:])
    }
    let reads: [() throws -> Any] = [
        { try client.readRows(table: "todo") },
        { try client.query("SELECT 1") },
        { try client.pendingCommitIds() },
        { try client.conflicts() },
        { try client.presence(scopeKey: "k") },
    ]
    for read in reads {
        var caught: SyncularError?
        do { _ = try read() } catch let error as SyncularError { caught = error } catch {}
        #expect(caught?.code == "client.invalid_host_response")
    }
    client.replies["pendingCommitIds"] = .object(["ids": .array([.string("a"), .number(1)])])
    var caught: SyncularError?
    do { _ = try client.pendingCommitIds() } catch let error as SyncularError { caught = error } catch {}
    #expect(caught?.code == "client.invalid_host_response")
}

@Test func errorReplySurfacesAsSyncularError() throws {
    let client = try makeClient()
    defer { client.close() }
    #expect(throws: SyncularError.self) {
        try client.readRows(table: "does_not_exist")
    }
}

@Test func snapshotsAndPendingOutcomesAfterOfflineMutate() throws {
    let client = try makeClient()
    defer { client.close() }
    try client.subscribe(scopes: ["id": "t1"])
    let id = try client.mutate([upsert(id: "t1", title: "x")])
    #expect(try client.pendingCommitIds() == [id])
    #expect(try client.statusSnapshot()["outbox"]?.numberValue == 1)
    #expect(try client.querySnapshot("SELECT title FROM todo")["rows"]?.arrayValue?.count == 1)
    #expect(try client.diagnosticsSnapshot()["replica"]?["pendingOutbox"]?.numberValue == 1)
    #expect(try client.commitOutcome(clientCommitId: id) == nil)
    #expect(try client.commitOutcomes().isEmpty)
    #expect(try client.rejections().isEmpty)
    #expect(throws: SyncularError.self) {
        try client.resolveCommitOutcome(.object(["clientCommitId": .string(id), "resolution": .string("dismissed")]))
    }
    for method in ["schemaFloor", "leaseState", "upgrading", "syncNeeded"] {
        #expect(throws: SyncularError.self) { try client.command(method: method, params: .object([:])) }
    }
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

@Test func aRealtimeWakeEventIsAnsweredWithDrainRealtimeAndNotDelivered() throws {
    // The lean core has no socket, so the wake goes straight to the poll loop's
    // dispatch. On a closed client a command throws `client.closed`, which
    // shows the wake issued one while another event type issues none.
    let queue = DispatchQueue(label: "syncular.test.delivery")
    let client = try SyncularClient(clientId: "swift-wake", schema: todoSchema(), deliveryQueue: queue)
    var delivered: [String] = []
    client.onEvent = { delivered.append($0.type) }
    try client.handleEvent(#"{"type":"realtime-wake"}"#)
    try client.handleEvent(#"{"type":"presence","scopeKey":"room:1"}"#)
    client.close()
    queue.sync {}
    // The running poll loop may also deliver the core's own events.
    #expect(delivered.contains("presence"))
    #expect(!delivered.contains("realtime-wake"))
    #expect(throws: SyncularError.self) {
        try client.handleEvent(#"{"type":"realtime-wake"}"#)
    }
}

@Test func pauseResumeStopsAndRestartsPollLoop() throws {
    let client = try makeClient()
    defer { client.close() }
    client.pause()  // stops the loop; disconnectRealtime best-effort no-ops
    client.resume() // restarts the loop
    // Still functional after a pause/resume cycle.
    let id = try client.subscribe(scopes: ["id": "t1"])
    #expect(try client.unit(id: id)?["status"]?.stringValue == "active")
}
