import Foundation

private final class MockNativeClient: SyncularNativeJsonClient {
    private(set) var mutations: [String] = []
    private(set) var queryRequests: [SyncularReadonlyQuery] = []
    private(set) var registrations: [SyncularLiveQueryRegistration] = []
    private(set) var unregisteredIds: [String] = []

    func applyMutationJson(mutationJson: String, localRowJson: String?) throws -> String {
        mutations.append(mutationJson)
        return "commit-swift"
    }

    func queryJson(requestJson: String) throws -> String {
        let query = try JSONDecoder().decode(SyncularReadonlyQuery.self, from: Data(requestJson.utf8))
        queryRequests.append(query)
        return """
        {"rows":[{"id":"task-native","title":"Native smoke","completed":1,"user_id":"user-rust","project_id":"project-rust","server_version":11,"image":null,"title_yjs_state":null}]}
        """
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

@main
private enum GeneratedClientSmoke {
    static func main() throws {
        let client = MockNativeClient()
        let query = TaskQuery
            .select()
            .filter(TaskQuery.userId.eq("user-rust"))
            .orderBy(TaskQuery.serverVersion.desc())
            .limit(5)

        let readonly = query.readonlyQuery()
        expect(readonly.sql == #"select "id", "title", "completed", "user_id", "project_id", "server_version", "image", "title_yjs_state" from "tasks" where "user_id" = ? order by "server_version" desc limit 5"#, "unexpected Swift query SQL")
        expect(readonly.params == [.string("user-rust")], "unexpected Swift query params")
        expect(readonly.tables == ["tasks"], "unexpected Swift query tables")

        let rows = try query.fetch(on: client)
        expect(rows.count == 1, "Swift fetch should decode one row")
        expect(rows[0].id == "task-native", "Swift fetch should decode id")
        expect(rows[0].completed == 1, "Swift fetch should decode completed")

        let commitId = try client.applyNewTask(NewTask(
            id: "task-native",
            title: "Native smoke",
            completed: 1,
            userId: "user-rust",
            projectId: "project-rust"
        ))
        expect(commitId == "commit-swift", "Swift mutation helper should return commit id")
        expect(client.mutations.count == 1, "Swift mutation helper should call applyMutationJson once")
        expect(client.mutations[0].contains(#""table":"tasks""#), "Swift mutation should target tasks")
        expect(client.mutations[0].contains(#""row_id":"task-native""#), "Swift mutation should use input id")
        expect(client.mutations[0].contains(#""op":"upsert""#), "Swift mutation should be an upsert")

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
