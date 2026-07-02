# rust/vendor

Vendored crates consumed via `[patch.crates-io]` in `rust/Cargo.toml`.

## sqlite-wasm-rs-0.5.3-syncular

A vendored copy of [`sqlite-wasm-rs` 0.5.3](https://crates.io/crates/sqlite-wasm-rs)
(the `wasm32-unknown-unknown` SQLite bindings used by `syncular-runtime`'s
browser build), patched locally.

### Why it is vendored

1. **Trimmed SQLite compile flags.** Upstream builds a fairly full SQLite
   (RTREE, SESSION, DBSTAT/DBPAGE/BYTECODE vtabs, math functions, preupdate
   hook, column metadata, ...). Syncular's browser SQL contract does not
   include those, so `build.rs` keeps FTS5 and the base WASM/runtime flags
   and drops the rest — a meaningful `.wasm` size win. Full analysis and
   measurements: `rust/docs/reference/BROWSER_WASM_SIZE_ANALYSIS.md`.
2. **Registry independence.** A path dependency keeps CI builds immune to
   crates.io download flakiness for this large crate.

### Local changes vs upstream 0.5.3

- `build.rs`: `FULL_FEATURED` trimmed from upstream's 23 flags to 10
  (kept: `SQLITE_OS_OTHER`, `SQLITE_USE_URI`, `SQLITE_THREADSAFE=0`,
  `SQLITE_TEMP_STORE=2`, `SQLITE_DEFAULT_CACHE_SIZE=-16384`,
  `SQLITE_DEFAULT_PAGE_SIZE=8192`, `SQLITE_OMIT_DEPRECATED`,
  `SQLITE_OMIT_LOAD_EXTENSION`, `SQLITE_OMIT_SHARED_CACHE`,
  `SQLITE_ENABLE_FTS5`; dropped: `UNLOCK_NOTIFY`, `API_ARMOR`,
  `BYTECODE_VTAB`, `DBPAGE_VTAB`, `DBSTAT_VTAB`, `MATH_FUNCTIONS`,
  `OFFSET_SQL_FUNC`, `PREUPDATE_HOOK`, `RTREE`, `SESSION`, `STMTVTAB`,
  `UNKNOWN_SQL_FUNCTION`, `COLUMN_METADATA`).
- The never-enabled `sqlite3mc` (SQLite3MultipleCiphers encryption) feature
  and its ~382k-line amalgamation were removed entirely: `sqlite3mc/`,
  `src/bindings/sqlite3mc_bindgen.rs`, the `[features] sqlite3mc` entry, and
  the `#[cfg(feature = "sqlite3mc")]` plumbing in `build.rs` and
  `src/bindings/mod.rs`. No Syncular crate ever enabled it. If encryption is
  ever needed, re-vendor from upstream and re-add the feature instead of
  resurrecting the deleted files.
- Registry-packaging metadata (`Cargo.lock`, `Cargo.toml.orig`,
  `.cargo_vcs_info.json`) is not kept.
- `src/bindings/sqlite3_bindgen.rs` is upstream's committed bindgen output,
  unchanged: the trimmed flags only remove compiled features, not
  declarations, so the bindings did not need regeneration.

### How to re-vendor (e.g. for a new upstream version)

1. Download and unpack the published crate archive (this copy was made from
   the crates.io package, not the git repo):

   ```sh
   curl -sL -o sqlite-wasm-rs-<ver>.crate \
     "https://static.crates.io/crates/sqlite-wasm-rs/sqlite-wasm-rs-<ver>.crate"
   tar xzf sqlite-wasm-rs-<ver>.crate
   ```

2. Delete `Cargo.lock`, `Cargo.toml.orig`, and `.cargo_vcs_info.json` from
   the unpacked directory.
3. Re-apply the local changes above: diff the new upstream `build.rs` against
   this copy's, port the `FULL_FEATURED` trim, and re-do the `sqlite3mc`
   removal (files, `include` globs and `[features]` in `Cargo.toml`, `cfg`
   plumbing).
4. Rename the directory to `sqlite-wasm-rs-<ver>-syncular`, update the
   `[patch.crates-io]` path in `rust/Cargo.toml`, and refresh
   `rust/Cargo.lock` (`cargo update -p sqlite-wasm-rs`).
5. Verify: `cargo check --manifest-path rust/Cargo.toml --workspace`,
   `bun run build:rust`, and the WASM size gate
   (`bun --cwd packages/client size:wasm:check`) — re-baseline
   `.context/wasm-size/` reports only if a size change is expected.

### Caveat: the patch does not reach published-crate consumers

`[patch.crates-io]` only applies to builds **inside this workspace**. Anyone
depending on the published `syncular-runtime` crate from crates.io gets the
unpatched upstream `sqlite-wasm-rs` with the full flag set (bigger `.wasm`,
no behavioral difference in Syncular's supported SQL surface). Syncular's own
published JS artifacts are unaffected: the `@syncular/client` WASM binaries
are built in-repo, where the patch is active.
