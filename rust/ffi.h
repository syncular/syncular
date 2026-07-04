/*
 * syncular — C-ABI header for the Syncular v2 Rust client native core.
 *
 * Hand-written and dependency-free (no cbindgen). Kept EXACTLY in sync with
 * the five #[no_mangle] extern "C" functions in crates/ffi/src/lib.rs — the
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
 *   {"baseUrl":"https://host/mount", "headers": {...}, "wsUrl": "..."}
 *                                   -> native HTTP+WS transport
 *                                      (requires the `native-transport` build)
 * Returns an opaque handle, or NULL on a malformed config / unsupported
 * transport. Thread-affine: drive one handle from one thread.
 */
void *syncular_client_new(const char *config_json);

/*
 * Run one JSON command against the client. `command_json` is
 * {"method":"...","params":{...}} — create/subscribe/mutate/sync/
 * syncUntilIdle/readRows/conflicts/subscriptionState/setPresence/... (the
 * full conformance command surface). Returns a heap-owned JSON string,
 * {"result":...} or {"error":{"code":...,"message":...}}, to free with
 * syncular_free_string. Returns NULL only on a NULL handle.
 */
char *syncular_client_command(void *handle, const char *command_json);

/*
 * Poll the next client-observable event (sync-needed / conflict / rejection /
 * presence / schema-floor / lease). `timeout_ms`: <0 blocks until an event
 * arrives, 0 returns immediately, >0 waits up to that many milliseconds.
 * Returns a heap-owned event JSON string to free with syncular_free_string,
 * or NULL if none arrived in time.
 */
char *syncular_client_poll_event(void *handle, int64_t timeout_ms);

/*
 * Close a client core, releasing its database, transport, and socket thread.
 * The handle is invalid after this call; do not use or close it again.
 */
void syncular_client_close(void *handle);

/*
 * Free a string returned by syncular_client_command or
 * syncular_client_poll_event. Free each returned string exactly once.
 */
void syncular_free_string(char *ptr);

#ifdef __cplusplus
} /* extern "C" */
#endif

#endif /* SYNCULAR_FFI_H */
