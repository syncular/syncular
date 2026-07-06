# React

`@syncular/react` ships live queries over **fine-grained invalidation**: a
query re-runs only when a table it depends on changes — never "re-run
everything on any change". This page covers the whole hook surface and the
invalidation model behind it.

React 18+ is a peer dependency; there are no other runtime dependencies.

```sh
bun add @syncular/react   # or: npm install @syncular/react
```

The bindings work against **both** client hosts through one interface: a
direct `SyncClient` (constructed on the current thread) and a
`SyncClientHandle` (the whole core in an OPFS worker — see
[Web (browser)](/platform-web/)). Their surfaces diverge (getters vs methods,
sync vs promise); the bindings normalize both, so a component never cares
which it holds. The same hooks run unchanged over the Tauri and React Native
bridges — see [Tauri](/platform-tauri/) and
[React Native](/platform-react-native/).

## `SyncProvider`

Wrap your tree once with a client you already started:

```tsx
import { SyncProvider } from '@syncular/react';

function App({ client }) {
  // `client` is a SyncClient or a SyncClientHandle.
  return (
    <SyncProvider client={client}>
      <Tasks />
    </SyncProvider>
  );
}
```

Every hook below reads the client from this context (`useSyncClient()` exposes
it directly if you need it).

## The invalidation model

The client emits **exactly one** `{ tables, scopeKeys }` invalidation event
per apply batch (a pull round, a local `mutate`, a purge, or a schema-bump
reset). A live query re-runs only when that event touches one of its
**dependency tables**.

Where do the dependency tables come from? Three answers, by tier:

- `useSyncQuery` infers them with a conservative scan of the SQL text (the
  identifiers after `FROM`/`JOIN`). It is a heuristic, intentionally
  over-inclusive (an extra harmless re-run) rather than under-inclusive (a
  stale query). The explicit `tables` option always wins.
- `useTypedQuery` extracts them from the compiled Kysely query's AST — exact,
  no text heuristic.
- `useNamedQuery` gets them baked into the generated descriptor — typegen
  resolved them from the query's `FROM`/`JOIN` against the schema.

