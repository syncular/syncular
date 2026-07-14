// SyncularClient — an idiomatic Swift wrapper over the syncular-ffi C core.
//
// The native core (rust/crates/ffi) is callback-free and speaks one JSON
// command surface: `command_json` in, `{result|error}` JSON out, bytes as
// `{"$bytes":"<hex>"}`. This wrapper is deliberately THIN — it owns the opaque
// handle, marshals JSON, exposes typed conveniences over the common commands,
// and runs the `poll_event` loop on a background queue, delivering events on
// the main queue. Sync/lifecycle logic that isn't in the core lives here (the
// wrapper owns lifecycle per the roadmap): `pause()`/`resume()`.
//
// Thread-affinity: the core is thread-affine (drive one handle from one
// thread). This wrapper serializes ALL command dispatch through a private
// serial queue, and the poll loop runs on its own queue but only ever calls
// `poll_event` (which is safe to call while commands run — it drains a
// separate blocking queue inside the core). Never call the FFI directly.

import Foundation
import CSyncularFFI

/// An event surfaced by the native core's `poll_event`: exact revisioned
/// `change` batches, explicit `sync-intent`, or ephemeral `presence`. The raw
/// JSON is preserved for forward-compatibility; `type` is lifted for switching.
public struct SyncularEvent: Sendable {
    /// The event discriminator (`"change"`, `"sync-intent"`, …).
    public let type: String
    /// The full decoded event object (includes any extra fields like `count`).
    public let payload: [String: JSONValue]

    public init(type: String, payload: [String: JSONValue]) {
        self.type = type
        self.payload = payload
    }
}

/// The error a `{error}` reply surfaces (mirrors the web-client `ClientSyncError`
/// and the Tauri bridge's `TauriSyncError`): a stable `code` plus a message.
public struct SyncularError: Error, Sendable, CustomStringConvertible {
    public let code: String
    public let message: String
    public init(code: String, message: String) {
        self.code = code
        self.message = message
    }
    public var description: String { "SyncularError(\(code)): \(message)" }
}

/// Configuration for a `SyncularClient`. `baseUrl` engages the native HTTP+WS
/// transport (only in a `native-transport` build of the core); omit it for the
/// dependency-lean, offline-first local core. `dbPath` installs a file-backed
/// SQLite database so state persists across launches; omit for in-memory.
public struct SyncularConfig: Sendable {
    /// Base URL of the sync server mount, e.g. `https://host/sync`. Requires a
    /// core built with the `native-transport` feature; ignored by the lean core
    /// (network commands then fail with `transport.unavailable`).
    public var baseUrl: String?
    /// Optional explicit realtime socket URL. Derived from `baseUrl` if nil.
    public var wsUrl: String?
    /// Extra request headers (auth, tenant, …) for the native transport.
    public var headers: [String: String]
    /// Path to the on-disk SQLite database. Nil → in-memory (no persistence).
    public var dbPath: String?

    public init(
        baseUrl: String? = nil,
        wsUrl: String? = nil,
        headers: [String: String] = [:],
        dbPath: String? = nil
    ) {
        self.baseUrl = baseUrl
        self.wsUrl = wsUrl
        self.headers = headers
        self.dbPath = dbPath
    }

    /// The `syncular_client_new` config JSON. `dbPath` rides on `create`, not
    /// here, so only transport fields belong in the constructor config.
    fileprivate func newConfigJSON() -> JSONValue {
        var object: [String: JSONValue] = [:]
        if let baseUrl { object["baseUrl"] = .string(baseUrl) }
        if let wsUrl { object["wsUrl"] = .string(wsUrl) }
        if !headers.isEmpty {
            object["headers"] = .object(headers.mapValues { .string($0) })
        }
        return .object(object)
    }
}

/// A closure or delegate that receives client-observable events on the MAIN
/// queue. Use `onEvent` for a closure, or set `delegate`.
public protocol SyncularClientDelegate: AnyObject {
    func syncularClient(_ client: SyncularClient, didReceive event: SyncularEvent)
}

