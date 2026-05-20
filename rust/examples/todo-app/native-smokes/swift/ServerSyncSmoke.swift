import Foundation

extension SyncularBoltClient: SyncularNativeJsonClient {}

private struct ServerInfo: Decodable {
    let baseUrl: String
    let authorization: String
    let staleAuthorization: String?
    let actorId: String
    let revokedActorId: String
    let projectId: String?
    let task: ServerTask
    let schemaVersion: ServerSchemaVersion
    let ownerConflict: ServerOwnerConflict
    let conflicts: ServerConflicts
    let e2ee: ServerE2ee
    let blob: ServerBlob
}

private struct ServerTask: Decodable {
    let id: String
    let title: String
    let serverVersion: Int64
}

private struct ServerConflicts: Decodable {
    let swift: ServerConflict
    let swiftKeepServer: ServerConflict
    let swiftDismiss: ServerConflict
    let kotlin: ServerConflict
    let kotlinKeepServer: ServerConflict
    let kotlinDismiss: ServerConflict
}

private struct ServerConflict: Decodable {
    let rowId: String
    let localTitle: String
    let serverTitle: String
    let staleBaseVersion: Int64
    let serverVersion: Int64
    let conflictCode: String
    let keepLocalResolution: String
    let keepServerResolution: String
    let dismissResolution: String
    let expectedInitialConflictCount: Int
    let expectedAfterResolveConflictCount: Int
    let expectedAfterRetryConflictCount: Int
}

private struct ServerSchemaVersion: Decodable {
    let requiredFutureBaseUrl: String
    let latestFutureBaseUrl: String
    let expectedRequiredErrorPattern: String
}

private struct ServerOwnerConflict: Decodable {
    let secondActorId: String
    let secondAuthorization: String
    let expectedErrorPattern: String
}

private struct ServerE2ee: Decodable {
    let keyBase64: String
    let envelopePrefix: String
    let rule: ServerE2eeRule
    let swiftTask: ServerE2eeTask
}

private struct ServerE2eeRule: Decodable {
    let scope: String
    let table: String?
    let fields: [String]
    let rowIdField: String?
}

private struct ServerE2eeTask: Decodable {
    let id: String
    let title: String
}

private struct ServerBlob: Decodable {
    let textMimeType: String
    let authFailureText: String
    let expectedProcessRetryableFailure: BlobUploadQueueResult
    let expectedProcessPermanentFailure: BlobUploadQueueResult
    let expectedUploadQueueBefore: BlobUploadQueueStats
    let expectedFailedQueue: BlobUploadQueueStats
    let missingRef: SyncularBlobRef
}

private struct NativeConflictSummary: Decodable {
    let id: String
    let resultStatus: String
    let code: String?
    let serverVersion: Int64?

    private enum CodingKeys: String, CodingKey {
        case id
        case resultStatus = "result_status"
        case code
        case serverVersion = "server_version"
    }
}

private struct BlobUploadQueueResult: Decodable {
    let uploaded: Int
    let failed: Int
}

private struct BlobUploadQueueStats: Decodable {
    let pending: Int
    let uploading: Int
    let failed: Int
}

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

private func setAuthorization(_ client: SyncularBoltClient, authorization: String, message: String) throws {
    let headersData = try JSONSerialization.data(withJSONObject: ["authorization": authorization])
    let headersJson = String(data: headersData, encoding: .utf8)!
    let acceptedHeaders = try client.setAuthHeadersJson(headersJson: headersJson)
    expect(acceptedHeaders, message)
}

private func configureServerSync(
    _ client: SyncularBoltClient,
    info: ServerInfo,
    authorization: String? = nil,
    actorId: String? = nil
) throws {
    try setAuthorization(
        client,
        authorization: authorization ?? info.authorization,
        message: "Swift server sync client should accept auth headers"
    )
    let subscriptionArgs = SyncularSubscriptionArgs(
        actorId: actorId ?? info.actorId,
        projectId: info.projectId
    )
    let acceptedSubscriptions = try client.setSubscriptionsJson(
        subscriptionsJson: syncularSubscriptionsJson([taskSubscription(args: subscriptionArgs)])
    )
    expect(acceptedSubscriptions, "Swift server sync client should accept subscriptions")
}

