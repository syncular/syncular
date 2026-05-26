# WP-48 CI And Apex Publish Recovery

Status: `[x]` accepted

## Goal

Restore the Rust-first mainline CI gates and publish the current Rust-owned
landing surface to the public apex site.

## Scope

- Install the WASM toolchain required by package builds before shared CI setup
  runs `bun run build`.
- Keep native FFI tests aligned with the generated todo app contract for
  encrypted fields and blob declarations.
- Make the runtime library target explicit for native package tooling on
  Windows.
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

## Decision

Accepted. The shared CI setup now installs Rust, `wasm-pack`, and `wasm-opt`
before package builds. Native FFI tests match the generated Rust app contract,
and the runtime library target is explicit for native packaging tooling. Apex
publish verification remains a deployment step after the accepted commit lands
on `main`.
