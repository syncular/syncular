---
name: feature-workflow
description: Workflow for adding/refactoring Syncular framework features across core/server/client/transports, including propagation, validation, and docs/demo/console touchpoints.
metadata:
  short-description: Add/refactor framework features
---

# Feature workflow (Syncular)

Use this skill when implementing a **new framework feature** or refactoring an existing capability (not app code).

## Guardrails (always)

- Don’t edit unrelated diffs already present in `git diff`.
- No destructive git commands without explicit confirmation.
- No `as any` / `as unknown`; fix types properly.
- Prefer barrel exports via `export * from './file'`.

## Step 1 — Classify the change (drives propagation)

- **Protocol / types changed** (`packages/core/*`)
  - Update server/client/transports usage.
  - Update docs snippets that mention fields/types.
  - Add/adjust tests covering the new invariant.
- **Server engine changed** (`packages/server/*`)
  - Check push/pull invariants (idempotency, scope key enforcement, ordering).
  - Update docs + demo if behavior/usage changed.
- **Client engine changed** (`packages/client/*`, `packages/client-react/*`)
  - Ensure schema/migrations remain compatible.
  - Update docs SDK pages + demo usage.
- **HTTP surface changed** (`packages/server-hono/*`)
  - Regenerate OpenAPI + TS types (`bun generate:openapi`).
  - Check console UI and docs API pages.
- **Transport changed** (`packages/transport-*/*`)
  - Re-validate auth assumptions (WS headers vs query/cookies).
  - Check console + demo + docs usage.

## Step 2 — Add the smallest test that proves the feature

- Prefer adding/adjusting a test close to the change:
  - core: `packages/core/src/__tests__`
  - server: `packages/server/src/__tests__`
  - client: `packages/client/src/__tests__`
  - react: `packages/client-react/src/__tests__`
  - integration: `tests/integration/` (when the behavior spans packages)

## Step 3 — Update docs/demo/console (only if public behavior changed)

- Docs: `docs/content/docs/**`
- Demo: `demo/src/**`
- Console: `console/src/**`

Rule of thumb: if a user of the framework would notice the change, docs/demo must change too.

## Step 4 — Validate

- `bun check:fix`
- `bun test`
- Smoke check demo: `bun --cwd demo dev`

If you changed docs or UI apps:
- Docs build: `bun --cwd docs build`
- Console build: `bun --cwd console build`
