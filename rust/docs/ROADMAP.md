# Rust Client Roadmap

This is the day-to-day roadmap for the Rust-first Syncular client. Update this
file after every retained work chunk.

Status legend:

- `[ ]` planned
- `[~]` in progress
- `[x]` accepted
- `[!]` blocked or needs decision

## Autonomous Work Loop

Every Rust-first work session should follow this loop unless the user asks for a
read-only review:

1. Record the active work package.
2. Check the change against
   [`CLIENT_PRODUCT_CONTRACT.md`](CLIENT_PRODUCT_CONTRACT.md).
3. If the change adds or preserves a fallback, alias, old protocol path, or
   legacy behavior, update
   [`COMPATIBILITY_REGISTER.md`](COMPATIBILITY_REGISTER.md) first.
4. Run or cite the accepted baseline.
5. Implement one scoped change.
6. Run the required tests.
7. Run the relevant benchmark gate.
8. Compare against the previous accepted result.
9. Keep, revise, or revert.
10. Update [`BENCHMARK_LOG.md`](BENCHMARK_LOG.md) and the work package.
11. Commit separately with the test and benchmark evidence.

## Session Start Checklist

1. Read this roadmap.
2. Read the active WP file.
3. Read the product-contract sections that apply to the WP.
4. Check [`COMPATIBILITY_REGISTER.md`](COMPATIBILITY_REGISTER.md) if the WP
   touches old protocol paths, fallbacks, aliases, or legacy JS behavior.
5. Read the relevant gate commands in [`QUALITY_GATES.md`](QUALITY_GATES.md).
6. If the work can affect performance, run or cite the latest accepted
   baseline before changing code.

## Session End Checklist

1. Run the required gates or state why a gate was not applicable.
2. For performance work, log previous/current/delta/decision in
   [`BENCHMARK_LOG.md`](BENCHMARK_LOG.md).
3. Update the active WP status, latest evidence, and next action.
4. Update [`COMPATIBILITY_REGISTER.md`](COMPATIBILITY_REGISTER.md) if a fallback
   or legacy path was added, retained, removed, or reclassified.
5. Update this roadmap if priority or status changed.
6. Commit the accepted slice. Do not leave retained work uncommitted unless the
   user explicitly asks to pause before commit.

## Accept / Reject Rules

- Correctness fixes may be retained with a measured regression, but the
  regression must be explicit in `BENCHMARK_LOG.md` and followed by a
  performance-recovery next action.
- Performance changes must improve the target metric or be reverted, unless
  they remove meaningful complexity without measurable regression.
- A local benchmark result is not enough if the change is expected to affect
  real app bootstrap, local-query, online-propagation, or reconnect behavior;
  run the external app-style benchmark listed in `QUALITY_GATES.md`.
- Do not optimize for full-partition happy paths when the product contract
  requires scoped/subscription-shaped access.
- Do not retain compatibility branches just because they exist. Prefer deletion
  unless the compatibility register records a current exception.

## Now

- `[~]` [`WP-01 Protocol Integrity`](work-packages/WP-01-protocol-integrity.md)
  - Reduce the verified-root performance overhead without weakening the
    correctness contract.
  - Next action: move pull integrity metadata toward page/subscription-level
    roots and compact binary metadata, then rerun targeted server perf and
    browser/offline-sync benchmarks.

## Next

- `[ ]` [`WP-02 Protocol Kernel`](work-packages/WP-02-protocol-kernel.md)
  - Extract the real Rust protocol crate before expanding binary v2.
- `[ ]` [`WP-03 Binary Apply Performance`](work-packages/WP-03-binary-apply-performance.md)
  - Continue generated direct-to-SQLite apply work under benchmark gates.
- `[ ]` [`WP-04 Realtime Runtime`](work-packages/WP-04-realtime-runtime.md)
  - Make websocket deltas the canonical fast path with verified replay,
    overflow recovery, and runtime-owned reconnect/backoff.

## Later

- `[ ]` [`WP-05 Adaptive Bootstrap`](work-packages/WP-05-adaptive-bootstrap.md)
- `[ ]` [`WP-06 Local Read Models`](work-packages/WP-06-local-read-models.md)
- `[ ]` [`WP-07 CRDT Fields`](work-packages/WP-07-crdt-fields.md)
- `[ ]` [`WP-08 Testkit And Conformance`](work-packages/WP-08-testkit-conformance.md)
- `[ ]` [`WP-09 Native Bindings And Packaging`](work-packages/WP-09-native-bindings-packaging.md)
- `[ ]` [`WP-10 Browser Package And Docs`](work-packages/WP-10-browser-package-docs.md)
- `[ ]` [`WP-11 Server Edge And Offline Auth`](work-packages/WP-11-server-edge-offline-auth.md)

## Blocked / External

- Windows native/JVM packaging needs a real Windows host or runner.
- Full iOS/macOS/Android lifecycle validation needs real app-shell coverage
  beyond command-line smokes.
- CI jobs are intentionally skipped until GitHub-side work is requested.

## Reference

Detailed background remains in [`reference/`](reference/). If a reference doc
changes the implementation order, update this roadmap and the affected work
package in the same commit.
