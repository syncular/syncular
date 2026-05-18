package dev.syncular.client

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.channels.awaitClose
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.callbackFlow
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
