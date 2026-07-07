# syncular-ffi — the Syncular Rust client as a shippable native core

The POC client crate (`syncular-client`), packaged for shipping. This crate
turns the clean-room Rust client into a native library with a small, stable
**C ABI** — the shape that binds to iOS (Swift), Android (Kotlin/JNI), the JVM,
and desktop hosts, and the substrate a React Native TurboModule wraps.

## The FFI surface (five functions)

The proven bindings shape: one constructor, one JSON-command dispatch, one
event poll, and two lifecycle/memory functions. The full C signatures live in
[`rust/ffi.h`](../../ffi.h) (hand-written, dependency-free, kept in sync by the
`header_matches_symbols` test):

```c
void*  syncular_client_new(const char* config_json);
char*  syncular_client_command(void* handle, const char* command_json);
char*  syncular_client_poll_event(void* handle, int64_t timeout_ms);
void   syncular_client_close(void* handle);
void   syncular_free_string(char* ptr);
```

- **`command`** takes `{"method": "...", "params": {...}}` and returns
  `{"result": ...}` or `{"error": {"code", "message"}}`. The method set is the
  **entire conformance command surface** — `create`, `subscribe`, `mutate`,
  `sync`, `syncUntilIdle`, `readRows`, `uploadBlob`/`fetchBlob`, `conflicts`,
  `subscriptionState`, `schemaFloor`, `leaseState`, `setPresence`/`presence`,
  `connectRealtime`, `recreateWithSchema`, … Bytes ride as
  `{"$bytes": "<hex>"}`, so a JSI/TurboModule bridge marshals plain JSON with
  zero custom serialization.
- **`poll_event`** drains client-observable events — `sync-needed`,
  `conflict`, `rejection`, `presence`, `schema-floor`, `lease` — with a
  timeout (`<0` blocks, `0` non-blocking, `>0` waits N ms). The client core has
  no callbacks; the FFI derives these events by diffing observable state after
  each command and after draining inbound realtime traffic, and enqueues them
  on a blocking queue the native WS reader thread also pushes into.

### One command surface, conformance-locked

The dispatch is **not** duplicated here. It lives in the shared
`syncular-command` crate, consumed by BOTH the stdio conformance shim and this
FFI crate. Whatever the shim exercises against the conformance catalog (68/68,
Rust client × TS server), the FFI core inherits — there is exactly one command
router, and it is the one under test.

## Transport ownership (why native is different)

The conformance shim **inverts** transport to the harness: the host holds the
`sync`/`downloadSegment`/`realtime` endpoints and the client calls back into
them. A native app has no such host loop — so this crate **owns** the network:

- **`native-transport` feature** (on for shipped builds): a real HTTP + WS
  transport the core drives itself. `ureq` for blocking HTTP (`POST /sync`,
  `GET /segments/{id}`, `PUT`/`GET /blobs/{id}`, bare signed-URL fetches) and
  `tungstenite` for the realtime socket, with a reader thread buffering inbound
  frames. Config: `{"baseUrl": "https://host/mount", "headers": {...}}`.
- **default (no feature)**: the dependency-lean build. Network commands fail
  loudly with `transport.unavailable`; client-local commands (create,
  subscribe, mutate, readRows, …) still run. This is the build the C smoke test
  and the pure-logic unit tests use — zero HTTP/WS/TLS compiled in.

### Sync rounds over the socket (§8.7) — complete

When the realtime socket is connected the core routes each combined push+pull
round through `realtime_sync`, which runs the round **over the socket** in the
one-loop shape (§8.7), not over `POST /sync`. The framing:

- The request goes out as a `0x01`-tagged binary message (channel tag +
  the whole SSP2 request envelope; a single chunk is legal since chunk
  boundaries are arbitrary and the request is bounded — bulk rides segments
  over HTTP, §5.7).
- The reader thread demuxes inbound binary frames by channel tag: `0x01`
  round chunks feed the in-flight round's `MessageStreamScanner`
  (reassembled to the response's `END`, then handed back to the blocked
  `realtime_sync`); `0x00` deltas are queued (tag stripped) to the inbound
  lane the command path applies like a pull (§8.2), tolerating a stray
  mid-round delta rather than failing. Bytes past `END` fail the round.
- One round in flight per connection is enforced client-side; a mid-round
  socket drop fails the round (never hangs). When no socket is connected
  the round rides `POST /sync` — the same not-connected rule as the TS
  client, not a fallback pair.