/// The idiomatic wrapper. Construct with a schema (and optionally an explicit
/// clientId), then use the typed conveniences or the raw `command`.
public final class SyncularClient {
    private var handle: OpaquePointer?
    /// Serializes ALL command dispatch (the core is thread-affine).
    private let commandQueue = DispatchQueue(label: "syncular.command")
    /// Runs the blocking `poll_event` loop.
    private let pollQueue = DispatchQueue(label: "syncular.poll")
    /// Where delivered events run (default: main).
    private let deliveryQueue: DispatchQueue
    private let pollLock = NSLock()
    private var pollRunning = false
    /// Signals when a started poll loop has fully exited its `poll_event` call.
    /// `stopPollLoop()`/`close()` wait on this so the core handle is NEVER freed
    /// while a thread blocks inside `poll_event` (which would drop the core's
    /// event-queue condvar under a waiter → a use-after-free panic).
    private var pollDone: DispatchSemaphore?
    private var closed = false

    /// A closure invoked on `deliveryQueue` (main by default) per event.
    public var onEvent: ((SyncularEvent) -> Void)?
    /// A delegate invoked on `deliveryQueue` per event.
    public weak var delegate: SyncularClientDelegate?

    // MARK: - Construction

    /// Create the native core and issue `create` with the given schema.
    /// Starts the background event poll loop. Throws if the core cannot be
    /// constructed or `create` fails.
    ///
    /// - Parameters:
    ///   - clientId: optional explicit stable id. When nil, the core creates
    ///     and persists one in the database.
    ///   - schema: the generated schema JSON (from typegen), as a `JSONValue`.
    ///   - config: transport + db path configuration.
    ///   - limits: optional §4.2 client limits, forwarded to `create`.
    ///   - deliveryQueue: where events are delivered (default `.main`).
    public init(
        clientId: String? = nil,
        schema: JSONValue,
        config: SyncularConfig = SyncularConfig(),
        limits: JSONValue? = nil,
        deliveryQueue: DispatchQueue = .main
    ) throws {
        self.deliveryQueue = deliveryQueue
        let configJSON = try config.newConfigJSON().encodedString()
        guard let created = configJSON.withCString({ syncular_client_new($0) }) else {
            throw SyncularError(
                code: "client.failed",
                message: "syncular_client_new returned null (malformed config or unsupported transport)"
            )
        }
        self.handle = OpaquePointer(created)

        var createParams: [String: JSONValue] = ["schema": schema]
        if let clientId { createParams["clientId"] = .string(clientId) }
        if let dbPath = config.dbPath { createParams["dbPath"] = .string(dbPath) }
        if let limits { createParams["limits"] = limits }
        _ = try command(method: "create", params: .object(createParams))

        startPollLoop()
    }

    deinit {
        close()
    }

    // MARK: - Raw command

    /// Run one raw JSON command through the core. Returns the `result` value,
    /// or throws `SyncularError` on an `{error}` reply. Serialized on the
    /// command queue (the core is thread-affine).
    @discardableResult
    public func command(method: String, params: JSONValue) throws -> JSONValue {
        let request = JSONValue.object(["method": .string(method), "params": params])
        let requestJSON = try request.encodedString()
        let reply: JSONValue = try commandQueue.sync {
            guard let handle = self.handle, !self.closed else {
                throw SyncularError(code: "client.closed", message: "client is closed")
            }
            let replyPtr = requestJSON.withCString {
                syncular_client_command(UnsafeMutableRawPointer(handle), $0)
            }
            guard let replyPtr else {
                throw SyncularError(code: "client.failed", message: "null reply (null handle)")
            }
            defer { syncular_free_string(replyPtr) }
            let replyString = String(cString: replyPtr)
            return try JSONValue(decoding: replyString)
        }
        if case let .object(fields) = reply, let error = fields["error"],
           case let .object(errorFields) = error {
            let code = errorFields["code"]?.stringValue ?? "client.failed"
            let message = errorFields["message"]?.stringValue ?? "command failed"
            throw SyncularError(code: code, message: message)
        }
        if case let .object(fields) = reply, let result = fields["result"] {
            return result
        }
        // Defensive: a well-formed core always returns {result} or {error}.
        return reply
    }

