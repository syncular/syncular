package dev.syncular

import java.lang.foreign.MemorySegment
import java.util.concurrent.atomic.AtomicBoolean

/**
 * An event surfaced by the native core's `poll_event`: an exact revisioned
 * `change` batch, explicit `sync-intent`, or ephemeral `presence`. The full
 * decoded object is preserved; [type] is lifted for switching.
 */
data class SyncularEvent(val type: String, val payload: JsonValue)

/** A listener for client-observable events (invoked on the poll thread's
 * delivery — the caller marshals to its UI thread as needed). */
fun interface SyncularEventListener {
    fun onEvent(event: SyncularEvent)
}

/** The error a `{error}` reply surfaces: a stable [code] plus a [message]. */
class SyncularException(val code: String, message: String) : RuntimeException(message)

/**
 * Configuration for a [SyncularClient]. [baseUrl] engages the native HTTP+WS
 * transport (only in a `native-transport` core build); omit it for the
 * dependency-lean, offline-first local core. [dbPath] installs a file-backed
 * SQLite database for persistence across launches; omit for in-memory.
 */
data class SyncularConfig(
    val baseUrl: String? = null,
    val wsUrl: String? = null,
    val headers: Map<String, String> = emptyMap(),
    val dbPath: String? = null,
) {
    /** The `syncular_client_new` config JSON (transport fields only). */
    internal fun newConfigJson(): JsonValue {
        val fields = LinkedHashMap<String, JsonValue>()
        baseUrl?.let { fields["baseUrl"] = JsonValue.of(it) }
        wsUrl?.let { fields["wsUrl"] = JsonValue.of(it) }
        if (headers.isNotEmpty()) {
            fields["headers"] = JsonValue.Obj(headers.mapValues { JsonValue.of(it.value) })
        }
        return JsonValue.Obj(fields)
    }
}

/**
 * An idiomatic Kotlin/JVM wrapper over the syncular-ffi C core, via FFM
 * (java.lang.foreign, JDK 21+) — see [SyncularFfi]. Deliberately THIN: it owns
 * the opaque handle, marshals JSON, exposes typed conveniences over the common
 * commands, and runs the `poll_event` loop on a background thread delivering to
 * a registered listener.
 *
 * Thread-affinity: the core is thread-affine. This wrapper serializes ALL
 * command dispatch through `commandLock`; the poll loop runs on its own thread
 * but only ever calls `poll_event` (which drains a separate blocking queue in
 * the core). `close()` stops the poll loop and JOINS its thread before freeing
 * the handle, so the core is never freed under an in-flight `poll_event`.
 */
