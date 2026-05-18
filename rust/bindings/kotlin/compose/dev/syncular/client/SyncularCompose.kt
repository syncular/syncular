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
