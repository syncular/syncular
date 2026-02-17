# Repo Instructions (Agents / LLMs)

Syncular is a Bun workspaces monorepo that implements an offline-first sync framework (server + client + transports) plus a demo, docs site, and console UI.

## Quick Commands

- Repo checks (types/lint/knip): `bun check:fix`
- Tests: `bun test`
- Demo (smoke test manually in browser): `bun --cwd apps/demo dev`
- Docs site: `bun --cwd apps/docs dev` (build: `bun --cwd apps/docs build`)
- Console UI: `bun --cwd apps/console dev` (build: `bun --cwd apps/console build`)
- OpenAPI + generated TS types: `bun generate:openapi`

## Non‑Negotiables

- If `git diff` contains changes you didn’t make: **do not edit them**; ignore their fallout in tool output.
- **No destructive git commands** (`reset`, `clean`, `checkout -f`, `rebase`, etc.) without explicit user confirmation.
- Never cast to `any` or `unknown`. Fix typing properly.
- Avoid unnecessary type casts/annotations; rely on inference.
- Barrel exports: prefer `export * from './file'` (avoid `export { A, B } from './file'`).
- Dependency installation: ALWAYS use the latest version if you add new dependencies by running "bun install *packagename*", never edit the package into package.json dependencies manually
- Don't keep backward compatibility when working on new code, we are in alpha, we may (and want to) break anything to be able to move fast

## Repo Map

- Protocol + shared utilities: `packages/core`
- Server engine (push/pull, pruning, snapshot chunks, blobs, proxy): `packages/server`
- Hono adapter + OpenAPI + console routes: `packages/server-hono`
- Client engine (schema, outbox, conflicts, plugins, blobs): `packages/client`
- React bindings: `packages/client-react`
- Transports: `packages/transport-http`, `packages/transport-ws`
- Edge relay: `packages/relay`
- Console UI app: `apps/console`
- Demo app: `apps/demo`
- Docs site + MDX content: `apps/docs` (content in `apps/docs/content/docs`)
- Tests: `tests`, `e2e`

## Canonical Sources of Truth (start here)

- Protocol types: `packages/core/src/types.ts`
- Server sync tables: `packages/server/src/schema.ts`
- Server table handler interface: `packages/server/src/handlers/types.ts`
- Subscription resolver interface: `packages/server/src/subscriptions/resolve.ts`
- Push / pull core: `packages/server/src/push.ts`, `packages/server/src/pull.ts`
- Client sync schema: `packages/client/src/migrate.ts`
- Client table handler interface: `packages/client/src/handlers/types.ts`
- React provider lifecycle: `packages/client-react/src/createSyncularReact.tsx`
- OpenAPI spec: `packages/server-hono/openapi.json`
- HTTP transport + typed client: `packages/transport-http/src/index.ts` (types: `packages/transport-http/src/generated/api.ts`)
- WebSocket transport: `packages/transport-ws/src/index.ts`
- Docs content: `apps/docs/content/docs`

## Feature Entry Points (where to look first)

- Commit-log sync (push/pull): `packages/server/src/push.ts`, `packages/server/src/pull.ts`, `packages/core/src/types.ts`
- Scope keys + subscriptions: `packages/server/src/subscriptions/*`, `packages/server/src/push.ts`, `packages/server/src/pull.ts`
- Bootstrap snapshot chunks: `packages/server/src/snapshot-chunks.ts`, `packages/server/src/pull.ts`, `packages/transport-http/src/index.ts`
- Realtime wake-ups + presence: `packages/server-hono/src/ws.ts`, `packages/transport-ws/src/index.ts`, `packages/client/src/engine/SyncEngine.ts`, `packages/client-react/src/hooks/usePresence.ts`
- Blob storage: `packages/server/src/blobs/*`, `packages/server-hono/src/blobs.ts`, `packages/client/src/blobs/*`, `packages/core/src/blobs.ts`
- E2EE plugin + key sharing: `packages/client-plugin-encryption/src/*`
- Edge relay: `packages/relay/src/*`
- Admin DB proxy: `packages/server/src/proxy/*`, `packages/server-hono/src/proxy/*`
- Console (API + UI): `packages/server-hono/src/console/*`, `console/src/*`
- Maintenance (prune/compact): `packages/server/src/prune.ts`, `packages/server/src/compaction.ts`

## Change Classifier (what else must change)

| If you changed… | Also check/update… |
|---|---|
| `packages/core` protocol/types | server/client/transports usage; docs snippets; tests |
| `packages/server-hono` routes / console API | `bun generate:openapi`; `packages/transport-http/src/generated/api.ts`; docs API pages; console UI |
| `packages/transport-http` or `packages/transport-ws` | console UI + demo + docs; runtime auth assumptions (WS headers vs query/cookies) |
| Public exports (barrels) | docs import paths; demo/console compile |
| Docs content (`apps/docs/content/docs`) | README consistency when relevant; verify links/build |

## Skills (Workflows)

Skills live in `.skills/*` and are intended to be loaded only when the task matches (keep AGENTS.md short and stable):

- `.skills/feature-workflow`
- `.skills/bugfix-triage`
- `.skills/openapi-refresh`
- `.skills/demo-workflow`
- `.skills/console-ui`
- `.skills/docs-refresh`

## After a Session (exit checklist)

- Run `bun check:fix`
- Run `bun test`
- Run the demo (`bun --cwd apps/demo dev`) and do a quick manual smoke test in a browser
- Update docs (`README.md` and `apps/docs/*`) if public behavior changed; keep them in sync