private func configureFieldEncryption(_ client: SyncularBoltClient, info: ServerInfo, message: String) throws {
    let rule = info.e2ee.rule
    let acceptedEncryption = try client.setFieldEncryptionJson(
        configJson: syncularGeneratedFieldEncryptionConfigJson(
            keys: ["default": info.e2ee.keyBase64],
            envelopePrefix: info.e2ee.envelopePrefix,
            additionalRules: [
                SyncularFieldEncryptionRule(
                    scope: rule.scope,
                    table: rule.table,
                    fields: rule.fields,
                    rowIdField: rule.rowIdField
                )
            ]
        )
    )
    expect(acceptedEncryption, message)
}

private func conflictSummaries(from client: SyncularBoltClient) throws -> [NativeConflictSummary] {
    let json = try client.conflictSummariesJson()
    return try JSONDecoder().decode([NativeConflictSummary].self, from: Data(json.utf8))
}

private func blobRef(from json: String) throws -> SyncularBlobRef {
    try JSONDecoder().decode(SyncularBlobRef.self, from: Data(json.utf8))
}

private func blobUploadQueueResult(from json: String) throws -> BlobUploadQueueResult {
    try JSONDecoder().decode(BlobUploadQueueResult.self, from: Data(json.utf8))
}

private func blobUploadQueueStats(from client: SyncularBoltClient) throws -> BlobUploadQueueStats {
    let json = try client.blobUploadQueueStatsJson()
    return try JSONDecoder().decode(BlobUploadQueueStats.self, from: Data(json.utf8))
}

private func expectUploadResult(_ actual: BlobUploadQueueResult, _ expected: BlobUploadQueueResult, _ message: String) {
    expect(actual.uploaded == expected.uploaded, "\(message) uploaded count")
    expect(actual.failed == expected.failed, "\(message) failed count")
}

private func expectUploadStats(_ actual: BlobUploadQueueStats, _ expected: BlobUploadQueueStats, _ message: String) {
    expect(actual.pending == expected.pending, "\(message) pending count")
    expect(actual.uploading == expected.uploading, "\(message) uploading count")
    expect(actual.failed == expected.failed, "\(message) failed count")
}

private func waitForEvent(
    from client: SyncularBoltClient,
    kind: String,
    commandId: String?,
    timeoutMs: UInt64 = 5_000
) throws -> SyncularNativeEvent {
    try waitForEventJson(from: client, kind: kind, commandId: commandId, timeoutMs: timeoutMs).event
}

private func waitForEventJson(
    from client: SyncularBoltClient,
    kind: String,
    commandId: String?,
    timeoutMs: UInt64 = 5_000
) throws -> (event: SyncularNativeEvent, json: String) {
    let deadline = Date().addingTimeInterval(Double(timeoutMs) / 1_000.0)
    var seen: [String] = []
    repeat {
        if let eventJson = try client.nextEventJsonTimeout(timeoutMs: 50) {
            let event = try syncularDecodeNativeEvent(eventJson)
            seen.append("\(event.kind):\(event.commandId ?? "-"):\(eventJson)")
            if event.kind == kind && (commandId == nil || event.commandId == commandId) {
                return (event, eventJson)
            }
        }
    } while Date() < deadline
    fatalError("Timed out waiting for \(kind) command \(commandId ?? "-"); seen \(seen.joined(separator: ", "))")
}

private func createServerConflict(
    on client: SyncularBoltClient,
    info: ServerInfo,
    conflictInfo: ServerConflict,
    label: String
) throws -> NativeConflictSummary {
    let writeCommandId = try client.enqueueTaskPatch(
        rowId: conflictInfo.rowId,
        patch: TaskPatch(
            title: conflictInfo.localTitle,
            completed: 0,
            userId: info.actorId
        ),
        baseVersion: conflictInfo.staleBaseVersion
    )
    _ = try waitForEvent(from: client, kind: "LocalWriteCommitted", commandId: writeCommandId)
    let syncCommandId = try client.enqueueSyncNow()
    _ = try waitForEvent(from: client, kind: "SyncCompleted", commandId: syncCommandId)
    let conflicts = try conflictSummaries(from: client)
    expect(conflicts.count == conflictInfo.expectedInitialConflictCount, "\(label) should persist one conflict")
    let conflict = conflicts[0]
    expect(conflict.resultStatus == "conflict", "\(label) conflict should keep result status")
    expect(conflict.code == conflictInfo.conflictCode, "\(label) conflict should keep code")
    expect(conflict.serverVersion == conflictInfo.serverVersion, "\(label) conflict should keep server version")
    return conflict
}

