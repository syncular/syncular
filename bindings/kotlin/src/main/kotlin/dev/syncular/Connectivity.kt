package dev.syncular

fun interface SyncularConnectivitySubscription : AutoCloseable {
    override fun close()
}

interface SyncularConnectivitySignal {
    val online: Boolean
    fun subscribe(listener: (Boolean) -> Unit): SyncularConnectivitySubscription
}

/** Adapts Android's current network state and NetworkCallback registration. */
class AndroidConnectivitySignal(
    private val current: () -> Boolean,
    private val observe: ((Boolean) -> Unit) -> SyncularConnectivitySubscription,
) : SyncularConnectivitySignal {
    override val online: Boolean get() = current()
    override fun subscribe(listener: (Boolean) -> Unit): SyncularConnectivitySubscription =
        observe(listener)
}

/** Binds connectivity evidence to the client's offline lifecycle. */
class SyncularConnectivityAdapter(
    client: SyncularClient,
    signal: SyncularConnectivitySignal,
) : AutoCloseable {
    private var subscription: SyncularConnectivitySubscription?

    init {
        if (signal.online) client.resume() else client.pause()
        subscription = signal.subscribe { online ->
            if (online) client.resume() else client.pause()
        }
    }

    override fun close() {
        subscription?.close()
        subscription = null
    }
}
