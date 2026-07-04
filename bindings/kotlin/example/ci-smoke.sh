#!/usr/bin/env bash
# CI smoke for the Kotlin todo example: prove the wrapper drives a real app that
# SYNCS to a real server. Builds the native-transport dylib, starts the
# quickstart server, runs the example with scripted stdin (add → sync → an
# independent verify), and asserts the todo landed on the server.
#
# This is the full native-transport-to-real-server proof for Kotlin. It is
# deterministic under piped stdin. Requires: a JDK 21+ + Gradle (the CI job
# provisions them), bun (for the quickstart server), and the rust toolchain.
# Run from the kotlin bindings dir's example/ (the workflow cds here) or invoke
# with an absolute path; it cds to its own dir.
set -euo pipefail

cd "$(dirname "$0")"
EXAMPLE_DIR="$(pwd)"
KOTLIN_DIR="$(cd .. && pwd)"
V2_DIR="$(cd ../../.. && pwd)"
RUST_DIR="${V2_DIR}/rust"
QUICKSTART_DIR="${V2_DIR}/examples/quickstart"

GRADLE_CMD=""
if [ -x "${KOTLIN_DIR}/gradlew" ]; then GRADLE_CMD="${KOTLIN_DIR}/gradlew"
elif command -v gradle >/dev/null 2>&1; then GRADLE_CMD="gradle"
else echo "SKIP: no Gradle for the Kotlin example smoke."; exit 0; fi

# 1. Build the NATIVE-TRANSPORT dylib and vendor it (the example syncs, so it
#    needs transport — unlike the wrapper's offline hermetic test).
echo "== build libsyncular (native-transport) =="
( cd "${RUST_DIR}" && cargo build -p syncular-ffi --features native-transport )
case "$(uname -s)" in
  Darwin) LIB="libsyncular.dylib" ;;
  Linux)  LIB="libsyncular.so" ;;
  *)      LIB="libsyncular.so" ;;
esac
mkdir -p "${KOTLIN_DIR}/vendor"
cp "${RUST_DIR}/target/debug/${LIB}" "${KOTLIN_DIR}/vendor/${LIB}"
echo "ok: vendored native-transport ${LIB}"

# 2. Start the quickstart server in the background.
PORT="${SMOKE_PORT:-8791}"
echo "== start quickstart server on :${PORT} =="
( cd "${QUICKSTART_DIR}" && PORT="${PORT}" bun run src/server.ts ) &
SERVER_PID=$!
cleanup() { kill "${SERVER_PID}" 2>/dev/null || true; }
trap cleanup EXIT

# Wait for the server to accept connections (a 415 to a bad content-type means
# the /sync route is live — that is a positive readiness signal).
for i in $(seq 1 30); do
  code="$(curl -s -o /dev/null -w '%{http_code}' -X POST "http://localhost:${PORT}/sync" \
          -H 'content-type: application/json' -d '{}' 2>/dev/null || true)"
  if [ "${code}" = "415" ] || [ "${code}" = "200" ] || [ "${code}" = "401" ]; then
    echo "ok: server up (probe HTTP ${code})"; break
  fi
  if [ "$i" = "30" ]; then echo "ERROR: server did not come up" >&2; exit 1; fi
  sleep 1
done

# 3. Run the example with scripted stdin against the server.
STAMP="$(date +%s)"
TITLE="ci-smoke-${STAMP}"
echo "== run the Kotlin todo example (scripted) =="
OUT="$(printf 'add %s\npending\nsync\npending\nlist\nquit\n' "${TITLE}" | \
  SYNCULAR_URL="http://localhost:${PORT}" SYNCULAR_CLIENT_ID="kotlin-smoke-${STAMP}" \
  "${GRADLE_CMD}" --no-daemon -q ":example:run" 2>&1)"
echo "----- example output -----"
echo "${OUT}"
echo "--------------------------"

# 4. Assert the interface worked: added, pushed, drained, and the row lists.
echo "${OUT}" | grep -q "added .*${TITLE}" || { echo "FAIL: add not reflected" >&2; exit 1; }
echo "${OUT}" | grep -q "^synced$"          || { echo "FAIL: sync did not report success" >&2; exit 1; }
echo "${OUT}" | grep -q "pending: 0"         || { echo "FAIL: outbox did not drain after sync" >&2; exit 1; }
echo "${OUT}" | grep -q "${TITLE}"           || { echo "FAIL: todo not in the list" >&2; exit 1; }

# 5. Independent server-side verify: a fresh quickstart web-client syncs and
#    reads the SAME row back — the row truly reached the server, not just the
#    local outbox. This is the prize: native-transport → real server → JS client.
echo "== independent verify (quickstart web-client reads it back) =="
VERIFY="$(cd "${QUICKSTART_DIR}" && SMOKE_TITLE="${TITLE}" SMOKE_URL="http://localhost:${PORT}" \
  bun run - <<'TS'
import { makeClient } from './src/make-client';
const b = makeClient(process.env.SMOKE_URL!, 'kotlin-smoke-verify-' + Date.now());
await b.start();
b.subscribe({ id: 'notes', table: 'notes', scopes: { list_id: ['welcome'] } });
await b.syncUntilIdle();
const rows = b.query('SELECT body FROM notes');
const hit = rows.some((r: any) => String(r.body).includes(process.env.SMOKE_TITLE!));
console.log(hit ? 'VERIFY_OK' : 'VERIFY_MISS');
for (const r of rows) console.log('  server row:', r.body);
await b.close();
process.exit(hit ? 0 : 1);
TS
)"
echo "${VERIFY}"
echo "${VERIFY}" | grep -q "VERIFY_OK" || { echo "FAIL: server did not have the synced row" >&2; exit 1; }

echo "OK: kotlin example smoke green — todo synced to a real server and read back"
