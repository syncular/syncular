/*
 * C smoke test for the Syncular v2 FFI native core.
 *
 * Proves the C ABI end-to-end against the real dylib/so: new -> command(create)
 * -> command(subscribe) -> command(readRows) -> command(units) -> close, with
 * every returned string freed through syncular_free_string. No server needed —
 * these are client-local commands (the default build has no native transport).
 *
 * Built + run by ffi-smoke/run.sh, which links the freshly-built library.
 */

#include <stdio.h>
#include <string.h>

#include "ffi.h"

static int failures = 0;

/* Assert a substring is present in a command reply, then free the reply. */
static void expect(const char *label, char *reply, const char *needle) {
  if (reply == NULL) {
    fprintf(stderr, "  FAIL %s: null reply\n", label);
    failures++;
    return;
  }
  if (strstr(reply, needle) == NULL) {
    fprintf(stderr, "  FAIL %s: expected %s in %s\n", label, needle, reply);
    failures++;
  } else {
    fprintf(stdout, "  ok   %s -> %s\n", label, reply);
  }
  syncular_free_string(reply);
}

int main(void) {
  fprintf(stdout, "syncular ffi C smoke:\n");

  void *client = syncular_client_new("{}");
  if (client == NULL) {
    fprintf(stderr, "  FAIL new: null handle\n");
    return 1;
  }
  fprintf(stdout, "  ok   new -> handle\n");

  const char *create =
      "{\"method\":\"create\",\"params\":{"
      "\"clientId\":\"c-smoke\",\"schema\":{\"version\":1,\"tables\":[{"
      "\"name\":\"todo\",\"primaryKey\":\"id\","
      "\"scopes\":[{\"pattern\":\"list:{list_id}\"}],\"columns\":["
      "{\"name\":\"id\",\"type\":\"string\",\"nullable\":false},"
      "{\"name\":\"list_id\",\"type\":\"string\",\"nullable\":false},"
      "{\"name\":\"title\",\"type\":\"string\",\"nullable\":false}]}]}}}";
  expect("create", syncular_client_command(client, create), "\"result\"");

  const char *subscribe =
      "{\"method\":\"subscribe\",\"params\":{\"scopes\":{\"list_id\":\"l1\"}}}";
  expect("subscribe", syncular_client_command(client, subscribe), "\"id\"");

  const char *mutate =
      "{\"method\":\"mutate\",\"params\":{\"mutations\":[{\"op\":\"upsert\","
      "\"table\":\"todo\",\"values\":{\"id\":\"t1\",\"list_id\":\"l1\","
      "\"title\":\"hello\"}}]}}";
  expect("mutate", syncular_client_command(client, mutate), "clientCommitId");

  const char *read =
      "{\"method\":\"readRows\",\"params\":{\"table\":\"todo\"}}";
  expect("readRows", syncular_client_command(client, read), "hello");

  /* status-equivalent: the registered unit's local state. */
  const char *units = "{\"method\":\"units\",\"params\":{}}";
  expect("units", syncular_client_command(client, units), "\"status\":\"active\"");

  /* The commands queued diagnostics, change and sync-intent events; drain
   * them, then a non-blocking poll with nothing queued returns NULL. */
  int events = 0;
  for (char *ev; (ev = syncular_client_poll_event(client, 0)) != NULL; events++)
    syncular_free_string(ev);
  if (events == 0) {
    fprintf(stderr, "  FAIL poll_event: expected queued events\n");
    failures++;
  } else {
    fprintf(stdout, "  ok   poll_event(0) drained %d events, then null\n", events);
  }

  syncular_client_close(client);
  fprintf(stdout, "  ok   close\n");

  if (failures > 0) {
    fprintf(stderr, "smoke FAILED with %d failure(s)\n", failures);
    return 1;
  }
  fprintf(stdout, "smoke PASSED\n");
  return 0;
}