    // MARK: - Typed conveniences (mirror the command surface)

    /// Apply local mutations optimistically; returns the client commit id.
    /// Works OFFLINE — the row is visible immediately via `readRows`/`query`.
    @discardableResult
    public func mutate(_ mutations: [JSONValue]) throws -> String {
        let result = try command(method: "mutate", params: .object(["mutations": .array(mutations)]))
        guard case let .object(fields) = result, let id = fields["clientCommitId"]?.stringValue else {
            throw SyncularError(code: "client.failed", message: "mutate returned no clientCommitId")
        }
        return id
    }

    // MARK: - Native CRDT (SPEC.md §5.10.5; needs the plugin/FFI `crdt-yjs` feature)

    /// Materialize the collaborative text of a `crdt` column — the app-visible
    /// value decoded from the stored (server-merged) Yjs bytes. `name` selects
    /// the shared text inside the doc (default `"text"`). An absent row / NULL
    /// column is the empty document (empty string).
    public func crdtText(
        table: String,
        rowId: String,
        column: String,
        name: String = "text"
    ) throws -> String {
        let result = try command(
            method: "crdtText",
            params: .object([
                "table": .string(table), "rowId": .string(rowId),
                "column": .string(column), "name": .string(name),
            ])
        )
        guard case let .object(fields) = result, let text = fields["text"]?.stringValue else {
            throw SyncularError(code: "client.failed", message: "crdtText returned no text")
        }
        return text
    }

    /// Insert `value` at UTF-16 offset `index` in a `crdt` column's text and
    /// push the resulting Yjs update through the normal (baseVersion-less)
    /// mutate path. Returns the enqueued `clientCommitId`.
    @discardableResult
    public func crdtInsertText(
        table: String,
        rowId: String,
        column: String,
        index: Int,
        value: String,
        name: String = "text"
    ) throws -> String {
        try crdtCommitId(method: "crdtInsertText", params: [
            "table": .string(table), "rowId": .string(rowId),
            "column": .string(column), "name": .string(name),
            "index": .number(Double(index)), "value": .string(value),
        ])
    }

    /// Delete `len` UTF-16 code units at offset `index` in a `crdt` column's
    /// text and push the resulting update. Returns the `clientCommitId`.
    @discardableResult
    public func crdtDeleteText(
        table: String,
        rowId: String,
        column: String,
        index: Int,
        len: Int,
        name: String = "text"
    ) throws -> String {
        try crdtCommitId(method: "crdtDeleteText", params: [
            "table": .string(table), "rowId": .string(rowId),
            "column": .string(column), "name": .string(name),
            "index": .number(Double(index)), "len": .number(Double(len)),
        ])
    }

    /// Escape hatch: apply an arbitrary Yjs update (bytes the app produced with
    /// its own model) onto a `crdt` column and push the resulting state.
    @discardableResult
    public func crdtApplyUpdate(
        table: String,
        rowId: String,
        column: String,
        update: [UInt8]
    ) throws -> String {
        var hex = ""
        for b in update { hex += String(format: "%02x", b) }
        return try crdtCommitId(method: "crdtApplyUpdate", params: [
            "table": .string(table), "rowId": .string(rowId),
            "column": .string(column),
            "update": .object(["$bytes": .string(hex)]),
        ])
    }

    private func crdtCommitId(method: String, params: [String: JSONValue]) throws -> String {
        let result = try command(method: method, params: .object(params))
        guard case let .object(fields) = result, let id = fields["clientCommitId"]?.stringValue
        else {
            throw SyncularError(code: "client.failed", message: "\(method) returned no clientCommitId")
        }
        return id
    }

