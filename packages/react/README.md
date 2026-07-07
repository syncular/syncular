# @syncular/react

React bindings for the syncular v2 client, with **fine-grained live
queries** designed in from day one (TODO 3.1 / `DESIGN-eviction.md` I1–I4).
A `useRawSql` re-runs **only** when a table it depends on is touched by an
apply batch — never "re-run everything on any change".

Works against **both** client cores through one interface:

- `SyncClient` — the direct core (constructed on the current thread), and
- `SyncClientHandle` — the worker-mode proxy (the whole core in an OPFS
  worker).

Their public surfaces diverge (getters vs methods, sync vs promise); the
bindings normalize both, so a component never cares which it holds.

React 18+ is a **peer dependency**. There are no other runtime dependencies.

## Quick start

```tsx
import { SyncProvider, useRawSql, useMutation } from '@syncular/react';

// `client` is a SyncClient or a SyncClientHandle you already started.
function App({ client }) {
  return (
    <SyncProvider client={client}>
      <Tasks />
    </SyncProvider>
  );
}

function Tasks() {
  const { rows, isLoading, error, refresh } = useRawSql(
    'SELECT id, title, done FROM tasks ORDER BY id',
  );
  const { mutate } = useMutation();

  if (isLoading) return <p>Loading…</p>;
  if (error) return <p>Query failed: {error.message}</p>;

  return (
    <ul>
      {rows.map((r) => (
        <li key={r.id}>{r.title}</li>
      ))}
      <button
        onClick={() =>
          mutate([
            {
              table: 'tasks',
              op: 'upsert',
              values: { id: crypto.randomUUID(), project_id: 'p1', title: 'new', done: false },
            },
          ])
        }
      >
        Add
      </button>
    </ul>
  );
}
```

The mutate applies optimistically (§7.1) and fires the invalidation batch, so
the list updates immediately — no manual refetch.

## The invalidation granularity truth

This is the honest granularity the wire actually provides — read it before
relying on scope-key narrowing.

The web-client emits **exactly one** `{ tables, scopeKeys }` invalidation event
per apply batch (a pull/delta round, a local `mutate`, a purge, or a
schema-bump reset — the ONE choke point). Never one event per row.

- **`tables`** — the set of tables whose local rows changed this batch. This
  is the **reliable floor**: it is always present and always correct.
- **`scopeKeys`** — `prefix:value` scope keys (§3.1), present **where the
  source carried them**:
  - `COMMIT` frames carry per-row stored scopes (§4.5), so commit-driven
    invalidation carries **precise** scope keys.
  - **Segments carry no per-row scope keys** — only a table + a scope digest.
    A segment (bootstrap / re-bootstrap) invalidation therefore carries the
    table plus the **subscription's effective scope keys**, the coarsest
    honest key for bulk data. It never fabricates per-row keys the wire did
    not deliver.
  - Purge / reset / optimistic writes are keyed by table (and by effective
    scope keys where a scope map is in hand).

**Consequence for `useRawSql`:** by default a query re-runs whenever a
depended-on **table** is touched. You may narrow further with `scopeKeys`
(below), but a **table-level** event (a segment bootstrap, a reset — one that
carries no scope keys) **always** re-runs a matching query, because it carries
no key to discriminate on. This is deliberate: under-running is a stale query,
the one thing a live-query layer must never do.

## `useRawSql(sql, params?, options?)`

Runs a local SQL query and keeps it live.

Returns `{ rows, isLoading, error, refresh }`.

### Dependency tables — inference and the escape hatch

By default the hook infers its dependency tables with a **conservative scan**
of the SQL text (the identifiers after `FROM`/`JOIN`). This is a heuristic,
**not** a SQL parser — it is intentionally over-inclusive at the edges (an
extra harmless re-run) rather than under-inclusive (a stale query).

When the text cannot be read (dynamic SQL, views, unusual syntax), pass the
explicit **`tables`** option — it always wins:

```tsx
useRawSql(buildDynamicSql(), params, { tables: ['tasks', 'projects'] });
```

### Options

| Option      | Meaning                                                                                                                             |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `tables`    | Explicit dependency tables. Overrides the SQL-text inference (the escape hatch).                                                    |
| `scopeKeys` | Narrow re-runs to specific `prefix:value` keys. A dependency-table event still re-runs if it carries **no** scope keys (see above). |
| `enabled`   | Skip running while `false` (e.g. inputs not ready).                                                                                 |

## Other hooks

- **`useSyncStatus()`** → `{ outbox, upgrading, leaseState, schemaFloor,
  syncNeeded, isLoading, refresh }`. Re-reads after every apply batch.
  (`online` is not a value the core exposes — §1.3 transport-owned — so it is
  not reported rather than guessed.)
- **`useConflicts()`** → `{ conflicts, rejections, refresh }` (§6.2/§6.3).
- **`usePresence(scopeKey)`** → the ephemeral peers present on a §8.6 scope
  key; updates on join/update/leave. Empty (and never crashes) without a
  connected realtime socket.
- **`useMutation()`** → `{ mutate, isPending, error }`. `mutate(mutations)`
  resolves to the `clientCommitId`; the optimistic overlay is applied
  immediately, and dependent `useRawSql`s re-run on the resulting batch.

## SSR

The hooks are SSR-safe: on the server they render their initial state and the
query fires only in the client-side mount effect. `renderToString` never
crashes.

## Design note — the window registry (forward-looking)

Per `DESIGN-eviction.md` I3, query bindings must be able to route a query's
scope footprint through the window registry once windowed sync (TODO §5
item 2) lands, so a query can report **completeness** (answerable from the
local replica vs a window miss). Today the registry trivially contains
"everything subscribed", so `useRawSql` always answers from the local
replica. The `scopeKeys` option is the seam through which per-scope
completeness will be surfaced without an API break.
