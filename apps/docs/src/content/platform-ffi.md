# Embedding via C FFI

The **`syncular-ffi`** crate packages the Rust client core as `libsyncular`,
a native library with a five-function **C ABI** that the Swift, Kotlin,
Flutter, and React Native bindings all wrap. This page is the
contract for embedding it in any host language, and what it takes to write a
new binding.

## The five functions

Verbatim from [`rust/ffi.h`](https://github.com/syncular/syncular/blob/main/rust/ffi.h)
(hand-written, dependency-free; a `header_matches_symbols` test keeps it
exactly in sync with the exported symbols):

```c
void *syncular_client_new(const char *config_json);
char *syncular_client_command(void *handle, const char *command_json);
char *syncular_client_poll_event(void *handle, int64_t timeout_ms);
void  syncular_client_close(void *handle);
void  syncular_free_string(char *ptr);
```

The contract:

- All strings are **UTF-8, NUL-terminated**.
- Strings returned by `syncular_client_command` and
  `syncular_client_poll_event` are heap-owned by the library. Free them by
  calling `syncular_free_string` exactly once each; calling `free()` on
  them directly is undefined behavior.
- `syncular_client_poll_event` timeout semantics: `timeout_ms < 0` blocks
  until an event arrives, `0` returns immediately, `> 0` waits up to that
  many milliseconds. Returns NULL if nothing arrived in time.
- **Thread-affine**: drive one handle from one thread. If other threads need
  access, post requests to the owning thread (the mailbox pattern every
  shipped binding uses).
- `syncular_client_new` returns NULL on a malformed config or an unsupported
  transport; `syncular_client_command` returns NULL only on a NULL handle.
- `syncular_client_close` releases the database, transport, and socket
  thread; the handle is invalid afterwards.

## Config JSON

`syncular_client_new` takes a JSON object:

```json
{}
```

is the **dependency-lean core**: client-local commands (create, subscribe,
mutate, readRows, query, …) work; network commands return
`transport.unavailable`. No HTTP, WS, or TLS is compiled in.

```json
{ "baseUrl": "https://host/mount", "headers": { "authorization": "…" }, "wsUrl": "wss://…" }
```

engages the **native transport** (requires a `native-transport` build):
blocking HTTP via `ureq` (`POST /sync`, `GET /segments/{id}`, the blob
endpoints, bare signed-URL fetches) and a `tungstenite` realtime socket with
a reader thread. `wsUrl` is optional; when absent, it is derived from
`baseUrl`.
Passing a `baseUrl` to a lean build makes `syncular_client_new` return NULL:
the lean build has no transport to satisfy the request.

## The JSON command surface

`syncular_client_command` takes `{"method": "...", "params": {...}}` and
returns `{"result": ...}` or `{"error": {"code": "...", "message": "..."}}`.
Bytes ride inside the JSON as `{"$bytes": "<lowercase-hex>"}`, so a binding
marshals plain strings with zero custom serialization.

The dispatch itself doesn't live in this crate. It's implemented once in the
shared [`syncular-command`](https://github.com/syncular/syncular/tree/main/rust/crates/command)
router, and the stdio conformance shim, this FFI, and the Tauri plugin all
call into it. Every binding (Swift, Kotlin, Flutter, React Native) drives
that same router beneath its native surface, which is why protocol behavior
is identical across platforms: whatever the shim proves against the
[conformance catalog](/guide-conformance/) applies to every embedding, since
they all run through this single, fully tested router. The methods it
routes:

| Group | Methods |
| --- | --- |
| Lifecycle | `create`, `recreateWithSchema`, `upgrading` |
| Subscriptions | `subscribe`, `unsubscribe`, `subscriptionState`, `setWindow`, `windowState` |
| Writes & reads | `mutate`, `readRows`, `query`, `pendingCommitIds` |
| Sync | `sync`, `syncUntilIdle`, `syncNeeded` |
| Divergence | `conflicts`, `rejections`, `schemaFloor`, `leaseState` |
| Realtime & presence | `connectRealtime`, `disconnectRealtime`, `setPresence`, `presence` |
| Blobs | `uploadBlob`, `fetchBlob` |
| CRDT (`crdt-yjs` feature) | `crdtText`, `crdtInsertText`, `crdtDeleteText`, `crdtApplyUpdate` |
| Conformance helpers | `messageRoundtrip`, `segmentRoundtrip`, `realtimeKnown` |

## Events

The client core has no callbacks, so the FFI forwards its exact revisioned
`change` batches and explicit `sync-intent` effects, plus ephemeral `presence`,
onto a blocking queue. It never derives changes from counters.
`syncular_client_poll_event` drains that queue; each event is a JSON object
with a `type` field. A binding typically pumps `poll_event` on one background
thread and forwards each event onto the platform's event loop.

## Build artifacts

The crate builds as both `cdylib` (the shared object hosts load:
`libsyncular.dylib` / `libsyncular.so` / `syncular.dll`) and `staticlib`
(the archive for static linking, e.g. the iOS xcframework). It is published
as `syncular-ffi` `0.0.0` on crates.io; artifacts are built from the repo:

```sh
rust/scripts/build-native.sh
```

builds every target whose toolchain exists on the machine and skips the
rest: the host desktop cdylib, `Syncular.xcframework` (macOS + iOS device +
simulator, when full Xcode is present), Android `arm64-v8a` + `x86_64` `.so`
via `cargo-ndk`, and linux/windows cross libraries when those toolchains are
installed.

Cargo features: `native-transport` (the ureq + tungstenite stack, on for
shipped app builds and off for the lean/conformance build), `crdt-yjs` (the
native Yjs CRDT commands), `e2ee` (§5.11 client-side encryption). Measured
on macOS arm64 (release, stripped): 2.5 MB lean, 4.6 MB with the native
transport.

A C smoke test proves the ABI end to end on your machine:
[`rust/ffi-smoke/run.sh`](https://github.com/syncular/syncular/blob/main/rust/ffi-smoke/run.sh)
builds the dylib, compiles `main.c` against it, and runs `new` →
`command(create/subscribe/mutate/readRows/subscriptionState)` → `poll_event`
→ `close`, freeing every returned string. No server is needed, since those
are client-local commands.

## How the existing bindings consume it

- **[Swift](/platform-swift/)**: a `SyncularClient` class over the five
  functions, with `poll_event` pumped on a background queue and events
  delivered on the main queue.
- **[Kotlin/JVM](/platform-kotlin/)**: binds via **FFM**
  (`java.lang.foreign`, JDK 21+), with downcall handles over the dylib, zero
  JNI C glue, and no third-party runtime dependency.
- **[Flutter](/platform-flutter/)**: `dart:ffi` downcalls feeding a
  `poll_event`-driven Dart event `Stream`.
- **[React Native](/platform-react-native/)**: TurboModule shims (ObjC++ on
  iOS, Kotlin FFM on Android) forwarding JSON strings.
- **[Tauri](/platform-tauri/)** skips this ABI entirely. A Tauri app is
  already a Rust host, so its plugin depends on `syncular-client` directly
  as a crate and calls it in-process.

## Writing a new binding

A binding is thin marshaling and nothing more: every behavior lives behind
the command surface, which is already conformance-locked. The whole job:

1. Load `libsyncular` and bind the five functions.
2. Wrap the opaque handle in a class that stringifies `{method, params}`,
   parses `{result|error}`, and applies the `{"$bytes": hex}` convention.
3. Honor the memory contract: free every returned string exactly once via
   `syncular_free_string`.
4. Keep the handle thread-affine (own it on one thread; mailbox requests in).
5. Pump `poll_event` on a background thread and surface events on your
   platform's event loop, with a pause/resume/close lifecycle.

The core owns protocol logic, sync scheduling, and SQL handling; the binding
only marshals commands across the boundary. Run a new binding against the
[conformance catalog](/guide-conformance/) to verify it behaves like every
other core.

## Where to go next

- **[Conformance](/guide-conformance/)** — the catalog that locks the
  command surface this ABI exposes.
- **[Rust](/platform-rust/)** — the `syncular-client` crate underneath,
  usable directly from Rust.
- **[Swift](/platform-swift/)** and **[Kotlin](/platform-kotlin/)** — the
  idiomatic wrappers to copy when starting a new binding.
