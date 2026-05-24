# WP-37 Rust Crates Publishing

Status: `[~]` in progress

## Goal

Publish the Rust-first Syncular crates to crates.io with clean manifests,
non-demo default features, versioned internal dependencies, and a reserved
canonical `syncular` crate.

## Scope

- Make `syncular-protocol`, `syncular-runtime`, `syncular-codegen`,
  `syncular-client`, `syncular-testkit`, and `syncular` publishable.
- Keep demo fixtures out of public default feature sets.
- Publish in dependency order only after `cargo publish --dry-run` succeeds.
- Publish `syncular` as a tiny legitimate reservation crate first; once the
  lower-level SDK crates are live, a later version can become the re-export
  umbrella.

## Gates

```bash
cargo fmt --manifest-path rust/Cargo.toml --all -- --check
cargo publish --manifest-path rust/crates/protocol/Cargo.toml --dry-run
cargo publish --manifest-path rust/crates/runtime/Cargo.toml --dry-run
cargo publish --manifest-path rust/crates/codegen/Cargo.toml --dry-run
cargo publish --manifest-path rust/crates/client/Cargo.toml --dry-run
cargo publish --manifest-path rust/crates/testkit/Cargo.toml --dry-run
cargo publish --manifest-path rust/crates/syncular/Cargo.toml --dry-run
```

## Publish Order

1. `syncular` can be published independently to reserve the name.
2. `syncular-protocol`
3. `syncular-codegen`
4. `syncular-runtime`
5. `syncular-testkit`
6. `syncular-client`

## Progress

- Added crates.io package metadata to the existing Rust crates.
- Removed demo todo fixtures from runtime/client default features.
- Added versioned path dependencies for internal crates.
- Added the `syncular` crate as a tiny legitimate reservation package.

## Evidence

- `cargo fmt --manifest-path rust/Cargo.toml --all -- --check`: passed.
- `cargo check --manifest-path rust/Cargo.toml -p syncular-protocol`: passed.
- `cargo check --manifest-path rust/Cargo.toml -p syncular-runtime`: passed.
- `cargo check --manifest-path rust/Cargo.toml -p syncular-client`: passed.
- `cargo check --manifest-path rust/Cargo.toml -p syncular-client --features cli`:
  passed.
- `cargo check --manifest-path rust/Cargo.toml -p syncular-codegen`: passed.
- `cargo check --manifest-path rust/Cargo.toml -p syncular-testkit`: passed.
- `cargo check --manifest-path rust/Cargo.toml -p syncular`: passed.
- `cargo publish --manifest-path rust/crates/protocol/Cargo.toml --dry-run --allow-dirty`:
  passed.
- `cargo publish --manifest-path rust/crates/codegen/Cargo.toml --dry-run --allow-dirty`:
  passed.
- `cargo publish --manifest-path rust/crates/syncular/Cargo.toml --dry-run --allow-dirty`:
  passed.

## Blocker

Actual crates.io publish is blocked by account setup:

```text
A verified email address is required to publish crates to crates.io.
```

The upload attempt that hit this was:

```bash
cargo publish --manifest-path rust/crates/protocol/Cargo.toml --allow-dirty
```

After the crates.io account email is verified, publish `syncular` immediately to
reserve the name, then publish `syncular-protocol`/`syncular-codegen` and
continue the dependency chain.
