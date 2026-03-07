# Launch Readiness

This file tracks the last DX and launch-quality issues found during the final pre-launch review.

## In Flight

- [x] Make high-level mutation APIs consistent about optimistic concurrency defaults.
- [x] Stop requiring developers to manually discover the incrementing version plugin for common client paths.
- [x] Fix docs that overstated what the incrementing version plugin does.
- [x] Clarify that the published CLI exists, but its source currently lives in the sibling `syncular-spaces/` repo.
- [x] Re-run and refresh performance baselines before calling the release launch-ready.

## Notes

### Versioning and conflict ergonomics

- `useMutations()` already auto-read `server_version` when `baseVersion` was omitted.
- `useMutation()` now follows the same default behavior.
- High-level stateful client paths now include the incrementing version plugin by default.
- The incrementing version plugin does not read local rows or enable conflict detection by itself.
- Its actual job is to prevent self-conflicts when the same client pushes multiple versioned writes to the same row in sequence.

### CLI provenance

- The CLI is published as `@syncular/cli`.
- Its source is currently maintained in the sibling `syncular-spaces/` repository.
- Docs in this repo should describe that explicitly so readers do not assume the CLI implementation is checked in here.

### Remaining launch gate

- Functional correctness and docs/app builds are strong.
- The raw transport catchup benchmark in `tests/perf/sync.perf.test.ts` needed an explicit timeout because Bun's default 5s per-test cap was too low for that benchmark.
- Perf runs now install a silent telemetry backend so the sync lane measures sync work instead of optional console logging overhead.
- Regression detection now ignores sub-millisecond absolute deltas that are below the noise floor of local runs.
- The sync baseline was refreshed from the current stable local run shape after the telemetry change.
- `bun --cwd tests/perf stable-ci` is green again on this machine after the harness and baseline refresh.
