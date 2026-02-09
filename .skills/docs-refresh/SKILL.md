---
name: docs-refresh
description: Workflow for updating Syncular docs/README and keeping docs aligned with current APIs, examples, and OpenAPI.
metadata:
  short-description: Docs refresh
---

# Docs refresh workflow

Use this skill when asked to improve docs, fix doc drift, or update README/docs after code changes.

## Guardrails

- Docs must match the repo’s current APIs (no invented identifiers).
- Keep README + docs site consistent for public-facing usage.
- Don’t edit unrelated diffs already present in `git diff`.

## Step 1 — Identify the source of truth

- Protocol/types: `packages/core/src/types.ts`
- Server behavior: `packages/server/src/push.ts`, `packages/server/src/pull.ts`
- HTTP surface: `packages/server-hono/openapi.json`
- Docs content: `docs/content/docs/**`
- README: `README.md`

## Step 2 — Make the docs change

- Prefer small, explicit pages over long “kitchen sink” pages.
- If you change public API behavior, update:
  - the relevant docs page(s)
  - README (if it changes the quick start / positioning)
  - demo (if it’s the canonical runnable example)

## Step 3 — Validate

- Docs site: `bun --cwd docs build` (or `bun --cwd docs dev` for manual review)
- Repo checks/tests: `bun check:fix`, `bun test` (as appropriate)
