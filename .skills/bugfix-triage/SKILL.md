---
name: bugfix-triage
description: Workflow for reproducing, fixing, and validating bugs/regressions in the Syncular framework with minimal diffs and a regression test.
metadata:
  short-description: Repro → regression test → fix
---

# Syncular Bugfix Triage

Use this skill when you’re asked to **fix a bug/regression** (sync correctness, transports, console, docs drift, etc.).

## Guardrails (always)

- Don’t edit unrelated diffs already present in `git diff`.
- No destructive git commands without explicit confirmation.
- No `as any` / `as unknown`; fix types properly.

## Step 1 — Reproduce (make it deterministic)

- Identify the smallest reproduction surface:
  - unit/integration test (preferred)
  - `demo` scenario (if it’s UX-driven)
  - integration test (if it spans multiple packages)
- Capture the expected vs actual behavior in 1–2 sentences.

## Step 2 — Localize the failure

Common entrypoints:
- Protocol/types: `packages/core/src/types.ts`
- Server push/pull: `packages/server/src/push.ts`, `packages/server/src/pull.ts`
- Client schema/outbox/conflicts: `packages/client/src/migrate.ts`, `packages/client/src/outbox.ts`, `packages/client/src/conflicts.ts`
- WS realtime: `packages/transport-ws/src/index.ts`, `packages/server-hono/src/ws.ts`
- Console UI: `console/src/*`

## Step 3 — Write/adjust a regression test

Prefer a test near the code you change:
- `packages/*/src/__tests__`
- `tests/*` (integration tests for cross-package bugs)

Keep the test minimal: one failing invariant, one fix.

## Step 4 — Fix at the root cause

Avoid papering over symptoms (especially around:
- idempotency caching
- scope key authorization enforcement
- cursor/bootstrap boundaries
- snapshot chunk decoding)

## Step 5 — Validate

- `bun test` (or the smallest targeted test first)
- `bun check:fix`
- If the bug impacts demo/console: smoke check locally (`bun --cwd demo dev`, `bun --cwd console dev`)