    /// Register a subscription (table + scope map). Local; sync fills it.
    public func subscribe(
        id: String,
        table: String,
        scopes: [String: [String]] = [:],
        params: String? = nil
    ) throws {
        var p: [String: JSONValue] = [
            "id": .string(id),
            "table": .string(table),
            "scopes": .object(scopes.mapValues { .array($0.map(JSONValue.string)) }),
        ]
        if let params { p["params"] = .string(params) }
        _ = try command(method: "subscribe", params: .object(p))
    }

    /// Remove a subscription.
    public func unsubscribe(id: String) throws {
        _ = try command(method: "unsubscribe", params: .object(["id": .string(id)]))
    }

    /// Run one sync round against the server (needs `native-transport`).
    @discardableResult
    public func sync() throws -> JSONValue {
        try command(method: "sync", params: .object([:]))
    }

    /// Drive sync to quiescence (needs `native-transport`).
    @discardableResult
    public func syncUntilIdle(maxRounds: Int? = nil) throws -> JSONValue {
        var p: [String: JSONValue] = [:]
        if let maxRounds { p["maxRounds"] = .number(Double(maxRounds)) }
        return try command(method: "syncUntilIdle", params: .object(p))
    }

    /// Read all locally-visible rows of a table as `RowState` objects
    /// (`{rowId, version, values}`; `version == -1` = optimistic, offline). See
    /// `query` for a flat column-shaped read.
    public func readRows(table: String) throws -> [JSONValue] {
        let result = try command(method: "readRows", params: .object(["table": .string(table)]))
        guard case let .object(fields) = result, case let .array(rows)? = fields["rows"] else {
            return []
        }
        return rows
    }

    /// Current pending client commit ids (the offline outbox — non-empty after
    /// a local `mutate` until sync drains it). The honest offline "unsynced
    /// work" signal (`syncNeeded` reflects a server-push wake, not local mutes).
    public func pendingCommitIds() throws -> [String] {
        let result = try command(method: "pendingCommitIds", params: .object([:]))
        guard case let .object(fields) = result, case let .array(ids)? = fields["ids"] else {
            return []
        }
        return ids.compactMap { $0.stringValue }
    }

    /// Run arbitrary read-only SQL over the local visible tables (the live-query
    /// fast path). Params ride as driver value forms; bytes as `{"$bytes":hex}`.
    public func query(_ sql: String, params: [JSONValue] = []) throws -> [JSONValue] {
        let result = try command(
            method: "query",
            params: .object(["sql": .string(sql), "params": .array(params)])
        )
        guard case let .object(fields) = result, case let .array(rows)? = fields["rows"] else {
            return []
        }
        return rows
    }

    /// The current sync-needed flag (§8.4 wake signal).
    public func syncNeeded() throws -> Bool {
        let result = try command(method: "syncNeeded", params: .object([:]))
        if case let .object(fields) = result { return fields["value"]?.boolValue ?? false }
        return false
    }

    /// A subscription's status string (`active` / `revoked` / `failed`) — the
    /// status surface. The core returns a `{state: {id, table, status, …}}`
    /// view; this lifts `status` out of it.
    public func subscriptionState(id: String) throws -> String? {
        let result = try command(method: "subscriptionState", params: .object(["id": .string(id)]))
        return result["state"]?["status"]?.stringValue
    }

    /// Current conflicts (§6).
    public func conflicts() throws -> [JSONValue] {
        let result = try command(method: "conflicts", params: .object([:]))
        if case let .object(fields) = result, case let .array(list)? = fields["conflicts"] { return list }
        return []
    }

    /// Presence peers for a scope key (§8.6).
    public func presence(scopeKey: String) throws -> [JSONValue] {
        let result = try command(method: "presence", params: .object(["scopeKey": .string(scopeKey)]))
        if case let .object(fields) = result, case let .array(peers)? = fields["peers"] { return peers }
        return []
    }

