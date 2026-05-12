private class MockNativeClient : SyncularNativeJsonClient {
    val mutations = mutableListOf<String>()
    val queryRequests = mutableListOf<String>()
    val registrations = mutableListOf<String>()
    val unregisteredIds = mutableListOf<String>()

    override fun applyMutationJson(mutationJson: String, localRowJson: String?): String {
        mutations += mutationJson
        return "commit-kotlin"
    }

    override fun queryJson(requestJson: String): String {
        queryRequests += requestJson
        return """
            {"rows":[{"id":"task-native","title":"Native smoke","completed":1,"user_id":"user-rust","project_id":"project-rust","server_version":11,"image":null,"title_yjs_state":null}]}
        """.trimIndent()
    }

    override fun registerQueryJson(queryJson: String): String {
        registrations += queryJson
        return "live-tasks"
    }

    override fun unregisterQuery(id: String): Boolean {
        unregisteredIds += id
        return true
    }
}

private fun expect(condition: Boolean, message: String) {
    if (!condition) error(message)
}

fun main() {
    val client = MockNativeClient()
    val query = TaskQuery
        .select()
        .filter(TaskQuery.userId.eq("user-rust"))
        .orderBy(TaskQuery.serverVersion.desc())
        .limit(5)

    val readonly = query.readonlyQuery()
    expect(
        readonly.sql == "select \"id\", \"title\", \"completed\", \"user_id\", \"project_id\", \"server_version\", \"image\", \"title_yjs_state\" from \"tasks\" where \"user_id\" = ? order by \"server_version\" desc limit 5",
        "unexpected Kotlin query SQL",
    )
    expect(readonly.params == listOf("user-rust"), "unexpected Kotlin query params")
    expect(readonly.tables == listOf("tasks"), "unexpected Kotlin query tables")

    val rows = query.fetch(client)
    expect(rows.size == 1, "Kotlin fetch should decode one row")
    expect(rows[0].id == "task-native", "Kotlin fetch should decode id")
    expect(rows[0].completed == 1L, "Kotlin fetch should decode completed")

    val commitId = client.applyNewTask(
        NewTask(
            id = "task-native",
            title = "Native smoke",
            completed = 1,
            userId = "user-rust",
            projectId = "project-rust",
        ),
    )
    expect(commitId == "commit-kotlin", "Kotlin mutation helper should return commit id")
    expect(client.mutations.size == 1, "Kotlin mutation helper should call applyMutationJson once")
    expect(client.mutations[0].contains("\"table\":\"tasks\""), "Kotlin mutation should target tasks")
    expect(client.mutations[0].contains("\"row_id\":\"task-native\""), "Kotlin mutation should use input id")
    expect(client.mutations[0].contains("\"op\":\"upsert\""), "Kotlin mutation should be an upsert")

    val live = query.liveQuery(id = "live-tasks", label = "Tasks")
    val initialRows = live.start(client)
    expect(initialRows.size == 1, "Kotlin live query start should refresh rows")
    expect(client.registrations.size == 1, "Kotlin live query should register once")
    expect(client.registrations[0].contains("\"id\":\"live-tasks\""), "Kotlin live query registration id")
    expect(client.registrations[0].contains("\"tables\":[\"tasks\"]"), "Kotlin live query registration tables")

    val ignored = live.refreshIfChanged(
        SyncularNativeEvent(kind = "QueriesChanged", queries = listOf("other-query")),
        client,
    )
    expect(ignored == null, "Kotlin live query should ignore unrelated query changes")

    val refreshed = live.refreshIfChanged(
        SyncularNativeEvent(kind = "QueriesChanged", queries = listOf("live-tasks")),
        client,
    )
    expect(refreshed?.size == 1, "Kotlin live query should refresh affected query")
    expect(client.queryRequests.size == 3, "Kotlin live query should run initial, start, and affected refresh queries")
    expect(live.stop(client), "Kotlin live query stop should unregister")
    expect(client.unregisteredIds == listOf("live-tasks"), "Kotlin live query unregister id")

    println("Kotlin generated client smoke passed")
}
