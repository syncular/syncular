package dev.syncular.client

import androidx.compose.runtime.Composable
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.State
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import kotlinx.coroutines.flow.Flow

@Immutable
data class SyncularComposeEventState<Event>(
    val latestEvent: Event? = null,
    val eventCount: Long = 0,
    val isRunning: Boolean = false,
    val lastError: Throwable? = null,
)

@Immutable
data class SyncularComposeJsonState(
    val json: String? = null,
    val refreshCount: Long = 0,
    val isRunning: Boolean = false,
    val lastError: Throwable? = null,
)

@Composable
fun <Event> rememberSyncularEventState(
    events: Flow<Event>,
): State<SyncularComposeEventState<Event>> {
    val state = remember { mutableStateOf(SyncularComposeEventState<Event>()) }
    LaunchedEffect(events) {
        state.value = state.value.copy(isRunning = true, lastError = null)
        try {
            events.collect { event ->
                state.value = SyncularComposeEventState(
                    latestEvent = event,
                    eventCount = state.value.eventCount + 1,
                    isRunning = true,
                    lastError = null,
                )
            }
            state.value = state.value.copy(isRunning = false)
        } catch (error: Throwable) {
            state.value = state.value.copy(isRunning = false, lastError = error)
        }
    }
    return state
}

@Composable
fun rememberSyncularJsonState(
    values: Flow<String>,
): State<SyncularComposeJsonState> {
    val state = remember { mutableStateOf(SyncularComposeJsonState()) }
    LaunchedEffect(values) {
        state.value = state.value.copy(isRunning = true, lastError = null)
        try {
            values.collect { json ->
                state.value = SyncularComposeJsonState(
                    json = json,
                    refreshCount = state.value.refreshCount + 1,
                    isRunning = true,
                    lastError = null,
                )
            }
            state.value = state.value.copy(isRunning = false)
        } catch (error: Throwable) {
            state.value = state.value.copy(isRunning = false, lastError = error)
        }
    }
    return state
}

@Composable
fun rememberSyncularPresenceState(
    client: SyncularBoltClient,
    scopeKey: String,
    capacity: ULong = 256uL,
): State<SyncularComposeJsonState> =
    rememberSyncularJsonState(client.presenceJsonFlow(scopeKey, capacity))

@Composable
fun rememberSyncularOutboxState(
    client: SyncularBoltClient,
    capacity: ULong = 256uL,
): State<SyncularComposeJsonState> =
    rememberSyncularJsonState(client.outboxSummariesJsonFlow(capacity))

@Composable
fun rememberSyncularConflictState(
    client: SyncularBoltClient,
    capacity: ULong = 256uL,
): State<SyncularComposeJsonState> =
    rememberSyncularJsonState(client.conflictSummariesJsonFlow(capacity))

@Composable
fun rememberSyncularBlobUploadQueueState(
    client: SyncularBoltClient,
    capacity: ULong = 256uL,
): State<SyncularComposeJsonState> =
    rememberSyncularJsonState(client.blobUploadQueueStatsJsonFlow(capacity))

@Composable
fun rememberSyncularTableRowsState(
    client: SyncularBoltClient,
    table: String,
    capacity: ULong = 256uL,
): State<SyncularComposeJsonState> =
    rememberSyncularJsonState(client.tableRowsJsonFlow(table, capacity))

@Composable
fun rememberSyncularQueryState(
    client: SyncularBoltClient,
    requestJson: String,
    capacity: ULong = 256uL,
): State<SyncularComposeJsonState> =
    rememberSyncularJsonState(client.queryJsonFlow(requestJson, capacity))
