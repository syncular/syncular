package dev.syncular.client

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.channels.awaitClose
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.callbackFlow
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.flow.flowOn
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.launch

fun SyncularBoltClient.eventJsonFlow(capacity: ULong = 256uL): Flow<String> =
    callbackFlow {
        val worker = launch(Dispatchers.IO) {
            try {
                forEachEventJson(capacity) { eventJson ->
                    trySend(eventJson).isSuccess
                }
                close()
            } catch (error: Throwable) {
                close(error)
            }
        }
        awaitClose {
            worker.cancel()
            runCatching { closeEventStream() }
        }
    }.flowOn(Dispatchers.IO)

fun <Event> SyncularBoltClient.nativeEventFlow(
    capacity: ULong = 256uL,
    decode: (String) -> Event,
): Flow<Event> = eventJsonFlow(capacity).map(decode)

fun SyncularBoltClient.refreshingJsonFlow(
    capacity: ULong = 256uL,
    refresh: () -> String,
    shouldRefresh: (String) -> Boolean = { true },
): Flow<String> =
    flow {
        emit(refresh())
        eventJsonFlow(capacity).collect { eventJson ->
            if (shouldRefresh(eventJson)) {
                emit(refresh())
            }
        }
    }.distinctUntilChanged()

fun SyncularBoltClient.presenceJsonFlow(
    scopeKey: String,
    capacity: ULong = 256uL,
): Flow<String> =
    refreshingJsonFlow(
        capacity = capacity,
        refresh = { presenceJson(scopeKey) },
        shouldRefresh = { it.contains("PresenceChanged") },
    )

fun SyncularBoltClient.outboxSummariesJsonFlow(
    capacity: ULong = 256uL,
): Flow<String> =
    refreshingJsonFlow(
        capacity = capacity,
        refresh = { outboxSummariesJson() },
        shouldRefresh = { it.contains("Sync") || it.contains("WorkerCommand") },
    )

fun SyncularBoltClient.conflictSummariesJsonFlow(
    capacity: ULong = 256uL,
): Flow<String> =
    refreshingJsonFlow(
        capacity = capacity,
        refresh = { conflictSummariesJson() },
        shouldRefresh = { it.contains("Conflict") || it.contains("ConflictsChanged") },
    )

fun SyncularBoltClient.blobUploadQueueStatsJsonFlow(
    capacity: ULong = 256uL,
): Flow<String> =
    refreshingJsonFlow(
        capacity = capacity,
        refresh = { blobUploadQueueStatsJson() },
        shouldRefresh = { it.contains("WorkerCommand") || it.contains("Sync") },
    )

fun SyncularBoltClient.tableRowsJsonFlow(
    table: String,
    capacity: ULong = 256uL,
): Flow<String> =
    refreshingJsonFlow(
        capacity = capacity,
        refresh = { listTableJson(table) },
        shouldRefresh = { eventJson ->
            (eventJson.contains("RowsChanged") || eventJson.contains("QueriesChanged")) &&
                eventJson.contains("\"$table\"")
        },
    )

fun SyncularBoltClient.queryJsonFlow(
    requestJson: String,
    capacity: ULong = 256uL,
): Flow<String> =
    refreshingJsonFlow(
        capacity = capacity,
        refresh = { queryJson(requestJson) },
        shouldRefresh = { it.contains("RowsChanged") || it.contains("QueriesChanged") },
    )

fun SyncularBoltClient.registeredQueryJsonFlow(
    requestJson: String,
    registrationJson: String,
    capacity: ULong = 256uL,
): Flow<String> =
    flow {
        val queryId = registerQueryJson(registrationJson)
        try {
            queryJsonFlow(requestJson, capacity).collect { emit(it) }
        } finally {
            unregisterQuery(queryId)
        }
    }.distinctUntilChanged()
