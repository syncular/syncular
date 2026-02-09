---
name: openapi-refresh
description: Workflow for changing server-hono HTTP/console routes and keeping OpenAPI, generated TypeScript types, docs API pages, and the console UI in sync.
metadata:
  short-description: Routes → OpenAPI → generated types → docs/console
---

# OpenAPI + Generated Types Workflow

Use this skill when changing **`@syncular/server-hono` routes**, console endpoints, or anything that affects the HTTP surface.

## Guardrails (always)

- Don’t edit unrelated diffs already present in `git diff`.
- No destructive git commands without explicit confirmation.

## Step 1 — Make the route change

- Update route definitions in `packages/server-hono/src/**`.
- If the change affects request/response types, confirm protocol types in `packages/core/src/types.ts`.

## Step 2 — Regenerate OpenAPI + transport types

From repo root:

- `bun generate:openapi`

This runs:
- `bun --cwd packages/server-hono generate:openapi` (updates `packages/server-hono/openapi.json`)
- `bun --cwd packages/transport-http generate-types` (updates `packages/transport-http/src/generated/api.ts`)

## Step 3 — Wire up consumers

- Update `packages/transport-http/src/index.ts` usage if paths changed.
- Update console UI (`console/src/**`) if it calls the changed endpoints.
- Update docs API nav if you added/removed pages: `docs/content/docs/api/meta.json`

## Step 4 — Validate

- `bun check:fix`
- `bun test`
- If relevant: `bun --cwd console build`
- If docs reference new endpoints: `bun --cwd docs build`