@main
private enum ServerSyncSmoke {
    static func main() throws {
        let args = CommandLine.arguments.dropFirst()
        guard let dbPath = args.first, let infoPath = args.dropFirst().first else {
            fatalError("usage: ServerSyncSmoke <db-path> <server-info-json>")
        }

        removeSqliteFiles(dbPath)
        let infoData = try Data(contentsOf: URL(fileURLWithPath: infoPath))
        let info = try JSONDecoder().decode(ServerInfo.self, from: infoData)

        let client = try SyncularBoltClient(openAsync: SyncularBoltClientConfig(
            dbPath: dbPath,
            baseUrl: info.baseUrl,
            clientId: "swift-native-server-sync",
            actorId: info.actorId,
            projectId: info.projectId,
            appSchemaJson: syncularNativeGeneratedAppSchemaJson,
            autoSyncLocalWrites: false
        ))
        var shutdownFinished = false
        defer {
            if !shutdownFinished {
                _ = try? client.shutdown()
            }
        }

        let opened = try client.finishOpenTimeout(timeoutMs: 5_000)
        expect(opened, "Swift server sync client should open")
        expect(try client.startEventStream(capacity: 256), "Swift server sync client should start native event stream")

        let staleAuthorization = info.staleAuthorization ?? "Bearer stale-native"
        try configureServerSync(client, info: info, authorization: staleAuthorization)
        let staleCommandId = try client.enqueueSyncNow()
        let staleEvent = try waitForEvent(from: client, kind: "AuthExpired", commandId: staleCommandId)
        expect(staleEvent.commandId == staleCommandId, "Swift auth expired event should carry command id")
        try setAuthorization(
            client,
            authorization: info.authorization,
            message: "Swift server sync client should accept refreshed auth headers"
        )

        let commandId = try client.enqueueSyncNow()
        let event = try waitForEvent(from: client, kind: "SyncCompleted", commandId: commandId)
        expect(event.commandId == commandId, "Swift server sync event should carry command id")

        let rows = try TaskQuery
            .select()
            .filter(TaskQuery.id.eq(info.task.id))
            .fetch(on: client)
        expect(rows.count == 1, "Swift server sync should pull one task")
        expect(rows[0].title == info.task.title, "Swift server sync should decode pulled title")
        expect(rows[0].serverVersion == info.task.serverVersion, "Swift server sync should decode server version")

        try configureServerSync(client, info: info, actorId: info.revokedActorId)
        let revokedCommandId = try client.enqueueSyncNow()
        _ = try waitForEvent(from: client, kind: "SyncCompleted", commandId: revokedCommandId)
        let revokedRows = try TaskQuery
            .select()
            .filter(TaskQuery.id.eq(info.task.id))
            .fetch(on: client)
        expect(revokedRows.isEmpty, "Swift server sync should clear rows for revoked subscription")
        try configureServerSync(client, info: info)
        let restoredCommandId = try client.enqueueSyncNow()
        _ = try waitForEvent(from: client, kind: "SyncCompleted", commandId: restoredCommandId)
        let restoredRows = try TaskQuery
            .select()
            .filter(TaskQuery.id.eq(info.task.id))
            .fetch(on: client)
        expect(restoredRows.count == 1, "Swift server sync should restore rows after subscription scope returns")

        let requiredSchemaDbPath = dbPath + ".required-schema"
        removeSqliteFiles(requiredSchemaDbPath)
        let requiredSchemaClient = try SyncularBoltClient(openAsync: SyncularBoltClientConfig(
            dbPath: requiredSchemaDbPath,
            baseUrl: info.schemaVersion.requiredFutureBaseUrl,
            clientId: "swift-native-required-schema",
            actorId: info.actorId,
            projectId: info.projectId,
            appSchemaJson: syncularNativeGeneratedAppSchemaJson,
            autoSyncLocalWrites: false
        ))
        var requiredSchemaShutdownFinished = false
        defer {
            if !requiredSchemaShutdownFinished {
                _ = try? requiredSchemaClient.shutdown()
            }
        }
        let requiredSchemaOpened = try requiredSchemaClient.finishOpenTimeout(timeoutMs: 5_000)
        expect(requiredSchemaOpened, "Swift required-schema client should open")
        expect(try requiredSchemaClient.startEventStream(capacity: 256), "Swift required-schema client should start native event stream")
        try configureServerSync(requiredSchemaClient, info: info)
        let requiredSchemaCommandId = try requiredSchemaClient.enqueueSyncNow()
        let requiredSchemaFailure = try waitForEventJson(
            from: requiredSchemaClient,
            kind: "SyncFailed",
            commandId: requiredSchemaCommandId
        )
        expect(requiredSchemaFailure.event.commandId == requiredSchemaCommandId, "Swift required-schema failure should carry command id")
        expect(
            requiredSchemaFailure.json.contains(info.schemaVersion.expectedRequiredErrorPattern),
            "Swift required-schema failure should expose schema error"
        )
        requiredSchemaShutdownFinished = try requiredSchemaClient.shutdown()
        expect(requiredSchemaShutdownFinished, "Swift required-schema client should shut down")

        let latestSchemaDbPath = dbPath + ".latest-schema"
        removeSqliteFiles(latestSchemaDbPath)
        let latestSchemaClient = try SyncularBoltClient(openAsync: SyncularBoltClientConfig(
            dbPath: latestSchemaDbPath,
            baseUrl: info.schemaVersion.latestFutureBaseUrl,
            clientId: "swift-native-latest-schema",
            actorId: info.actorId,
            projectId: info.projectId,
            appSchemaJson: syncularNativeGeneratedAppSchemaJson,
            autoSyncLocalWrites: false
        ))
        var latestSchemaShutdownFinished = false
        defer {
            if !latestSchemaShutdownFinished {
                _ = try? latestSchemaClient.shutdown()
            }
        }
        let latestSchemaOpened = try latestSchemaClient.finishOpenTimeout(timeoutMs: 5_000)
        expect(latestSchemaOpened, "Swift latest-schema client should open")
        expect(try latestSchemaClient.startEventStream(capacity: 256), "Swift latest-schema client should start native event stream")
        try configureServerSync(latestSchemaClient, info: info)
        let latestSchemaCommandId = try latestSchemaClient.enqueueSyncNow()
        _ = try waitForEvent(from: latestSchemaClient, kind: "SyncCompleted", commandId: latestSchemaCommandId)
        latestSchemaShutdownFinished = try latestSchemaClient.shutdown()
        expect(latestSchemaShutdownFinished, "Swift latest-schema client should shut down")

        let ownerConflictClientId = "swift-native-owner-conflict"
        let ownerFirstDbPath = dbPath + ".owner-first"
        removeSqliteFiles(ownerFirstDbPath)
        let ownerFirst = try SyncularBoltClient(openAsync: SyncularBoltClientConfig(
            dbPath: ownerFirstDbPath,
            baseUrl: info.baseUrl,
            clientId: ownerConflictClientId,
            actorId: info.actorId,
            projectId: info.projectId,
            appSchemaJson: syncularNativeGeneratedAppSchemaJson,
            autoSyncLocalWrites: false
        ))
        var ownerFirstShutdownFinished = false
        defer {
            if !ownerFirstShutdownFinished {
                _ = try? ownerFirst.shutdown()
            }
        }
        let ownerFirstOpened = try ownerFirst.finishOpenTimeout(timeoutMs: 5_000)
        expect(ownerFirstOpened, "Swift owner-conflict first client should open")
        expect(try ownerFirst.startEventStream(capacity: 256), "Swift owner-conflict first client should start native event stream")
        try configureServerSync(ownerFirst, info: info)
        let ownerFirstCommandId = try ownerFirst.enqueueSyncNow()
        _ = try waitForEvent(from: ownerFirst, kind: "SyncCompleted", commandId: ownerFirstCommandId)
        ownerFirstShutdownFinished = try ownerFirst.shutdown()
        expect(ownerFirstShutdownFinished, "Swift owner-conflict first client should shut down")

        let ownerSecondDbPath = dbPath + ".owner-second"
        removeSqliteFiles(ownerSecondDbPath)
        let ownerSecond = try SyncularBoltClient(openAsync: SyncularBoltClientConfig(
            dbPath: ownerSecondDbPath,
            baseUrl: info.baseUrl,
            clientId: ownerConflictClientId,
            actorId: info.ownerConflict.secondActorId,
            projectId: info.projectId,
            appSchemaJson: syncularNativeGeneratedAppSchemaJson,
            autoSyncLocalWrites: false
        ))
        var ownerSecondShutdownFinished = false
        defer {
            if !ownerSecondShutdownFinished {
                _ = try? ownerSecond.shutdown()
            }
        }
        let ownerSecondOpened = try ownerSecond.finishOpenTimeout(timeoutMs: 5_000)
        expect(ownerSecondOpened, "Swift owner-conflict second client should open")
        expect(try ownerSecond.startEventStream(capacity: 256), "Swift owner-conflict second client should start native event stream")
        try configureServerSync(
            ownerSecond,
            info: info,
            authorization: info.ownerConflict.secondAuthorization,
            actorId: info.ownerConflict.secondActorId
        )
        let ownerSecondCommandId = try ownerSecond.enqueueSyncNow()
        let ownerSecondFailure = try waitForEventJson(
            from: ownerSecond,
            kind: "SyncFailed",
            commandId: ownerSecondCommandId
        )
        expect(ownerSecondFailure.event.commandId == ownerSecondCommandId, "Swift owner-conflict failure should carry command id")
        expect(
            ownerSecondFailure.json.contains(info.ownerConflict.expectedErrorPattern),
            "Swift owner-conflict failure should expose HTTP ownership error"
        )
        ownerSecondShutdownFinished = try ownerSecond.shutdown()
        expect(ownerSecondShutdownFinished, "Swift owner-conflict second client should shut down")

        let conflictInfo = info.conflicts.swift
        let conflict = try createServerConflict(
            on: client,
            info: info,
            conflictInfo: conflictInfo,
            label: "Swift keep-local"
        )
        let resolveCommandId = try client.enqueueResolveConflict(
            id: conflict.id,
            resolution: conflictInfo.keepLocalResolution
        )
        let resolveEvent = try waitForEvent(from: client, kind: "ConflictResolutionCompleted", commandId: resolveCommandId)
        expect(resolveEvent.clientCommitId != nil, "Swift keep-local conflict resolution should enqueue retry commit")
        let remainingConflicts = try conflictSummaries(from: client)
        expect(
            remainingConflicts.count == conflictInfo.expectedAfterRetryConflictCount,
            "Swift keep-local conflict resolution should clear conflict summary"
        )
        let conflictRetrySyncCommandId = try client.enqueueSyncNow()
        _ = try waitForEvent(from: client, kind: "SyncCompleted", commandId: conflictRetrySyncCommandId)

        let keepServerInfo = info.conflicts.swiftKeepServer
        let keepServerConflict = try createServerConflict(
            on: client,
            info: info,
            conflictInfo: keepServerInfo,
            label: "Swift keep-server"
        )
        let keepServerCommandId = try client.enqueueResolveConflict(
            id: keepServerConflict.id,
            resolution: keepServerInfo.keepServerResolution
        )
        let keepServerEvent = try waitForEvent(from: client, kind: "ConflictResolutionCompleted", commandId: keepServerCommandId)
        expect(keepServerEvent.clientCommitId == nil, "Swift keep-server conflict resolution should not enqueue retry commit")
        let keepServerRemainingConflicts = try conflictSummaries(from: client)
        expect(
            keepServerRemainingConflicts.count == keepServerInfo.expectedAfterResolveConflictCount,
            "Swift keep-server conflict resolution should clear conflict summary"
        )

        let dismissInfo = info.conflicts.swiftDismiss
        let dismissConflict = try createServerConflict(
            on: client,
            info: info,
            conflictInfo: dismissInfo,
            label: "Swift dismiss"
        )
        let dismissCommandId = try client.enqueueResolveConflict(
            id: dismissConflict.id,
            resolution: dismissInfo.dismissResolution
        )
        let dismissEvent = try waitForEvent(from: client, kind: "ConflictResolutionCompleted", commandId: dismissCommandId)
        expect(dismissEvent.clientCommitId == nil, "Swift dismiss conflict resolution should not enqueue retry commit")
        let dismissRemainingConflicts = try conflictSummaries(from: client)
        expect(
            dismissRemainingConflicts.count == dismissInfo.expectedAfterResolveConflictCount,
            "Swift dismiss conflict resolution should clear conflict summary"
        )

        let pushedTaskId = "native-swift-pushed-task"
        let writeCommandId = try client.enqueueNewTask(NewTask(
            id: pushedTaskId,
            title: "Swift pushed task",
            completed: 0,
            userId: info.actorId,
            projectId: info.projectId
        ))
        _ = try waitForEvent(from: client, kind: "LocalWriteCommitted", commandId: writeCommandId)
        let pushSyncCommandId = try client.enqueueSyncNow()
        _ = try waitForEvent(from: client, kind: "SyncCompleted", commandId: pushSyncCommandId)

        let websocketTaskId = "native-swift-websocket-task"
        let websocketWriteCommandId = try client.enqueueNewTask(NewTask(
            id: websocketTaskId,
            title: "Swift websocket task",
            completed: 0,
            userId: info.actorId,
            projectId: info.projectId
        ))
        _ = try waitForEvent(from: client, kind: "LocalWriteCommitted", commandId: websocketWriteCommandId)
        let websocketSyncCommandId = try client.enqueueSyncWebsocket()
        _ = try waitForEvent(from: client, kind: "SyncCompleted", commandId: websocketSyncCommandId)

        let authFailureBlobPath = dbPath + ".swift-blob-auth-failure.txt"
        try Data(info.blob.authFailureText.utf8).write(to: URL(fileURLWithPath: authFailureBlobPath))
        let authFailureBlobJson = try client.storeBlobFileJson(
            path: authFailureBlobPath,
            optionsJson: #"{"mimeType":"\#(info.blob.textMimeType)"}"#
        )
        let authFailureBlob = try blobRef(from: authFailureBlobJson)
        try setAuthorization(
            client,
            authorization: info.staleAuthorization ?? "Bearer stale-native",
            message: "Swift blob auth-failure client should accept stale auth headers"
        )
        expectUploadResult(
            try blobUploadQueueResult(from: client.processBlobUploadQueueJson()),
            info.blob.expectedProcessRetryableFailure,
            "Swift blob auth failure first retry"
        )
        expectUploadStats(
            try blobUploadQueueStats(from: client),
            info.blob.expectedUploadQueueBefore,
            "Swift blob auth failure first queue state"
        )
        Thread.sleep(forTimeInterval: 1.1)
        expectUploadResult(
            try blobUploadQueueResult(from: client.processBlobUploadQueueJson()),
            info.blob.expectedProcessRetryableFailure,
            "Swift blob auth failure second retry"
        )
        expectUploadStats(
            try blobUploadQueueStats(from: client),
            info.blob.expectedUploadQueueBefore,
            "Swift blob auth failure second queue state"
        )
        Thread.sleep(forTimeInterval: 2.1)
        expectUploadResult(
            try blobUploadQueueResult(from: client.processBlobUploadQueueJson()),
            info.blob.expectedProcessPermanentFailure,
            "Swift blob auth failure permanent failure"
        )
        expectUploadStats(
            try blobUploadQueueStats(from: client),
            info.blob.expectedFailedQueue,
            "Swift blob auth failure final queue state"
        )
        let authFailureBlobStillLocal = try client.isBlobLocal(hash: authFailureBlob.hash)
        expect(authFailureBlobStillLocal, "Swift failed blob upload should keep local cache")
        try configureServerSync(client, info: info)

        let blobText = "Swift native server blob"
        let blobPath = dbPath + ".swift-blob.txt"
        let blobDownloadPath = dbPath + ".swift-blob-downloaded.txt"
        try Data(blobText.utf8).write(to: URL(fileURLWithPath: blobPath))
        try? FileManager.default.removeItem(atPath: blobDownloadPath)
        let blobJson = try client.storeBlobFileJson(
            path: blobPath,
            optionsJson: #"{"mimeType":"\#(info.blob.textMimeType)"}"#
        )
        let uploadResult = try blobUploadQueueResult(from: client.processBlobUploadQueueJson())
        expect(uploadResult.uploaded == 1, "Swift blob upload queue should upload one blob")
        expect(uploadResult.failed == 0, "Swift blob upload queue should not fail")
        let blobRef = try blobRef(from: blobJson)
        let blobTaskId = "native-swift-blob-task"
        let blobWriteCommandId = try client.enqueueNewTask(NewTask(
            id: blobTaskId,
            title: "Swift blob task",
            completed: 0,
            userId: info.actorId,
            projectId: info.projectId,
            image: blobRef
        ))
        _ = try waitForEvent(from: client, kind: "LocalWriteCommitted", commandId: blobWriteCommandId)
        let blobSyncCommandId = try client.enqueueSyncNow()
        _ = try waitForEvent(from: client, kind: "SyncCompleted", commandId: blobSyncCommandId)

        try configureFieldEncryption(
            client,
            info: info,
            message: "Swift server sync client should accept field encryption config"
        )
        let encryptedTaskId = info.e2ee.swiftTask.id
        let encryptedWriteCommandId = try client.enqueueNewTask(NewTask(
            id: encryptedTaskId,
            title: info.e2ee.swiftTask.title,
            completed: 0,
            userId: info.actorId,
            projectId: info.projectId
        ))
        _ = try waitForEvent(from: client, kind: "LocalWriteCommitted", commandId: encryptedWriteCommandId)
        let encryptedSyncCommandId = try client.enqueueSyncNow()
        _ = try waitForEvent(from: client, kind: "SyncCompleted", commandId: encryptedSyncCommandId)

        let readerDbPath = dbPath + ".reader"
        removeSqliteFiles(readerDbPath)
        let reader = try SyncularBoltClient(openAsync: SyncularBoltClientConfig(
            dbPath: readerDbPath,
            baseUrl: info.baseUrl,
            clientId: "swift-native-server-sync-reader",
            actorId: info.actorId,
            projectId: info.projectId,
            appSchemaJson: syncularNativeGeneratedAppSchemaJson,
            autoSyncLocalWrites: false
        ))
        var readerShutdownFinished = false
        defer {
            if !readerShutdownFinished {
                _ = try? reader.shutdown()
            }
        }
        let readerOpened = try reader.finishOpenTimeout(timeoutMs: 5_000)
        expect(readerOpened, "Swift server sync reader should open")
        expect(try reader.startEventStream(capacity: 256), "Swift server sync reader should start native event stream")
        try configureServerSync(reader, info: info)
        let liveQuery = TaskQuery
            .select()
            .filter(TaskQuery.userId.eq(info.actorId))
            .liveQuery(id: "swift-native-server-live", label: "Swift server sync")
        let initialLiveRows = try liveQuery.start(on: reader)
        expect(initialLiveRows.isEmpty, "Swift server live query should start empty")
        let pullPushedCommandId = try reader.enqueueSyncNow()
        _ = try waitForEvent(from: reader, kind: "SyncCompleted", commandId: pullPushedCommandId)
        let liveQueryEvent = try waitForEvent(from: reader, kind: "QueriesChanged", commandId: nil)
        let refreshedLiveRows = try liveQuery.refreshIfChanged(event: liveQueryEvent, on: reader)
        expect(
            refreshedLiveRows?.contains(where: { $0.id == pushedTaskId }) == true,
            "Swift server live query should refresh after sync pull"
        )
        _ = try liveQuery.stop(on: reader)
        let pushedRows = try TaskQuery
            .select()
            .filter(TaskQuery.id.eq(pushedTaskId))
            .fetch(on: reader)
        expect(pushedRows.count == 1, "Swift server sync reader should pull pushed task")
        expect(pushedRows[0].title == "Swift pushed task", "Swift server sync reader should decode pushed title")
        let websocketRows = try TaskQuery
            .select()
            .filter(TaskQuery.id.eq(websocketTaskId))
            .fetch(on: reader)
        expect(websocketRows.count == 1, "Swift server sync reader should pull websocket-pushed task")
        expect(websocketRows[0].title == "Swift websocket task", "Swift server sync reader should decode websocket-pushed title")
        let blobRows = try TaskQuery
            .select()
            .filter(TaskQuery.id.eq(blobTaskId))
            .fetch(on: reader)
        expect(blobRows.count == 1, "Swift server sync reader should pull blob task")
        expect(blobRows[0].image?.hash == blobRef.hash, "Swift server sync reader should decode blob ref hash")
        expect(blobRows[0].image?.size == blobRef.size, "Swift server sync reader should decode blob ref size")
        expect(blobRows[0].image?.mimeType == blobRef.mimeType, "Swift server sync reader should decode blob ref MIME type")
        let blobRetrieved = try reader.retrieveBlobFileJson(
            refJson: blobJson,
            path: blobDownloadPath,
            optionsJson: #"{"cacheLocal":false}"#
        )
        expect(blobRetrieved, "Swift server sync reader should retrieve blob file")
        let downloadedBlob = try String(data: Data(contentsOf: URL(fileURLWithPath: blobDownloadPath)), encoding: .utf8)
        expect(downloadedBlob == blobText, "Swift server sync reader should download blob bytes")
        let missingBlobDownloadPath = dbPath + ".swift-missing-blob.bin"
        try? FileManager.default.removeItem(atPath: missingBlobDownloadPath)
        do {
            _ = try reader.retrieveBlobFileJson(
                refJson: try info.blob.missingRef.jsonString(),
                path: missingBlobDownloadPath,
                optionsJson: #"{"cacheLocal":false}"#
            )
            fatalError("Swift missing remote blob retrieval should fail")
        } catch {
            expect(
                String(describing: error).contains("HTTP 404"),
                "Swift missing remote blob retrieval should expose HTTP 404"
            )
        }
        let missingBlobCached = try reader.isBlobLocal(hash: info.blob.missingRef.hash)
        expect(!missingBlobCached, "Swift missing remote blob should not be cached locally")
        let ciphertextRows = try TaskQuery
            .select()
            .filter(TaskQuery.id.eq(encryptedTaskId))
            .fetch(on: reader)
        expect(ciphertextRows.count == 1, "Swift server sync reader should pull encrypted task")
        expect(
            ciphertextRows[0].title.hasPrefix(info.e2ee.envelopePrefix),
            "Swift server sync reader without field encryption should see ciphertext envelope"
        )
        let conflictRows = try TaskQuery
            .select()
            .filter(TaskQuery.id.eq(conflictInfo.rowId))
            .fetch(on: reader)
        expect(conflictRows.count == 1, "Swift server sync reader should pull resolved conflict task")
        expect(conflictRows[0].title == conflictInfo.localTitle, "Swift server sync reader should pull keep-local title")
        readerShutdownFinished = try reader.shutdown()
        expect(readerShutdownFinished, "Swift server sync reader should shut down")

        let encryptedReaderDbPath = dbPath + ".encrypted-reader"
        removeSqliteFiles(encryptedReaderDbPath)
        let encryptedReader = try SyncularBoltClient(openAsync: SyncularBoltClientConfig(
            dbPath: encryptedReaderDbPath,
            baseUrl: info.baseUrl,
            clientId: "swift-native-server-sync-encrypted-reader",
            actorId: info.actorId,
            projectId: info.projectId,
            appSchemaJson: syncularNativeGeneratedAppSchemaJson,
            autoSyncLocalWrites: false
        ))
        var encryptedReaderShutdownFinished = false
        defer {
            if !encryptedReaderShutdownFinished {
                _ = try? encryptedReader.shutdown()
            }
        }
        let encryptedReaderOpened = try encryptedReader.finishOpenTimeout(timeoutMs: 5_000)
        expect(encryptedReaderOpened, "Swift encrypted server sync reader should open")
        expect(try encryptedReader.startEventStream(capacity: 256), "Swift encrypted server sync reader should start native event stream")
        try configureServerSync(encryptedReader, info: info)
        try configureFieldEncryption(
            encryptedReader,
            info: info,
            message: "Swift encrypted reader should accept field encryption config"
        )
        let pullEncryptedCommandId = try encryptedReader.enqueueSyncNow()
        _ = try waitForEvent(from: encryptedReader, kind: "SyncCompleted", commandId: pullEncryptedCommandId)
        let decryptedRows = try TaskQuery
            .select()
            .filter(TaskQuery.id.eq(encryptedTaskId))
            .fetch(on: encryptedReader)
        expect(decryptedRows.count == 1, "Swift encrypted reader should pull encrypted task")
        expect(
            decryptedRows[0].title == info.e2ee.swiftTask.title,
            "Swift encrypted reader should decrypt pulled title"
        )
        encryptedReaderShutdownFinished = try encryptedReader.shutdown()
        expect(encryptedReaderShutdownFinished, "Swift encrypted reader should shut down")

        shutdownFinished = try client.shutdown()
        expect(shutdownFinished, "Swift server sync client should shut down")
        print("Swift native server sync smoke passed")
    }
}
