# WP-48 CI And Apex Publish Recovery

Status: `[x]` accepted

## Goal

Restore the Rust-first mainline CI gates and publish the current Rust-owned
landing surface to the public apex site.

## Scope

- Install the WASM toolchain required by package builds before shared CI setup
  runs `bun run build`.
- Keep optional WASM size attribution tools from failing package builds when
  they are absent from CI runners.
- Keep native FFI tests aligned with the generated todo app contract for
  encrypted fields and blob declarations.
- Make the runtime library target and package selection explicit for native
  package tooling on Windows.
- Generate the ignored OpenAPI spec before docs typechecking imports it.
- Remove the always-on `integration-load` workflow job that still invoked the
  deleted legacy TypeScript `test:load` entrypoint.
- Refresh vulnerable dependency pins and overrides that gate `bun check`.
- Rebuild and deploy the apex site against `syncular/syncular@main`.

## Non-Goals

- Do not add protocol compatibility branches or JS-client fallback behavior.
- Do not alter landing component APIs.
- Do not change unrelated Spaces control-plane/runtime behavior.

## Evidence

- Baseline: GitHub Checks on `syncular/syncular@8d61200b` failed because
  shared setup lacked `wasm-pack`, browser WASM setup lacked `wasm-opt`, native
  FFI tests asserted stale generated-app metadata, and Windows JVM packaging
  could not resolve the runtime library target.
- Follow-up baseline: GitHub Checks on `syncular/syncular@16359689` reached
  WASM builds but failed because missing optional `wasm-tools` crashed the size
  reporter before it could write a skipped-tool line; Windows JVM packaging
  still selected the workspace wrapper package when BoltFFI path
  canonicalization missed the runtime manifest on Windows.
- Follow-up baseline: GitHub Checks on `syncular/syncular@e45cb6eb` passed the
  Rust packaging/WASM gates but failed `test` because `syncular-docs` imported
  ignored `apps/docs/openapi.json` before generation, and failed
  `integration-load` because the workflow still invoked the removed legacy
  `test:load` script.
- Local check: current k6 load scenarios require a separate Rust-first binary
  sync-pack/snapshot chunk harness update; they are not used as the always-on
  CI replacement in this recovery slice.
- `bun --cwd apps/docs tsgo`
- `bunx actionlint -no-color -ignore 'label "blacksmith-4vcpu-ubuntu-2404" is unknown' -ignore 'constant expression "false"' -ignore 'shellcheck reported issue' .github/workflows/checks.yml`
- `bun audit`
- `bun check`
- `bun run test:coverage`
- `cargo test --manifest-path rust/Cargo.toml -p syncular-runtime --test native_ffi`
- `cargo metadata --manifest-path rust/crates/runtime/Cargo.toml --no-deps --format-version 1`
  reports `syncular_runtime` with `rlib`, `staticlib`, and `cdylib` crate
  types.
- `wasm-pack --version && wasm-opt --version`
- `bun --cwd rust/bindings/javascript build:wasm:dev`
- `bun run build`
- `bun run rust:ci:native`
- `bunx actionlint -no-color -ignore 'label "blacksmith-4vcpu-ubuntu-2404" is unknown' -ignore 'constant expression "false"' -ignore 'shellcheck reported issue' .github/workflows/checks.yml`
- `ruby -ryaml -e 'YAML.load_file(ARGV.fetch(0)); puts "ok"' .github/actions/setup-environment/action.yml`
- `bun run --cwd rust/bindings/javascript tsgo`
- `bun run --cwd rust/bindings/javascript build:wasm`
- `env PATH="/Users/bkniffler/.volta/bin:/usr/bin:/bin" bun scripts/size-syncular-wasm.ts --wasm dist/wasm/syncular_bg.wasm --check --report /tmp/syncular-wasm-size-missing-tools.txt`
- `bash -n rust/scripts/package-native-bindings.sh`
- `cargo build --manifest-path rust/crates/runtime/Cargo.toml -p syncular-runtime -p syncular-runtime --lib --no-default-features`

## Decision

Accepted. The shared CI setup now installs Rust, `wasm-pack`, and `wasm-opt`
before package builds. Native FFI tests match the generated Rust app contract,
optional WASM size attribution tools are skipped when absent, and native
packaging passes the runtime package explicitly so BoltFFI cannot select the
workspace wrapper crate. Docs typecheck now prepares OpenAPI from current Hono
routes before importing the ignored JSON artifact, and the always-on
`integration-load` job was removed because its only command targeted the
deleted legacy TypeScript load entrypoint. Dependency overrides and direct docs
tooling pins were refreshed so `bun audit` reports no vulnerabilities and the
full `bun check` gate can complete. Apex publish verification remains a
deployment step after the accepted commit lands on `main`.
