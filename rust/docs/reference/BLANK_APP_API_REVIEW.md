# Blank App API Review

Date: 2026-05-26

Scope: fresh JavaScript and Rust apps using the Rust-first client runtime,
generated app contract, local codegen, and testkit smoke path.

## Current Findings

- Generated handler imports: acceptable for new apps. Server setup still asks
  developers to understand `createSyncServer`, app handlers, auth, and dialects
  separately; this is necessary, but the fresh-app guide now links directly to
  the canonical server page instead of duplicating a large partial setup.
- Generated mutation names: acceptable. The app-facing TypeScript and React
  surfaces use table-shaped `insert`, `update`, and `delete` helpers rather than
  protocol-level operation names.
- Live query setup: acceptable for React. The `@syncular/client/react` test now keeps
  happy-dom registration scoped to the test file so hook tests do not leak
  browser globals.
- Testkit setup: acceptable but split by host. JavaScript apps use
  `@syncular/testkit` request helpers; Rust apps use `syncular-testkit` app
  fixtures. The fresh-app guide and smoke script now exercise both names.
- Codegen config shape: improved for Rust-only projects. JavaScript apps can
  author `syncular.app.ts` and run `syncular generate`; Rust-only apps can now
  run `syncular-codegen init` to create a starter
  `generated/syncular.codegen.json` from migrations before generation. The npm
  CLI now resolves or installs the Rust generator through
  `syncular codegen install`, so JS apps no longer need to know the direct
  `syncular-codegen` setup path first.
- Generated Rust warnings: improved. The generated Rust facade now suppresses
  local unused-helper/import warnings so blank apps do not see warning noise
  just because optional CRDT/encryption/history surfaces are not configured.

## Retained Follow-Ups

- Consider platform-specific npm binary packages for `syncular-codegen` if the
  Cargo-backed installer becomes too slow or too much setup for JS-only teams.
- Keep the public docs stale-pattern gate small and app-facing. Historical work
  packages may keep old command text as record, but current docs should not.
