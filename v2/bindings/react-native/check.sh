#!/usr/bin/env bash
# The gate for the React Native bindings package — isolated from the main
# workspaces (its tests are path-ignored from `bun run test`, and its .ts is not
# in the root tsconfig). Run from anywhere; it cds to its own dir.
#
# The verification bar (per ROADMAP block 1's honest RN scoping): the JS bridge
# is exercised with an INJECTED NativeModule double — no device, no RN runtime —
# proving the SyncClientLike contract, the {$bytes:hex} convention, event fanout,
# lifecycle, and parity vs the React `normalizeClient`. The TypeScript compiles.
# The iOS (.mm) / Android (.kt) native shims are compile-checked only where a
# toolchain is cheaply available; otherwise their manual verification recipe is
# documented in README.md (an RN example app is explicitly OUT of scope).
set -euo pipefail

cd "$(dirname "$0")"

echo "== bun test (JS bridge, injected NativeModule double) =="
bun test

echo "== tsc --noEmit (TypeScript compiles) =="
bunx tsc --noEmit

echo "OK: react-native bindings gate is green (JS bridge + tsc)"
echo "    note: iOS/Android native shims verify at a consuming app's build —"
echo "    see README.md 'Verifying the native shims'."
