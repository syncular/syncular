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
- Live query setup: acceptable for React. The `@syncular/react` test now keeps
  happy-dom registration scoped to the test file so hook tests do not leak
  browser globals.
- Testkit setup: acceptable but split by host. JavaScript apps use
  `@syncular/testkit` request helpers; Rust apps use `syncular-testkit` app
  fixtures. The fresh-app guide and smoke script now exercise both names.
- Codegen config shape: still the largest blank-app friction for Rust-only
  projects. JavaScript apps can author `syncular.app.ts` and run
  `syncular generate`; Rust-only apps still author
  `generated/syncular.codegen.json` directly and run `syncular-codegen`.
- Generated Rust warnings: simple apps compile, but generated Rust can emit
  unused-import and unused-helper warnings when optional CRDT/encryption/history
  surfaces are not configured. This is not blocking, but it is noisy for a
  blank app.

## Retained Follow-Ups

- Consider a Rust-first `syncular-codegen init` command that writes a minimal
  `generated/syncular.codegen.json` from migrations.
- Consider shipping an npm-accessible `syncular-codegen` binary or documented
  installer path so `syncular generate` never fails because only the JavaScript
  packages are installed.
- Reduce generated Rust warning noise for simple app schemas without adding
  compatibility branches or optional runtime behavior.
- Keep the public docs stale-pattern gate small and app-facing. Historical work
  packages may keep old command text as record, but current docs should not.