The transport-agnostic tag demux + reassembly lives in
`syncular_client::RealtimeRound` (unit-tested there and shared with the
Tauri plugin); the WS send/read plumbing is here. Proven end-to-end by the
`round_tests` module — a scripted in-test `tungstenite` server speaking §8.7
bytes built with the `ssp2` codec (round round-trip, byte-chunked response
reassembly, delta-during-round queuing, mid-round-drop failure).

### Dependency-policy justification

The task's rule is "leanest maintained pair, and it never ships to JS users."
`ureq` (minimal blocking HTTP over rustls, no async runtime) and `tungstenite`
(the de-facto minimal sync WebSocket — hand-rolling WS framing, masking, and
close handshakes is decidedly *not* minimal) are that pair. Both are widely
used and maintained, and the **synchronous/blocking** shape matches the
client's synchronous, host-driven API with **no executor** — no tokio, no
async surface. They are behind `native-transport` so the conformance and
dependency-lean builds stay transport-inverted and free of them. Measured
cost on macOS arm64 (release, stripped): **2.5 MB lean → 4.6 MB with native
transport** (the delta is rustls + ring + tungstenite + ureq); the bundled
SQLite dominates the lean baseline.

## Building the native artifacts

`rust/scripts/build-native.sh` builds every target whose toolchain exists on
the machine and **detects + skips** the rest (never fails the run), printing a
summary table with artifact sizes:

- **desktop** — the host cdylib (`.dylib`/`.so`/`.dll`) for JVM/desktop hosts.
- **apple** — macOS arm64 dylib always; iOS device (`aarch64-apple-ios`) and
  simulator (`aarch64-apple-ios-sim`) static archives assembled into
  `Syncular.xcframework` **when the iOS SDKs are locatable** (needs full Xcode;
  Command Line Tools alone build the mac slice only).
- **android** — `arm64-v8a` + `x86_64` `.so` via `cargo-ndk` (skipped with a
  message if `cargo-ndk`/NDK are absent).
- **cross** — linux/windows `.so`/`.dll` for JVM/desktop when the Rust cross
  targets + linkers are present.

Reuses hard-won packaging *knowledge* (which platforms/artifacts matter: apple
xcframework, android arm64+x86_64 jniLibs, linux/windows JVM libs) without any
`boltffi`/UniFFI machinery — the core is a hand-written C ABI, so packaging
is plain `cargo` + platform tools.

## C smoke test

`rust/ffi-smoke/run.sh` builds the dylib, compiles `ffi-smoke/main.c` against
it, and runs `new → command(create/subscribe/mutate/readRows/subscriptionState)
→ poll_event → close`, freeing every returned string — proving the ABI
end-to-end on this machine.

---

## §3.5 DECISION — Tauri / React Native

**Tauri uses the client crate DIRECTLY — no FFI.** A Tauri app is a Rust host;
it depends on `syncular-client` (or a thin `tauri-plugin-syncular` crate) as a
normal crate and calls `SyncClient` in-process, with the app owning the
transport exactly as the FFI's native lane does. There is no ABI boundary to
cross, so the FFI surface is unnecessary there. A dedicated Tauri plugin crate
(command handlers + a JS `@tauri-apps/api` shim) is a **post-done nicety**, not
a blocker — the command-JSON shape already maps onto Tauri's `invoke`.

**React Native uses the FFI surface via a JSI/TurboModule, over the NATIVE
core — not the TS core.** RN's JavaScript runtime (Hermes) lacks OPFS and
sqlite-wasm; the TS client's persistent path depends on both. The honest RN
path is therefore the **native core** in this crate — `rusqlite` on the real
device filesystem, HTTP+WS owned in Rust (`native-transport`) — bridged through
a TurboModule. The bridge is thin because the surface is already
JSON-command-shaped: `command_json` in, `{result|error}` JSON out, bytes as
`{"$bytes":hex}`, and `poll_event` feeding an RN event emitter. A NitroModules
/ JSI wrapper (zero-copy strings, a direct `poll_event` → JS event loop) is the
**follow-up** for latency; the C ABI here is the stable substrate underneath it.

**Kotlin/Swift idiomatic wrappers are post-done.** The command surface was
designed for them (one dispatch entry, JSON in/out); Swift `Codable` /
Kotlin `@Serializable` wrappers over the five functions are mechanical and can
land after the core ships.
