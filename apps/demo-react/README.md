# syncular v2 — demo-react (hooks example)

The hooks-based counterpart to the vanilla two-pane [`apps/demo`](../demo).
A single-pane todo app built entirely on `@syncular/react`, running against
the **same** server core (server-hono over bun:sqlite, a RealtimeHub
WebSocket, segment + blob endpoints) with a React frontend instead of the
vanilla-DOM one. The whole client core runs in a Web Worker on persistent
OPFS (Direction decision 2); the page talks RPC through the
`SyncClientHandle`, which `SyncProvider` hands to the hooks.

It dogfoods the full hook surface:

| Hook                                   | What it drives here                                             |
| -------------------------------------- | -------------------------------------------------------------- |
| `SyncProvider`                         | Supplies the worker-mode `SyncClientHandle` to the tree.       |
| `useQuery`                             | The live todo list — a **generated named query** (`queries/list-todos.sql` → typed descriptor), read-only, exact table invalidation baked in by typegen. |
| `useRawSql`                            | The done/total header badge — a raw read-only aggregate with explicit `{tables}`. |
| `useMutation`                          | Add / toggle / delete todos (writes go through the outbox).    |
| `useSyncStatus`                        | The `outbox N` badge + upgrading / schema-floor state.         |
| `useWindow`                            | The **list-filter dropdown** — picking a list calls `setWindow([list])`, which bootstraps that list and evicts the others (W1 value-sharded windowing, visible). `isComplete(list)` renders the completeness oracle. |

## Run

```sh
cd v2
bun install
cd apps/demo-react
bun run dev          # http://localhost:8788 (PORT=… to override)
```

Three seed lists — `groceries`, `work`, `travel` — so the window dropdown is
meaningful: each list is a separate scope value, windowed in one at a time.

## What to try

- **Typed live query**: the list re-renders the instant a todo changes — the
  `useQuery` named query re-runs only when `todos` invalidates (its
  dependency, resolved by typegen at generate time — no SQL text heuristic).
- **Window switching (W1)**: change the list dropdown. The new list bootstraps
  (a fresh image pull) and the previous one is evicted — "windowed-in: …"
  tracks the live set. A list that is not fully windowed-in shows the honest
  "data may be partial" note (I3).
- **Optimistic writes**: add a todo — it appears immediately and the `outbox`
  badge ticks up, then drains as the autoSync loop pushes it. Writes always go
  through `useMutation` → the outbox (never the read tiers).

## Notes

- **Typed reads, `mutate` writes.** `useQuery` runs the generated named-query
  tier and `useRawSql` the guarded raw tier — both read-only (the core rejects
  writes in `query`). Writes stay on `useMutation` so they land in the outbox
  and sync (SPEC §7.1).
- **Schema and queries are typegen-generated** (B5 dogfood): `syncular.json` +
  `migrations/` + `queries/` → `bun run generate` →
  `src/syncular.generated.ts` + `src/syncular.queries.ts` (the typed
  `listTodosQuery` descriptor `useQuery` runs).
- **Same server, different frontend.** Two `Bun.build` bundles at startup:
  `/app.js` (the React page) and `/worker.js` (the whole core); the sqlite-wasm
  bare specifier is rewritten to the vendor path in both because module
  workers do not inherit the page's import map.
- **Smoke test** (`src/smoke.test.ts`): boots the server and asserts it comes
  up and BUILDS the React frontend (`/app.js`/`/worker.js` bundle, `POST /sync`
  answers). The worker + OPFS runtime path itself is covered by the two-pane
  demo and the conformance suite over the identical core.
