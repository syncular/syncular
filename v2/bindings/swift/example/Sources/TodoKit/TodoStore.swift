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
// The schema is NOT hand-built: `SyncularSchema.schema` and the typed `Notes`
// row come from `Syncular.generated.swift`, produced by `syncular-v2 generate`
// from this example's `syncular.json` + `migrations/` (check.sh gates its
// freshness with `--check`).
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
            schema: SyncularSchema.schema,
            config: SyncularConfig(
                baseUrl: baseUrl,
                dbPath: dbPath
            )
        )
        // Subscribe to the demo list so sync fills it and pushes our writes.
        // The scope map comes from the generated subscription helper.
        try client.subscribe(
            id: "todos",
            table: SyncularSchema.subscriptions.ListNotes.table,
            scopes: SyncularSchema.subscriptions.ListNotes.scopes(listId: demoListId)
        )
    }

    /// All todos in the list, id-ordered (the live-query fast path). Rows decode
    /// through the generated typed `Notes` struct.
    public func todos() throws -> [Todo] {
        try client.query(
            "SELECT id, list_id, body, updated_at_ms FROM notes ORDER BY id"
        ).compactMap { row in
            guard case let .object(fields) = row, let note = Notes(row: fields) else {
                return nil
            }
            let done = note.body.hasPrefix("[x] ")
            // Strip the "[ ] "/"[x] " marker only when present, so foreign notes
            // (rows written without a marker) keep their body intact.
            let title = (done || note.body.hasPrefix("[ ] "))
                ? String(note.body.dropFirst(4))
                : note.body
            return Todo(id: note.id, title: title, done: done)
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
}
