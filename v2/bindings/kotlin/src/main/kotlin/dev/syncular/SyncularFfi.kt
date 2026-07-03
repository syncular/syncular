package dev.syncular

import java.lang.foreign.Arena
import java.lang.foreign.FunctionDescriptor
import java.lang.foreign.Linker
import java.lang.foreign.MemorySegment
import java.lang.foreign.SymbolLookup
import java.lang.foreign.ValueLayout
import java.lang.invoke.MethodHandle

/**
 * The FFM (java.lang.foreign, JDK 21+) binding to the five C functions of the
 * syncular-ffi native core (rust/ffi.h). ZERO native-glue code — no JNI C shim,
 * no cbindgen: pure Panama downcalls. This keeps the Kotlin wrapper as thin as
 * the Swift one.
 *
 * The library is loaded from an explicit path (`syncular.library.path` system
 * property, set by check.sh to the vendored dylib) or, failing that, by name
 * from `java.library.path` (`libsyncular.dylib`/`.so` / `syncular.dll`), which
 * is how a packaged app ships it (jniLibs on Android, a bundled resource on the
 * JVM).
 *
 * Marshaling contract: all five functions take/return C strings. We copy Kotlin
 * strings into a per-call [Arena] as UTF-8, call, then copy the returned C
 * string back out and free it with `syncular_free_string` — never the platform
 * `free`. Returned strings are heap-owned by the library.
 */
internal object SyncularFfi {
    private val linker: Linker = Linker.nativeLinker()
    private val lookup: SymbolLookup
    private val hNew: MethodHandle
    private val hCommand: MethodHandle
    private val hPollEvent: MethodHandle
    private val hClose: MethodHandle
    private val hFreeString: MethodHandle

    init {
        val explicit = System.getProperty("syncular.library.path")
        val arena = Arena.global()
        lookup = if (explicit != null) {
            SymbolLookup.libraryLookup(explicit, arena)
        } else {
            // System.loadLibrary resolves "syncular" via java.library.path.
            System.loadLibrary("syncular")
            SymbolLookup.loaderLookup()
        }

        val ptr = ValueLayout.ADDRESS
        val long = ValueLayout.JAVA_LONG
        hNew = downcall("syncular_client_new", FunctionDescriptor.of(ptr, ptr))
        hCommand = downcall("syncular_client_command", FunctionDescriptor.of(ptr, ptr, ptr))
        hPollEvent = downcall("syncular_client_poll_event", FunctionDescriptor.of(ptr, ptr, long))
        hClose = downcall("syncular_client_close", FunctionDescriptor.ofVoid(ptr))
        hFreeString = downcall("syncular_free_string", FunctionDescriptor.ofVoid(ptr))
    }

    private fun downcall(name: String, descriptor: FunctionDescriptor): MethodHandle {
        val symbol = lookup.find(name).orElseThrow {
            UnsatisfiedLinkError("syncular-ffi: symbol not found: $name")
        }
        return linker.downcallHandle(symbol, descriptor)
    }

    /** `syncular_client_new(configJson)` → opaque handle (MemorySegment), or NULL. */
    fun clientNew(configJson: String): MemorySegment {
        Arena.ofConfined().use { arena ->
            val config = arena.allocateUtf8String(configJson)
            return hNew.invokeExact(config) as MemorySegment
        }
    }

    /** `syncular_client_command(handle, commandJson)` → reply JSON (owned; freed here). */
    fun clientCommand(handle: MemorySegment, commandJson: String): String? {
        Arena.ofConfined().use { arena ->
            val command = arena.allocateUtf8String(commandJson)
            val reply = hCommand.invokeExact(handle, command) as MemorySegment
            return takeOwnedString(reply)
        }
    }

    /** `syncular_client_poll_event(handle, timeoutMs)` → event JSON (owned; freed here), or null. */
    fun clientPollEvent(handle: MemorySegment, timeoutMs: Long): String? {
        val event = hPollEvent.invokeExact(handle, timeoutMs) as MemorySegment
        return takeOwnedString(event)
    }

    /** `syncular_client_close(handle)`. */
    fun clientClose(handle: MemorySegment) {
        hClose.invokeExact(handle) as Unit
    }

    /**
     * Copy a library-owned C string out to a Kotlin String, then free it with
     * `syncular_free_string`. Returns null for a NULL pointer.
     */
    private fun takeOwnedString(ptr: MemorySegment): String? {
        if (ptr.address() == 0L) return null
        // The library did not tell us the length; reinterpret unbounded so we
        // can read the NUL-terminated string, then free the original pointer.
        val str = ptr.reinterpret(Long.MAX_VALUE).getUtf8String(0)
        hFreeString.invokeExact(ptr) as Unit
        return str
    }
}
