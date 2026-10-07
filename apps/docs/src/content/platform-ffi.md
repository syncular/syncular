# Embedding via C FFI

The `syncular-ffi` crate packages the Rust client core as `libsyncular`, a native library with a five-function C ABI. This page is the contract for binding authors: the functions, the memory rules, the config and command JSON, the event queue, and the build artifacts. App developers on Swift, Kotlin, or Flutter use the SDK pages instead.

::meta{for="Binding authors and hosts embedding libsyncular in a new language" time="12 minutes"}

:::terms
- **Handle**: The opaque `void *` that `syncular_client_new` returns. It owns one client, one transport, and one event queue.
- **Lean build**: `libsyncular` built without `native-transport`. It has no HTTP, WebSocket, or TLS.
- **Router**: The `syncular-command` dispatcher that executes every command. The conformance shim, this FFI, and the Tauri plugin share it.
:::

:::figure{title="What a binding owns" note="Everything else is the core" ticks}
<div class="d-row">
<div class="node hot"><span class="t">Binding</span>marshals JSON,<br>frees strings, owns the thread,<br>pumps events</div>
<span class="d-arrow"></span>
<div class="node cool"><span class="t">C ABI</span><code>syncular_client_new</code><br><code>_command</code>, <code>_poll_event</code><br><code>_close</code>, <code>syncular_free_string</code></div>
<span class="d-arrow"></span>
<div class="node"><span class="t">Router</span><code>syncular-command</code><br>one dispatch for every host</div>
<span class="d-arrow"></span>
<div class="node ok"><span class="t">Client core</span>SQLite, outbox,<br>native transport</div>
</div>