Events also carry `scopeKeys` where the wire delivered them (commit frames
carry precise per-row scope keys; segment bootstraps carry only the table).
The `scopeKeys` option narrows re-runs further, but a table-level event with
no keys always re-runs a matching query — under-running is a stale query, the
one thing a live-query layer must never do. The full granularity contract is
in the [react package README](https://github.com/syncular/syncular/tree/main/packages/react).

## `useSyncQuery(sql, params?, options?)`

Runs a local SQL query and keeps it live. Returns
`{ rows, isLoading, error, refresh }`.

```tsx
import { useSyncQuery } from '@syncular/react';

const { rows, isLoading } = useSyncQuery(
  'SELECT id, title, done FROM tasks WHERE project_id = ? ORDER BY id',
  [projectId],
);
```

| Option      | Meaning                                                                           |
| ----------- | --------------------------------------------------------------------------------- |
| `tables`    | Explicit dependency tables. Overrides the SQL-text inference (the escape hatch).   |
| `scopeKeys` | Narrow re-runs to specific `prefix:value` keys (see the invalidation model above). |
| `enabled`   | Skip running while `false` (e.g. inputs not ready).                                |

## `useNamedQuery(query, params?, options?)`

The hook for the generated **named-query** tier: you author a `.sql` file,
typegen emits a typed descriptor plus its `Row` type, and the hook runs it
live with the descriptor's exact table set — precise invalidation, zero
heuristics, and the row type is the query's own projection.

```tsx
import { useNamedQuery } from '@syncular/react';
import { listTodosQuery, type ListTodosRow } from './syncular.queries';

const { rows } = useNamedQuery(listTodosQuery, { listId }); // ListTodosRow[]
```

A param-less query takes no second argument. See
[Named queries](/tooling-queries/) for authoring `.sql` files.

## `useTypedQuery(build, deps?, options?)`

The Kysely-typed twin, behind the `@syncular/react/typed` subpath (it needs
the `@syncular/kysely` and `kysely` peers, kept out of the main barrel so apps
using only `useSyncQuery` never bundle Kysely). You write a builder typed by
your generated `Database` interface; the hook compiles it, runs it live, and
extracts the dependency tables from the compiled query's AST. `deps` re-keys
the builder like a `useEffect` dependency array.

```tsx
import { useTypedQuery } from '@syncular/react/typed';
import type { Database, TodosRow } from './syncular.generated';

const { rows } = useTypedQuery<Database, Pick<TodosRow, 'id' | 'title'>>(
  (db) => db.selectFrom('todos').select(['id', 'title']).where('list_id', '=', listId),
  [listId],
);
```

Read-only, like the dialect: a write builder throws — writes must go through
the outbox. See [Kysely](/tooling-kysely/).

## `useMutation()`

Returns `{ mutate, isPending, error }`. `mutate(mutations)` resolves to the
commit id; the optimistic overlay is applied immediately, and dependent
queries re-run on the resulting invalidation batch — no manual refetch.

```tsx
const { mutate, isPending } = useMutation();
await mutate([
  { table: 'tasks', op: 'upsert', values: { id: crypto.randomUUID(), project_id: 'p1', title: 'new', done: false } },
]);
```

## Status, conflicts, presence, windows

- `useSyncStatus()` → `{ outbox, upgrading, leaseState, schemaFloor,
  syncNeeded, isLoading, refresh }`. Re-reads after every apply batch.
  (`online` is not reported — the core does not own connectivity, so the hook
  never guesses it.)
- `useConflicts()` → `{ conflicts, rejections, refresh }` — see
  [Conflicts](/concepts-conflicts/).
- `usePresence(scopeKey)` → the ephemeral peers present on a scope key, as an
  array; updates on join/update/leave. Empty (never crashes) without a
  connected realtime socket — see [Realtime](/concepts-realtime/).
- `useWindow(base)` → `{ units, setWindow, isComplete }` — the
  [windowed sync](/concepts-windowing/) surface: `setWindow(units)` swaps the
  live scope values (added units bootstrap, removed units evict), and
  `isComplete(unit)` is the completeness oracle, so you can render "this data
  may be partial" honestly.

## A full component

Adapted from the [demo-react app](https://github.com/syncular/syncular/tree/main/apps/demo-react):
a windowed todo list where the selector drives `setWindow`, the read is a
named query, and writes go through the outbox.

```tsx
import { SyncProvider, useMutation, useNamedQuery, useSyncStatus, useWindow } from '@syncular/react';
import { useEffect, useState } from 'react';
import { listTodosQuery } from './syncular.queries';

const WINDOW_BASE = { table: 'todos', variable: 'list_id' } as const;

function TodoApp() {
  const [list, setList] = useState('groceries');
  const { setWindow, isComplete } = useWindow(WINDOW_BASE);
  const { mutate, isPending } = useMutation();
  const status = useSyncStatus();

  // Window the selected list in; switching lists evicts the previous one.
  useEffect(() => {
    void setWindow([list]);
  }, [list, setWindow]);

  // Live read: re-runs exactly when `todos` invalidates.
  const { rows, isLoading } = useNamedQuery(listTodosQuery, { listId: list });

  const add = (title: string) =>
    mutate([
      {
        table: 'todos',
        op: 'upsert',
        values: { id: crypto.randomUUID(), list_id: list, title, done: false, position: rows.length + 1, updated_at_ms: Date.now(), attachment: null },
      },
    ]);

  if (isLoading) return <p>loading…</p>;
  return (
    <div>
      <select value={list} onChange={(e) => setList(e.target.value)}>
        <option>groceries</option>
        <option>work</option>
      </select>
      <span>outbox {status.outbox}</span>
      <ul>
        {rows.map((row) => (
          <li key={row.id}>{row.title}</li>
        ))}
      </ul>
      <button disabled={isPending} onClick={() => add('new todo')}>Add</button>
      {!isComplete(list) ? <p>this list is not fully windowed-in — data may be partial</p> : null}
    </div>
  );
}
```

Wrap it with a provider holding the worker handle from
[Web (browser)](/platform-web/) — `<SyncProvider client={handle}>` — or any
other host.

## SSR

The hooks are SSR-safe: on the server they render their initial state and the
query fires only in the client-side mount effect. `renderToString` never
crashes.

## Where to go next

- [Web (browser)](/platform-web/) — building the client the provider wraps.
- [Named queries](/tooling-queries/) — the typed `.sql` tier `useNamedQuery` runs.
- [Kysely](/tooling-kysely/) — the dynamic typed tier behind `useTypedQuery`.
- [`@syncular/react` README](https://github.com/syncular/syncular/tree/main/packages/react) — the full granularity contract.