class SyncularClient private constructor(
    private var handle: MemorySegment,
) : AutoCloseable {
    private val commandLock = Any()
    private val pollRunning = AtomicBoolean(false)
    private var pollThread: Thread? = null
    @Volatile private var closed = false

    /** The event listener (invoked on the poll thread). Set before/after init. */
    @Volatile var listener: SyncularEventListener? = null

    companion object {
        /**
         * Create the native core and issue `create` with the given schema,
         * then start the event poll loop.
         *
         * @param clientId optional explicit stable id. When null, the core
         *   creates and persists one in the database.
         * @param schema the generated schema JSON.
         * @param config transport + db path configuration.
         * @param limits optional §4.2 client limits, forwarded to `create`.
         */
        @JvmStatic
        @JvmOverloads
        fun create(
            clientId: String? = null,
            schema: JsonValue,
            config: SyncularConfig = SyncularConfig(),
            limits: JsonValue? = null,
        ): SyncularClient {
            val handle = SyncularFfi.clientNew(config.newConfigJson().encode())
            if (handle.address() == 0L) {
                throw SyncularException(
                    "client.failed",
                    "syncular_client_new returned null (malformed config or unsupported transport)",
                )
            }
            val client = SyncularClient(handle)
            val createParams = LinkedHashMap<String, JsonValue>()
            clientId?.let { createParams["clientId"] = JsonValue.of(it) }
            createParams["schema"] = schema
            config.dbPath?.let { createParams["dbPath"] = JsonValue.of(it) }
            limits?.let { createParams["limits"] = it }
            client.command("create", JsonValue.Obj(createParams))
            client.startPollLoop()
            return client
        }
    }

    // -- Raw command -----------------------------------------------------------

    /**
     * Run one raw JSON command through the core. Returns the `result` value, or
     * throws [SyncularException] on an `{error}` reply. Serialized (the core is
     * thread-affine).
     */
    fun command(method: String, params: JsonValue): JsonValue {
        val request = JsonValue.obj("method" to JsonValue.of(method), "params" to params)
        val replyJson = synchronized(commandLock) {
            if (closed) throw SyncularException("client.closed", "client is closed")
            SyncularFfi.clientCommand(handle, request.encode())
                ?: throw SyncularException("client.failed", "null reply (null handle)")
        }
        val reply = JsonValue.parse(replyJson)
        reply["error"]?.let { error ->
            val code = error["code"]?.string ?: "client.failed"
            val message = error["message"]?.string ?: "command failed"
            throw SyncularException(code, message)
        }
        return reply["result"] ?: reply
    }

    // -- Typed conveniences (mirror the command surface) -----------------------

    /** Apply local mutations optimistically; returns the client commit id.
     *  Works OFFLINE — the row is visible immediately via readRows/query. */
    fun mutate(mutations: List<JsonValue>): String {
        val result = command("mutate", JsonValue.obj("mutations" to JsonValue.arr(mutations)))
        return result["clientCommitId"]?.string
            ?: throw SyncularException("client.failed", "mutate returned no clientCommitId")
    }

    // -- Native CRDT (SPEC.md §5.10.5; needs the FFI `crdt-yjs` feature) --------

    /** Materialize a `crdt` column's collaborative text — decoded from the
     *  stored (server-merged) Yjs bytes. `name` selects the shared text
     *  (default `"text"`). Absent row / NULL column = empty document. */
    @JvmOverloads
    fun crdtText(table: String, rowId: String, column: String, name: String = "text"): String {
        val result = command(
            "crdtText",
            JsonValue.obj(
                "table" to JsonValue.of(table), "rowId" to JsonValue.of(rowId),
                "column" to JsonValue.of(column), "name" to JsonValue.of(name),
            ),
        )
        return result["text"]?.string
            ?: throw SyncularException("client.failed", "crdtText returned no text")
    }

    /** Insert `value` at UTF-16 offset `index` in a `crdt` column's text and
     *  push the resulting Yjs update (baseVersion-less). Returns the commit id. */
    @JvmOverloads
    fun crdtInsertText(
        table: String,
        rowId: String,
        column: String,
        index: Int,
        value: String,
        name: String = "text",
    ): String = crdtCommitId(
        "crdtInsertText",
        JsonValue.obj(
            "table" to JsonValue.of(table), "rowId" to JsonValue.of(rowId),
            "column" to JsonValue.of(column), "name" to JsonValue.of(name),
            "index" to JsonValue.of(index), "value" to JsonValue.of(value),
        ),
    )

    /** Delete `len` UTF-16 code units at `index` in a `crdt` column's text. */
    @JvmOverloads
    fun crdtDeleteText(
        table: String,
        rowId: String,
        column: String,
        index: Int,
        len: Int,
        name: String = "text",
    ): String = crdtCommitId(
        "crdtDeleteText",
        JsonValue.obj(
            "table" to JsonValue.of(table), "rowId" to JsonValue.of(rowId),
            "column" to JsonValue.of(column), "name" to JsonValue.of(name),
            "index" to JsonValue.of(index), "len" to JsonValue.of(len),
        ),
    )

    /** Escape hatch: apply an arbitrary Yjs update onto a `crdt` column. */
    fun crdtApplyUpdate(table: String, rowId: String, column: String, update: ByteArray): String {
        val hex = StringBuilder(update.size * 2)
        for (b in update) hex.append("%02x".format(b.toInt() and 0xff))
        return crdtCommitId(
            "crdtApplyUpdate",
            JsonValue.obj(
                "table" to JsonValue.of(table), "rowId" to JsonValue.of(rowId),
                "column" to JsonValue.of(column),
                "update" to JsonValue.obj("\$bytes" to JsonValue.of(hex.toString())),
            ),
        )
    }

    private fun crdtCommitId(method: String, params: JsonValue): String {
        val result = command(method, params)
        return result["clientCommitId"]?.string
            ?: throw SyncularException("client.failed", "$method returned no clientCommitId")
    }

    /** Register a subscription (table + scope map). Local; sync fills it. */
    @JvmOverloads
    fun subscribe(
        id: String,
        table: String,
        scopes: Map<String, List<String>> = emptyMap(),
        params: String? = null,
    ) {
        val p = LinkedHashMap<String, JsonValue>()
        p["id"] = JsonValue.of(id)
        p["table"] = JsonValue.of(table)
        p["scopes"] = JsonValue.Obj(scopes.mapValues { (_, v) -> JsonValue.arr(v.map(JsonValue::of)) })
        params?.let { p["params"] = JsonValue.of(it) }
        command("subscribe", JsonValue.Obj(p))
    }

    /** Remove a subscription. */
    fun unsubscribe(id: String) {
        command("unsubscribe", JsonValue.obj("id" to JsonValue.of(id)))
    }

    /** Run one sync round against the server (needs native-transport). Never
     *  errors out-of-band; inspect `ok`/`errorCode` on the returned object. */
    fun sync(): JsonValue = command("sync", JsonValue.Obj(emptyMap()))

    /** Drive sync to quiescence (needs native-transport). */
    @JvmOverloads
    fun syncUntilIdle(maxRounds: Int? = null): JsonValue {
        val p = LinkedHashMap<String, JsonValue>()
        maxRounds?.let { p["maxRounds"] = JsonValue.of(it) }
        return command("syncUntilIdle", JsonValue.Obj(p))
    }

    /** Read all locally-visible rows of a table as RowState objects
     *  (`{rowId, version, values}`; version -1 = optimistic/offline). */
    fun readRows(table: String): List<JsonValue> {
        val result = command("readRows", JsonValue.obj("table" to JsonValue.of(table)))
        return result["rows"]?.array ?: emptyList()
    }

    /** Run arbitrary read-only SQL over the local visible tables (the live-query
     *  fast path). Bytes ride as `{"$bytes":hex}`. Returns flat SQL rows. */
    @JvmOverloads
    fun query(sql: String, params: List<JsonValue> = emptyList()): List<JsonValue> {
        val result = command(
            "query",
            JsonValue.obj("sql" to JsonValue.of(sql), "params" to JsonValue.arr(params)),
        )
        return result["rows"]?.array ?: emptyList()
    }

    /** Pending client commit ids (the offline outbox — non-empty after a local
     *  mutate until sync drains it). The honest "unsynced work" signal. */
    fun pendingCommitIds(): List<String> {
        val result = command("pendingCommitIds", JsonValue.Obj(emptyMap()))
        return result["ids"]?.array?.mapNotNull { it.string } ?: emptyList()
    }

    /** The current sync-needed flag (§8.4 wake signal). */
    fun syncNeeded(): Boolean =
        command("syncNeeded", JsonValue.Obj(emptyMap()))["value"]?.bool ?: false

    /** A subscription's status string (active/revoked/failed) — the status
     *  surface. Lifted from the `{state: {…, status}}` view. */
    fun subscriptionState(id: String): String? =
        command("subscriptionState", JsonValue.obj("id" to JsonValue.of(id)))["state"]?.get("status")?.string

    /** Current conflicts (§6). */
    fun conflicts(): List<JsonValue> =
        command("conflicts", JsonValue.Obj(emptyMap()))["conflicts"]?.array ?: emptyList()

    /** Presence peers for a scope key (§8.6). */
    fun presence(scopeKey: String): List<JsonValue> =
        command("presence", JsonValue.obj("scopeKey" to JsonValue.of(scopeKey)))["peers"]?.array ?: emptyList()

    /** Publish (or clear, with null) a presence doc for a scope key. */
    fun setPresence(scopeKey: String, doc: JsonValue?) {
        command(
            "setPresence",
            JsonValue.obj("scopeKey" to JsonValue.of(scopeKey), "doc" to (doc ?: JsonValue.Null)),
        )
    }

    /** Open the realtime socket (needs native-transport). */
    fun connectRealtime() { command("connectRealtime", JsonValue.Obj(emptyMap())) }

    /** Close the realtime socket. */
    fun disconnectRealtime() { command("disconnectRealtime", JsonValue.Obj(emptyMap())) }

    // -- Lifecycle (the wrapper owns it, per the roadmap) ----------------------

    /**
     * Pause background activity — stop the event poll loop and disconnect the
     * realtime socket. Call from an Android `onStop()` / a connectivity-lost
     * handler. The database and offline outbox are intact; mutations still
     * queue. [resume] restarts the loop and socket. Honest scope: the core has
     * no single "stop everything" command, so pause = stop-poll + disconnect.
     */
    fun pause() {
        stopPollLoop()
        runCatching { disconnectRealtime() } // lean/offline core has no socket
    }

    /** Resume after [pause] — reconnect realtime (if present) and restart poll. */
    fun resume() {
        runCatching { connectRealtime() }
        startPollLoop()
    }

    /** Close the core, releasing its database/transport/socket. Idempotent;
     *  commands throw `client.closed` after. Joins the poll thread first, so the
     *  handle is never freed under an in-flight `poll_event`. */
    override fun close() {
        stopPollLoop()
        synchronized(commandLock) {
            if (closed) return
            closed = true
            SyncularFfi.clientClose(handle)
            handle = MemorySegment.NULL
        }
    }

    // -- Event poll loop -------------------------------------------------------

    private fun startPollLoop() {
        if (closed || !pollRunning.compareAndSet(false, true)) return
        val thread = Thread({ runPollLoop() }, "syncular-poll").apply { isDaemon = true }
        pollThread = thread
        thread.start()
    }

    private fun stopPollLoop() {
        pollRunning.set(false)
        pollThread?.let { thread ->
            // The loop uses a 25 ms bounded poll, so it observes the flag and
            // exits promptly; join guarantees no in-flight poll_event remains.
            thread.join()
        }
        pollThread = null
    }

    private fun runPollLoop() {
        while (pollRunning.get()) {
            // The handle is only freed by close(), which first stops+joins THIS
            // loop — so it stays valid across the poll_event call below.
            val eventJson = SyncularFfi.clientPollEvent(handle, 25) ?: continue
            val value = runCatching { JsonValue.parse(eventJson) }.getOrNull() ?: continue
            val type = value["type"]?.string ?: continue
            listener?.onEvent(SyncularEvent(type, value))
        }
    }
}
