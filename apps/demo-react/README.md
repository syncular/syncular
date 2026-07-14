# syncular — demo-react (hooks example)

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
| `SyncProvider`                         | Consumes a StrictMode-safe async client resource.              |
| `useQuery`                             | The live todo list — generated scope dependencies, window coverage, row identity, and atomic phase/revision. |
| `useRawSql`                            | The done/total header badge — a raw read-only aggregate with explicit `{tables}`. |
| `useMutation`                          | Typed add / patch / delete helpers through the outbox.         |
| `useSyncStatus`                        | The `outbox N` badge + upgrading / schema-floor state.         |

## Run

```sh
bun install
cd apps/demo-react
bun run dev          # http://localhost:8788 (PORT=… to override)
```

Three seed lists — `groceries`, `work`, `travel` — so the window dropdown is
meaningful: each list is a separate scope value, windowed in one at a time.

## What to try

- **Typed live query**: the list re-renders the instant a relevant todo
  changes. Equal observers share a read and unchanged rows retain identity.
- **Window switching (W1)**: change the list dropdown. The new list bootstraps
  from the query's generated coverage and the previous claim is released.
  Rows and completeness come from one snapshot, so only `ready + []` is empty.
- **Optimistic writes**: add a todo — it appears immediately and the `outbox`
  badge ticks up, then drains as the autoSync loop pushes it. Writes always go
  through `useMutation` → the outbox (never the read tiers).

## Notes

- **Typed reads, `mutate` writes.** `useQuery` runs the generated named-query
  tier and `useRawSql` the guarded raw tier — both read-only (the core rejects
  writes in `query`). Writes stay on `useMutation` so they land in the outbox
  and sync (SPEC §7.1). Updates use generated `patch` helpers instead of
  spreading a full row.
- **Schema and queries are typegen-generated** (B5 dogfood): `syncular.json` +
  `migrations/` + `queries/` → `bun run generate` →
  `src/syncular.generated.ts` + `src/syncular.queries.ts` + deterministic
  `syncular.queries.ir.json`.
- **Same server, different frontend.** Two `Bun.build` bundles at startup:
  `/app.js` (the React page) and `/worker.js` (the whole core); the sqlite-wasm
  bare specifier is rewritten to the vendor path in both because module
  workers do not inherit the page's import map.
- **Smoke test** (`src/smoke.test.ts`): boots the server and asserts it comes
  up and BUILDS the React frontend (`/app.js`/`/worker.js` bundle, `POST /sync`
  answers). The worker + OPFS runtime path itself is covered by the two-pane
  demo and the conformance suite over the identical core.
