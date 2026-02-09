# Hero UI Migration Tracker

Last updated: 2026-02-08

## Objective

Consolidate all shared/generic UI into `packages/hero-ui` and make `console`, `demo`, and docs consume UI only through `@syncular/hero-ui`.

## Scope (Strict)

1. Shared components live in `packages/hero-ui` only.
2. App code (`console`, `demo`, docs app code) imports from `@syncular/hero-ui` only.
3. No app-local generic control implementations (buttons, tabs/segmented controls, inputs, selects, dialogs, tables).
4. Custom UI is allowed only for domain-specific visuals (topology/simulation/data renderers).
5. `packages/ui` is removed from the workspace.

## Current Status

### Package Migration

- [x] `packages/hero-ui` created and wired as workspace package.
- [x] Shared UI source moved into `packages/hero-ui/src`.
- [x] `packages/ui` removed from workspace and replaced by `packages/hero-ui` references.
- [x] App/package deps switched from `@syncular/ui` to `@syncular/hero-ui`.

### Consumer Migration

- [x] `console` imports switched to `@syncular/hero-ui`.
- [x] `demo` imports switched to `@syncular/hero-ui`.
- [x] docs app imports switched to `@syncular/hero-ui`.
- [x] docs/examples imports switched to `@syncular/hero-ui` package paths.
- [x] app CSS token/source imports switched to `packages/hero-ui`.

### Guardrails

- [x] `scripts/check-no-local-ui-duplicates.ts` enforces no app-local duplicate primitive folders.
- [x] `scripts/check-no-raw-controls.ts` enforces no raw `<button|input|select|textarea>` in app code.
- [x] `scripts/check-no-direct-ui-imports.ts` enforces no direct `@heroui/react`/`@base-ui/react` in app code.
- [x] Guardrails wired into `check` and `check:fix`.

### Validation

- [x] `bun tsgo`
- [x] `bun test`
- [x] `bun --cwd docs build`
- [x] `bun --cwd demo build`
- [x] Playwright smoke on demo + `/console/system`
- [ ] `bun check:fix` (currently blocked by pre-existing knip findings unrelated to this migration)

## Remaining Work

1. Continue replacing Base UI internals inside `packages/hero-ui` with Hero UI primitives where equivalents exist (`Button`, `Input`, `Select`, `Tabs`, etc.).
2. Keep custom wrappers only where Hero UI has no equivalent or does not cover required behavior.
3. After internal primitive migration, rerun full validation and update this tracker to 100% complete.
