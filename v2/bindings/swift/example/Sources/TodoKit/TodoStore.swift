// TodoStore — the whole syncular integration for the todo demos, in one place.
//
// This is the ~30-line surface both the SwiftUI window (TodoUI) and the
// terminal app (todo) sit on. It talks to the quickstart server's `notes`
// table (id, list_id, body, updated_at_ms) — the SAME schema
// examples/quickstart ships and its TS clients use — over the SyncularClient
// wrapper. A todo is a `notes` row: `body` carries the title, and done-state
// rides as a leading "[x] " / "[ ] " marker (the quickstart schema has no
// `done` column and the example is read-only, so we model completion in the
// body rather than fork the schema — an honest fit, no hacks).
//
// Everything below is plain wrapper calls: subscribe / mutate / query / sync.
// No protocol logic lives here; the native core owns all of it.

import Foundation
import Syncular

/// One todo, projected out of a `notes` row.
public struct Todo: Identifiable, Sendable, Equatable {
    public let id: String
    public var title: String
    public var done: Bool
}

/// The demo's list scope. The quickstart server authorizes every list (`['*']`).
public let demoListId = "welcome"

public final class TodoStore {
    private let client: SyncularClient

    /// Construct against a running quickstart server (or offline if `baseUrl`
    /// is nil — mutations still queue locally and show immediately).
    public init(clientId: String, baseUrl: String?, dbPath: String? = nil) throws {
        client = try SyncularClient(
            clientId: clientId,
            schema: Self.schema,
            config: SyncularConfig(
                baseUrl: baseUrl,
                dbPath: dbPath
            )
        )
        // Subscribe to the demo list so sync fills it and pushes our writes.
        try client.subscribe(id: "todos", table: "notes", scopes: ["list_id": [demoListId]])
    }

    /// All todos in the list, id-ordered (the live-query fast path).
    public func todos() throws -> [Todo] {
        try client.query(
            "SELECT id, body FROM notes ORDER BY id"
        ).map { row in
            let body = row["body"]?.stringValue ?? ""
            let done = body.hasPrefix("[x] ")
            // Strip the "[ ] "/"[x] " marker only when present, so foreign notes
            // (rows written without a marker) keep their body intact.
            let title = (done || body.hasPrefix("[ ] ")) ? String(body.dropFirst(4)) : body
            return Todo(id: row["id"]?.stringValue ?? "", title: title, done: done)
        }
    }

    /// Add a todo (optimistic — visible immediately, queued for the next sync).
    @discardableResult
    public func add(_ title: String) throws -> Todo {
        let id = "todo-\(UUID().uuidString.prefix(8).lowercased())"
        try upsert(id: id, title: title, done: false)
        return Todo(id: id, title: title, done: false)
    }

    /// Toggle a todo's done flag (re-upserts the row with a flipped marker).
    public func toggle(_ id: String) throws {
        guard let t = try todos().first(where: { $0.id == id }) else { return }
        try upsert(id: id, title: t.title, done: !t.done)
    }

    /// Push local writes and pull remote ones. Returns true if the round synced
    /// (needs a native-transport core + a reachable server); false offline.
    @discardableResult
    public func sync() throws -> Bool {
        let outcome = try client.syncUntilIdle()
        return outcome["ok"]?.boolValue ?? false
    }

    /// Unsynced local writes still in the outbox.
    public func pendingCount() throws -> Int { try client.pendingCommitIds().count }

    /// Deliver core events (e.g. `sync-needed`) to a callback on the main queue.
    public func onEvent(_ handler: @escaping (SyncularEvent) -> Void) {
        client.onEvent = handler
    }

    public func close() { client.close() }

    // MARK: - Internals

    private func upsert(id: String, title: String, done: Bool) throws {
        let now = Int(Date().timeIntervalSince1970 * 1000)
        let body = (done ? "[x] " : "[ ] ") + title
        _ = try client.mutate([
            .object([
                "op": .string("upsert"),
                "table": .string("notes"),
                "values": .object([
                    "id": .string(id),
                    "list_id": .string(demoListId),
                    "body": .string(body),
                    "updated_at_ms": .number(Double(now)),
                ]),
            ])
        ])
    }

    /// The SSP2 wire media type the server (§1.1) requires. See the workaround

    /// The quickstart `notes` schema — matches examples/quickstart's generated
    /// schema (id, list_id, body, updated_at_ms; scoped by list). The server
    /// runs the same shape, so the two converge.
    private static let schema: JSONValue = .object([
        "version": .number(1),
        "tables": .array([
            .object([
                "name": .string("notes"),
                "primaryKey": .string("id"),
                "scopes": .array([
                    .object(["pattern": .string("list:{list_id}"), "column": .string("list_id")]),
                ]),
                "columns": .array([
                    col("id"), col("list_id"), col("body"), col("updated_at_ms", type: "integer"),
                ]),
            ]),
        ]),
    ])

    private static func col(_ name: String, type: String = "string") -> JSONValue {
        .object(["name": .string(name), "type": .string(type), "nullable": .bool(false)])
    }
}