::caption[The router is conformance-locked, so a binding that marshals correctly inherits the proven behavior. See [Specifications & packages](/reference/#protocol--conformance).]
:::

## The five functions

Verbatim from [`rust/ffi.h`](https://github.com/syncular/syncular/blob/main/rust/ffi.h). The header is hand-written and dependency-free, and the `header_matches_symbols` test keeps it identical to the exported symbols.

```c title="rust/ffi.h"
void *syncular_client_new(const char *config_json);
char *syncular_client_command(void *handle, const char *command_json);
char *syncular_client_poll_event(void *handle, int64_t timeout_ms);
void  syncular_client_close(void *handle);
void  syncular_free_string(char *ptr);
```

| Rule | Detail |
|---|---|
| Encoding | All strings are UTF-8 and NUL-terminated. |
| Ownership | The library owns the strings that `syncular_client_command` and `syncular_client_poll_event` return. Free each exactly once with `syncular_free_string`. Calling `free()` on one is undefined behavior. |
| `poll_event` timeout | `timeout_ms < 0` blocks until an event arrives, `0` returns at once, `> 0` waits up to that many milliseconds. It returns NULL when nothing arrived. |
| Threads | One handle belongs to one thread for commands. `poll_event` reads a separate queue, so a pump thread may block in it while the owner thread issues commands. |
| NULL returns | `syncular_client_new` returns NULL on a malformed config or an unsupported transport. `syncular_client_command` returns NULL only for a NULL handle. |
| Close | `syncular_client_close` releases the database, transport, and socket thread. The handle is invalid afterward, and no thread may be inside `poll_event` for it. |

## Config JSON

`syncular_client_new` takes a JSON object. `{}` builds the lean client: client-local commands (`create`, `subscribe`, `mutate`, `readRows`, `query`) work, and network commands return `transport.unavailable`.

```json title="native transport config"
{ "baseUrl": "https://host/mount", "headers": { "authorization": "..." }, "wsUrl": "wss://..." }
```

`baseUrl` engages the native transport (requires a `native-transport` build): blocking HTTP through `ureq` against `{baseUrl}/sync`, `{baseUrl}/segments/{id}`, the blob endpoints, and bare signed-URL fetches, plus a `tungstenite` realtime socket with a reader thread. `wsUrl` is optional and derives from `baseUrl` as `{baseUrl}/realtime`. A `baseUrl` on a lean build makes `syncular_client_new` return NULL. The config also accepts the transport policy keys `requestTimeoutMs`, `roundDeadlineMs`, `maxRequestBytes`, `maxResponseBytes`, and `redirects`, documented in [Rust: Platform specifics](/platform-rust-specifics/#native-transport-policy).

## The command envelope

`syncular_client_command` takes `{"method": "...", "params": {...}}` and returns `{"result": ...}` or `{"error": {"code": "...", "message": "..."}}`, where details such as `retryable` and `details` ride on the error object. Bytes travel inside the JSON as `{"$bytes": "<lowercase-hex>"}`, so a binding marshals plain strings. A command string that is not valid UTF-8 JSON returns `client.failed`.

The methods the router executes:

| Group | Methods |
|---|---|
| Lifecycle | `create`, `shutdown`, `recreateWithSchema` |
| Security | `securityLifecycle`, `beginSecurityPreflight`, `activateSecurity`, `authoritySnapshot` |
| Subscriptions | `subscribe`, `unsubscribe`, `subscriptionState`, `setWindow`, `windowState` |
| Writes & reads | `mutate`, `patch`, `readRows`, `query`, `querySnapshot`, `snapshotRead`, `pendingCommitIds`, `pendingPayloads` |
| Authorized local purge | `purgeLocalData`, `rebootstrapLocalData` |
| Sync | `sync`, `syncUntilIdle` |
| Transport | `setHeaders`, `setTransportEnabled` |
| Observation | `localRevision`, `statusSnapshot`, `diagnosticsSnapshot`, `progressSnapshot`, `drainChangeBatches`, `drainSyncIntents` |
| Divergence & outcomes | `conflicts`, `rejections`, `commitOutcome`, `commitOutcomes`, `resolveCommitOutcome` |
| Previous-version context | `previousVersionAudit`, `previousVersionSnapshot`, `previousVersionDiscard` |
| Realtime & presence | `connectRealtime`, `disconnectRealtime`, `setPresence`, `presence` |
| Blobs | `uploadBlob`, `fetchBlob` |
| CRDT (`crdt-yjs` feature) | `crdtText`, `crdtInsertText`, `crdtDeleteText`, `crdtApplyUpdate` |
| Conformance helpers | `messageRoundtrip`, `segmentRoundtrip`, `realtimeKnown`, `timeWindowSugar` |

The router no longer has `schemaFloor`, `leaseState`, `upgrading`, or `syncNeeded`; `statusSnapshot` returns those fields. [Native client API](/native-client-api/#snapshot-and-outcome-methods) lists them.

`purgeLocalData` is a local security primitive: a binding validates the directive and gates the affected subscriptions before forwarding it ([Authorized local purge](/concepts-local-data-purge/)). A host can `create` with `securityPreflight: true`, run the validated purge, and call `activateSecurity` with the portable keyring. Until activation the router rejects every other protected command with `client.security_preflight_required`. `beginSecurityPreflight` disconnects realtime and replaces the Rust keyring with an empty one; `shutdown` drops the client. The core overwrites owned native key buffers on replacement and drop.

## Events

The core has no callbacks. The FFI queues its exact revisioned `change` batches, explicit `sync-intent` effects, ephemeral `presence` signals, `progress` snapshots, and `diagnostics` snapshots on a blocking queue, and never derives a change from a counter. `syncular_client_poll_event` drains that queue; each event is a JSON object with a `type` field. The queue keeps only the newest `progress` event, and the FFI emits a `diagnostics` event only when its state changes.

A binding pumps `poll_event` on one background thread and forwards each event to the platform's event loop. Use a bounded wait such as 25 ms so the pump observes a stop flag, and stop and join the pump before `syncular_client_close`.

## Build artifacts

The crate builds as a `cdylib` (`libsyncular.dylib`, `libsyncular.so`, or `syncular.dll`) and a `staticlib` for static linking, such as the iOS xcframework. It is published as `syncular-ffi` on crates.io, and artifacts build from the repository:

```sh title="terminal"
rust/scripts/build-native.sh
```

The script builds every target whose toolchain exists on the machine and skips the rest: the host desktop library, `Syncular.xcframework` (macOS, iOS device, iOS simulator; needs full Xcode), Android `arm64-v8a` and `x86_64` `.so` files through `cargo-ndk`, and Linux and Windows cross libraries when those toolchains are installed. It enables `native-transport` by default; set `SYNCULAR_FFI_FEATURES` to override.

| Cargo feature | Adds |
|---|---|
| `native-transport` | The `ureq` and `tungstenite` stack. On for shipped app builds, off for the lean and conformance build. |
| `crdt-yjs` | The native Yjs CRDT commands. |
| `e2ee` | Client-side encryption (SPEC §5.11). |

On macOS arm64 (release, stripped) the library measured 2.5 MB lean and 4.6 MB with the native transport.

[`rust/ffi-smoke/run.sh`](https://github.com/syncular/syncular/blob/main/rust/ffi-smoke/run.sh) proves the ABI end to end on your machine. It builds the library, compiles `main.c` against it, and runs `new`, then `command` for create, subscribe, mutate, readRows, and subscriptionState, then `poll_event` and `close`, freeing every returned string. It needs no server, since those are client-local commands.

## How the shipped bindings consume it

| Binding | Mechanism | Events |
|---|---|---|
| [Swift](/platform-swift/) | C module over the header; `SyncularClient` | Poll queue, delivered on the main queue |
| [Kotlin](/platform-kotlin/) | FFM downcall handles, no JNI glue | Daemon poll thread |
| [Flutter](/platform-flutter/) | `dart:ffi` | Non-blocking timer poll on the owning isolate |
| [React Native](/platform-react-native/) | TurboModule shims (ObjC++ on iOS, Kotlin FFM on Android) forwarding JSON strings | See the page |
| [Tauri](/platform-tauri/) | None: the plugin depends on `syncular-client` as a crate | In-process |

## Binding checklist

1. Load `libsyncular` and bind the five functions.
2. Wrap the handle in a class that stringifies `{method, params}`, parses `{result}` or `{error}`, and applies the `{"$bytes": hex}` convention.
3. Free every returned string exactly once with `syncular_free_string`.
4. Own the handle on one thread and mailbox every request into it. Shipped wrappers serialize commands with a queue or a lock.
5. Pump `poll_event` on a background thread, surface events on the platform loop, and implement `pause()`, `resume()`, and `close()`. `pause()` stops the pump and calls `disconnectRealtime`; `resume()` calls `connectRealtime` and restarts the pump. The core has no single stop-everything command.
6. Run the binding against the [conformance catalog](/reference/#protocol--conformance).

The shared behavior of the native wrappers is on [Native client API](/native-client-api/); [Swift](/platform-swift/) and [Kotlin](/platform-kotlin/) are the wrappers to copy.
