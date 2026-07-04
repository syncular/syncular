package com.syncular

import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.modules.core.DeviceEventManagerModule
import java.lang.foreign.Arena
import java.lang.foreign.FunctionDescriptor
import java.lang.foreign.Linker
import java.lang.foreign.MemorySegment
import java.lang.foreign.ValueLayout
import java.lang.invoke.MethodHandle
import java.util.concurrent.atomic.AtomicBoolean

/**
 * The syncular React Native module — Android (Kotlin) implementation.
 *
 * A THIN shim over the syncular-ffi C ABI (rust/ffi.h) via FFM
 * (java.lang.foreign) — the SAME technique as bindings/kotlin, so there is ZERO
 * JNI C glue. The native `.so`s (arm64-v8a + x86_64) come from
 * `build-native.sh android` (cargo-ndk) and ship under the app's `jniLibs`;
 * `System.loadLibrary("syncular")` resolves them.
 *
 * Everything is JSON strings on the wire (matching the C ABI), so there is no
 * custom marshaling — the JS layer (src/index.ts) owns parsing and the
 * {$bytes:hex} convention. Events pump on a background thread and emit on the
 * `syncular::event` DeviceEventManager topic.
 *
 * Note on FFM + Android: FFM (Panama) requires a recent Android runtime. On
 * older Android, swap this shim's downcalls for JNI or the JNA fallback (see
 * bindings/kotlin/README.md); the RN surface is unchanged.
 */
class SyncularModule(private val reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext) {

    private var handle: MemorySegment = MemorySegment.NULL
    private val pumping = AtomicBoolean(false)
    private var pumpThread: Thread? = null

    override fun getName(): String = "Syncular"

    // -- Spec methods ---------------------------------------------------------

    @ReactMethod
    fun create(configJson: String, createJson: String, promise: Promise) {
        try {
            if (handle.address() != 0L) {
                Ffi.clientClose(handle)
                handle = MemorySegment.NULL
            }
            handle = Ffi.clientNew(configJson)
            if (handle.address() == 0L) {
                promise.reject("client.failed", "syncular_client_new returned null")
                return
            }
            val command = "{\"method\":\"create\",\"params\":$createJson}"
            promise.resolve(Ffi.clientCommand(handle, command))
        } catch (t: Throwable) {
            promise.reject("client.failed", t.message, t)
        }
    }

    @ReactMethod
    fun command(commandJson: String, promise: Promise) {
        if (handle.address() == 0L) {
            promise.reject("client.closed", "client is closed")
            return
        }
        try {
            promise.resolve(Ffi.clientCommand(handle, commandJson))
        } catch (t: Throwable) {
            promise.reject("client.failed", t.message, t)
        }
    }

    @ReactMethod
    fun query(sql: String, paramsJson: String, promise: Promise) {
        if (handle.address() == 0L) {
            promise.reject("client.closed", "client is closed")
            return
        }
        try {
            val sqlLiteral = jsonString(sql)
            val command =
                "{\"method\":\"query\",\"params\":{\"sql\":$sqlLiteral,\"params\":$paramsJson}}"
            promise.resolve(Ffi.clientCommand(handle, command))
        } catch (t: Throwable) {
            promise.reject("client.failed", t.message, t)
        }
    }

    @ReactMethod
    fun close(promise: Promise) {
        stopPump()
        if (handle.address() != 0L) {
            Ffi.clientClose(handle)
            handle = MemorySegment.NULL
        }
        promise.resolve(null)
    }

    @ReactMethod
    fun startEvents() {
        startPump()
    }

    @ReactMethod
    fun stopEvents() {
        stopPump()
    }

    // NativeEventEmitter plumbing (required by the RN event contract).
    @ReactMethod fun addListener(eventName: String) { /* no-op: emitter is native-driven */ }

    @ReactMethod fun removeListeners(count: Int) { /* no-op */ }

    // -- Event pump -----------------------------------------------------------

    private fun startPump() {
        if (handle.address() == 0L || !pumping.compareAndSet(false, true)) return
        val thread = Thread({ runPump() }, "syncular-poll").apply { isDaemon = true }
        pumpThread = thread
        thread.start()
    }

    private fun stopPump() {
        pumping.set(false)
        pumpThread?.join()
        pumpThread = null
    }

    private fun runPump() {
        val emitter =
            reactContext.getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
        while (pumping.get() && handle.address() != 0L) {
            val event = Ffi.clientPollEvent(handle, 25) ?: continue
            emitter.emit("syncular::event", event)
        }
    }

    override fun invalidate() {
        stopPump()
        if (handle.address() != 0L) {
            Ffi.clientClose(handle)
            handle = MemorySegment.NULL
        }
        super.invalidate()
    }

    private fun jsonString(value: String): String {
        val sb = StringBuilder("\"")
        for (c in value) {
            when (c) {
                '"' -> sb.append("\\\"")
                '\\' -> sb.append("\\\\")
                '\n' -> sb.append("\\n")
                '\r' -> sb.append("\\r")
                '\t' -> sb.append("\\t")
                else -> if (c < ' ') sb.append("\\u%04x".format(c.code)) else sb.append(c)
            }
        }
        return sb.append('"').toString()
    }

    /** The FFM downcalls to the five C functions — mirrors bindings/kotlin's
     *  SyncularFfi, loading the library by name from the APK's jniLibs. */
    private object Ffi {
        private val linker = Linker.nativeLinker()
        private val lookup: java.lang.foreign.SymbolLookup
        private val hNew: MethodHandle
        private val hCommand: MethodHandle
        private val hPollEvent: MethodHandle
        private val hClose: MethodHandle
        private val hFreeString: MethodHandle

        init {
            System.loadLibrary("syncular")
            lookup = java.lang.foreign.SymbolLookup.loaderLookup()
            val ptr = ValueLayout.ADDRESS
            val long = ValueLayout.JAVA_LONG
            hNew = downcall("syncular_client_new", FunctionDescriptor.of(ptr, ptr))
            hCommand = downcall("syncular_client_command", FunctionDescriptor.of(ptr, ptr, ptr))
            hPollEvent = downcall("syncular_client_poll_event", FunctionDescriptor.of(ptr, ptr, long))
            hClose = downcall("syncular_client_close", FunctionDescriptor.ofVoid(ptr))
            hFreeString = downcall("syncular_free_string", FunctionDescriptor.ofVoid(ptr))
        }

        private fun downcall(name: String, d: FunctionDescriptor): MethodHandle =
            linker.downcallHandle(
                lookup.find(name).orElseThrow { UnsatisfiedLinkError("syncular-ffi: $name") },
                d,
            )

        fun clientNew(configJson: String): MemorySegment =
            Arena.ofConfined().use { a -> hNew.invokeExact(a.allocateUtf8String(configJson)) as MemorySegment }

        fun clientCommand(handle: MemorySegment, commandJson: String): String? =
            Arena.ofConfined().use { a ->
                takeOwned(hCommand.invokeExact(handle, a.allocateUtf8String(commandJson)) as MemorySegment)
            }

        fun clientPollEvent(handle: MemorySegment, timeoutMs: Long): String? =
            takeOwned(hPollEvent.invokeExact(handle, timeoutMs) as MemorySegment)

        fun clientClose(handle: MemorySegment) { hClose.invokeExact(handle) as Unit }

        private fun takeOwned(ptr: MemorySegment): String? {
            if (ptr.address() == 0L) return null
            val str = ptr.reinterpret(Long.MAX_VALUE).getUtf8String(0)
            hFreeString.invokeExact(ptr) as Unit
            return str
        }
    }
}
