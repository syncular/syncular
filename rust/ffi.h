/*
 * syncular — C-ABI header for the Syncular v2 Rust client native core.
 *
 * Hand-written and dependency-free (no cbindgen). Kept EXACTLY in sync with
 * the seven #[no_mangle] extern "C" functions in crates/ffi/src/lib.rs — the
 * crate's `header_matches_symbols` test asserts this header's function set
 * equals the crate's exported symbols via `nm`, so drift fails the build.
 *
 * Usage: link libsyncular (.dylib/.so/.dll or the static archive) and:
 *
 *   void* h = syncular_client_new("{}");
 *   char* r = syncular_client_command(h, "{\"method\":\"create\",...}");
 *   // ... parse r as JSON ({"result":...} or {"error":{...}}) ...
 *   syncular_free_string(r);
 *   syncular_client_close(h);
 *
 * All strings are UTF-8, NUL-terminated. Strings RETURNED by the command /
 * poll functions are heap-owned by the library and MUST be released with
 * syncular_free_string (never free()). Bytes inside JSON ride as
 * {"$bytes":"<lowercase-hex>"}.
 *
 * Threading: the host serializes syncular_client_command calls; commands on
 * one handle never run concurrently. One pump thread may block in
 * syncular_client_poll_event while another thread issues commands. No thread
 * A header thread may block in syncular_client_poll_headers and answer with
 * syncular_client_provide_headers while a command waits for headers; neither
 * takes the core lock. syncular_client_close fails a command waiting for
 * headers with client.closed, returns NULL to a blocked
 * syncular_client_poll_headers, and waits for header calls in progress to
 * return; a header thread stops when its poll returns NULL. No other call
 * may enter the handle after close begins.
 */

#ifndef SYNCULAR_FFI_H
#define SYNCULAR_FFI_H

#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

/*
 * Create a client core. `config_json` is a JSON object:
 *   {}                              -> dependency-lean core (local commands)
 *   {"baseUrl":"https://host/mount", "wsUrl": "..."}
 *                                   -> native HTTP+WS transport
 *                                      (requires the `native-transport` build)
 * Returns an opaque handle, or NULL on a malformed config / unsupported
 * transport. A "headers" key is refused: the transport asks for headers
 * through syncular_client_poll_headers instead.
 */
void *syncular_client_new(const char *config_json);

/*
 * Run one JSON command against the client. `command_json` is
 * {"method":"...","params":{...}} — create/subscribe/mutate/sync/
 * syncUntilIdle/readRows/conflicts/units/setPresence/drainRealtime/...
 * (the full conformance command surface). Every command
 * applies the inbound realtime traffic buffered since the previous one.
 * Returns a heap-owned JSON string,
 * {"result":...} or {"error":{"code":...,"message":...}}, to free with
 * syncular_free_string. Returns NULL only on a NULL handle.
 */
char *syncular_client_command(void *handle, const char *command_json);

/*
 * Poll the next client-observable event, a JSON object with a "type":
 *   change          an exact revisioned observer batch
 *   sync-intent     a sync round the host should schedule
 *   presence        a presence fanout for one scope key; "error" carries
 *                   the server's code when it refused this client's publish
 *   scopes-changed  {"type":"scopes-changed"}: the server announced that
 *                   the actor's grants changed (SPEC §8.7). Run the app's
 *                   unit discovery; no sync state changed
 *   progress        the latest sync progress (only the newest is queued)
 *   diagnostics     a changed diagnostics snapshot
 *   realtime-wake   {"type":"realtime-wake"}: the socket reader buffered a
 *                   delta, a control frame, or a socket loss. Issue
 *                   {"method":"drainRealtime","params":{}} to apply it. One
 *                   wake stays outstanding until a command drains the buffer.
 * The queue is unbounded; while the host issues no command it gains at most
 * one realtime-wake. `timeout_ms`: <0 blocks until an event arrives, 0
 * returns immediately, >0 waits up to that many milliseconds. Returns a
 * heap-owned event JSON string to free with syncular_free_string, or NULL if
 * none arrived in time.
 */
char *syncular_client_poll_event(void *handle, int64_t timeout_ms);

/*
 * Poll the next header question: the transport needs request headers before
 * a host-authenticated HTTP request or realtime handshake, and that request
 * blocks until the question is answered. Returns a heap-owned
 *   {"requestId":n,"rejected":{name:value}|null,"clientId":"...",
 *    "round":n|null,"target":"sync"|"segment"|"blob"|"realtime"}
 * string to free with syncular_free_string. "rejected" carries the headers
 * the server just answered 401 to; the request is resent once with the
 * answer. "round" is the progress attempt of the sync round the request
 * belongs to, null outside a round; requests of one client and round share
 * one question. Each question is returned once, and not at all once its request
 * already failed past the 30 s bound. `timeout_ms` works as in
 * syncular_client_poll_event. Returns NULL on timeout and once
 * syncular_client_close has begun.
 */
char *syncular_client_poll_headers(void *handle, int64_t timeout_ms);

/*
 * Answer header question `request_id`. `headers_json` is a JSON object of
 * string values, or the JSON literal null (a NULL pointer counts as null)
 * when the host has no headers. Null headers, or no answer within 30 s, fail
 * the request with the retryable sync.auth_required (details.causeKind
 * "header_source"). An answer for an unknown or expired request_id is
 * ignored. Returns {"result":{}} or {"error":{"code":"sync.invalid_request",
 * ...}} for malformed JSON, to free with syncular_free_string; NULL only on a
 * NULL handle.
 */
char *syncular_client_provide_headers(void *handle, uint64_t request_id,
                                      const char *headers_json);

/*
 * Close a client core, releasing its database, transport, and socket thread.
 * The handle is invalid after this call; do not use or close it again.
 */
void syncular_client_close(void *handle);

/*
 * Free a string returned by syncular_client_command,
 * syncular_client_poll_event, syncular_client_poll_headers or
 * syncular_client_provide_headers. Free each returned string exactly once.
 */
void syncular_free_string(char *ptr);

#ifdef __cplusplus
} /* extern "C" */
#endif

#endif /* SYNCULAR_FFI_H */