    /// Publish (or clear, with `nil`) a presence doc for a scope key.
    public func setPresence(scopeKey: String, doc: JSONValue?) throws {
        _ = try command(
            method: "setPresence",
            params: .object(["scopeKey": .string(scopeKey), "doc": doc ?? .null])
        )
    }

    /// Open the realtime socket (needs `native-transport`).
    public func connectRealtime() throws {
        _ = try command(method: "connectRealtime", params: .object([:]))
    }

    /// Close the realtime socket.
    public func disconnectRealtime() throws {
        _ = try command(method: "disconnectRealtime", params: .object([:]))
    }

    // MARK: - Lifecycle (the wrapper owns it, per the roadmap)

    /// Pause background activity — stop the event poll loop and disconnect the
    /// realtime socket. Call from `applicationDidEnterBackground` (or a
    /// connectivity-lost handler). The database and pending outbox are intact;
    /// mutations still queue offline. `resume()` restarts the loop and socket.
    ///
    /// Honest scope: the core has no single "stop everything" command, so pause
    /// = stop-poll-loop + `disconnectRealtime`. It does not tear down the owning
    /// HTTP transport (there is no persistent HTTP connection to hold). See the
    /// README's lifecycle section.
    public func pause() {
        stopPollLoop()
        // Best-effort: a lean/offline core has no socket; ignore the failure.
        try? disconnectRealtime()
    }

    /// Resume after `pause()` — reconnect realtime (if a transport is present)
    /// and restart the event poll loop.
    public func resume() {
        try? connectRealtime()
        startPollLoop()
    }

    /// Close the core, releasing its database, transport, and socket thread.
    /// Idempotent. After close, commands throw `client.closed`.
    public func close() {
        stopPollLoop()
        commandQueue.sync {
            guard !self.closed, let handle = self.handle else { return }
            self.closed = true
            syncular_client_close(UnsafeMutableRawPointer(handle))
            self.handle = nil
        }
    }

    // MARK: - Event poll loop

    private func startPollLoop() {
        pollLock.lock()
        if pollRunning || closed { pollLock.unlock(); return }
        pollRunning = true
        let done = DispatchSemaphore(value: 0)
        pollDone = done
        pollLock.unlock()

        pollQueue.async { [weak self] in
            self?.runPollLoop()
            done.signal()
        }
    }

    /// Stop the poll loop and BLOCK until it has exited its current
    /// `poll_event` call. Blocking here is what makes `close()` safe: the core
    /// handle is only freed once no thread is inside `poll_event`.
    private func stopPollLoop() {
        pollLock.lock()
        let wasRunning = pollRunning
        pollRunning = false
        let done = pollDone
        pollDone = nil
        pollLock.unlock()
        if wasRunning {
            // The loop uses a short (25 ms) bounded timeout, so it observes the
            // cleared flag and signals promptly.
            done?.wait()
        }
    }

    private func runPollLoop() {
        while true {
            pollLock.lock()
            let running = pollRunning
            pollLock.unlock()
            if !running { return }

            // The handle is only freed by `close()`, which first calls
            // `stopPollLoop()` and waits for THIS loop to exit — so `handle`
            // stays valid for the whole `poll_event` call below.
            guard let handle = self.handle else { return }
            // 25 ms bounded wait: responsive to stop, cheap when idle.
            let eventPtr = syncular_client_poll_event(UnsafeMutableRawPointer(handle), 25)
            guard let eventPtr else { continue }
            let eventString = String(cString: eventPtr)
            syncular_free_string(eventPtr)

            guard let value = try? JSONValue(decoding: eventString),
                  case let .object(fields) = value,
                  let type = fields["type"]?.stringValue else {
                continue
            }
            let event = SyncularEvent(type: type, payload: fields)
            deliveryQueue.async { [weak self] in
                guard let self else { return }
                self.onEvent?(event)
                self.delegate?.syncularClient(self, didReceive: event)
            }
        }
    }
}
