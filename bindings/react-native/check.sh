#!/usr/bin/env bash
# The gate for the React Native bindings package — isolated from the main
# workspaces (its tests are path-ignored from `bun run test`, and its .ts is not
# in the root tsconfig). Run from anywhere; it cds to its own dir.
#
# The verification bar (per ROADMAP block 1's honest RN scoping): the JS bridge
# is exercised with an INJECTED NativeModule double — no device, no RN runtime —
# proving the SyncClientLike contract, the {$bytes:hex} convention, event fanout,
# lifecycle, and parity vs the React `normalizeClient`. On top, the example
# app's REAL App.tsx is rendered (@testing-library/react) against a stateful
# NativeModule double, proving the @syncular-v2/react hooks drive the native
# client end-to-end (list renders + mutate flows through) — the hooks↔module
# integration proof, still no device (react-native primitives mocked to DOM tags
# by the bunfig preload). The TypeScript — module, spec, AND the example App —
# compiles. The iOS (.mm) / Android (.kt) native shims + the device build verify
# at a consuming app's build; their manual recipe is documented (README.md +
# example/README.md).
set -euo pipefail

cd "$(dirname "$0")"

# The example's schema (example/src/syncular.generated.ts) is REAL typegen
# output from example/syncular.json + migrations/ (mirroring apps/demo-react).
# Gate its freshness byte-exactly so a migration change without a regenerate
# fails loud.
echo "== generated schema is fresh (syncular-v2 generate --check) =="
( cd ../.. && bun packages/typegen/src/cli.ts generate \
    --manifest-dir bindings/react-native/example --check )
echo "ok: example/src/syncular.generated.ts is fresh"

echo "== bun test (JS bridge double + App integration render) =="
bun test

echo "== tsc --noEmit (module + spec + example App compile) =="
bunx tsc --noEmit

echo "OK: react-native bindings gate is green (bridge + App integration + tsc)"
echo "    note: iOS/Android native shims + the device build verify at a"
echo "    consuming app's build — see README.md + example/README.md."
