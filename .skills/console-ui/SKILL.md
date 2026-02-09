---
name: console-ui
description: Workflow for improving or fixing the Syncular console UI (TanStack Router/Query + typed API via @syncular/transport-http) while staying aligned with OpenAPI.
metadata:
  short-description: Console UI changes (typed API, build, smoke)
---

# Console UI Workflow

Use this skill when asked to improve/fix the **console UI**.

## Guardrails

- Prefer using the typed client from `@syncular/transport-http` (generated from OpenAPI).
- If you change console-related server endpoints, run the OpenAPI/types workflow.
- Don’t edit unrelated diffs already present in `git diff`.

## Step 1 — Understand the API surface you’re consuming

Sources of truth:
- OpenAPI: `packages/server-hono/openapi.json`
- Typed client: `packages/transport-http/src/generated/api.ts`
- Transport helpers: `packages/transport-http/src/index.ts`

## Step 2 — Implement UI change

Console app code:
- `console/src/**`

Keep the UX change scoped and avoid reshaping server responses in the UI unless necessary.

## Step 3 — Validate

- Run: `bun --cwd console dev`
- Build check: `bun --cwd console build`
- Repo checks/tests when appropriate: `bun check:fix`, `bun test`
