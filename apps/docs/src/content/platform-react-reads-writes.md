# React: reads & writes

Read synced rows with `useQuery`, write them with `useMutation`, and fall back
to `useRawSql` for runtime-built statements. You finish knowing what each phase
of a result means and how to render all of them.

::meta{for="React developers building screens over synced rows" time="8 minutes" first="platform-react-install" spec="4"}

:::terms
- **Phase**: `loading`, `partial`, `ready`, or `error`: the completeness of a query result.
- **Coverage**: The window of rows a query needs to be complete.
- **Dependency**: A table and optional scope keys a query reads.
:::

:::figure{title="The four phases of a query result" note="Render from phase" ticks}
<div class="d-row">
<div class="node"><span class="t">loading</span>No complete answer, no rows yet</div>
<span class="d-arrow"></span>
<div class="node hot"><span class="t">partial</span>Rows exist; required coverage is incomplete</div>
<span class="d-arrow"></span>
<div class="node ok"><span class="t">ready</span>Complete snapshot, including a true empty result</div>
</div>
<div class="d-row">
<div class="node bad"><span class="t">error</span>The latest read, or the latest sync attempt while coverage was incomplete, failed</div>
</div>

::caption[Only `phase === 'ready'` with zero rows is a truthful empty list. `error` keeps the rows and revision of the last successful read.]
:::

:::::steps
::::step{title="Read with a generated query" time="3 min"}
A generated descriptor is the recommended read path. Typegen emits a
QueryIR-derived id, exact table and scope dependencies, provable window
coverage, and a safe row key.

```tsx title="src/Todos.tsx"
import { useQuery } from '@syncular/react';
import { listTodosQuery } from './syncular.queries';

const todos = useQuery(listTodosQuery, { listId });

if (todos.phase === 'loading') return <Skeleton />;
if (todos.phase === 'error') return <ErrorView error={todos.error} />;
if (todos.phase === 'ready' && todos.rows.length === 0) return <Empty />;
return <Rows rows={todos.rows} partial={todos.phase === 'partial'} />;
```

The result is `{ rows, phase, revision, isLoading, isRefreshing, error,
refresh }`. Observing the query claims its coverage; unobserving releases only
that consumer's claim. No separate `useWindow` effect or completeness read is
needed.

::checkpoint[The component renders skeleton, then partial or ready rows, and `phase` never reads `ready` while bootstrap is incomplete.]
::::

::::step{title="Write with a typed mutation" time="3 min"}
Generated schema modules export table descriptors. Passing one to `useMutation`
adds typed helpers:

```tsx title="src/AddTodo.tsx"
import { useMutation } from '@syncular/react';
import { todosTable } from './syncular.generated';

const mutation = useMutation(todosTable);
await mutation.upsert({ id, listId, title, done: false, position, updatedAtMs });
await mutation.patch(id, { done: true, updatedAtMs: Date.now() });
await mutation.remove(id);
```

The hook exposes `pendingCount`, `isPending`, `error`, and `resetError`, plus
optional `onEnqueued` and `onError` callbacks. Overlapping mutations stay
pending until every promise settles. `useMutation()` without a descriptor
returns the untyped `mutate([...])` batch API.

:::warning{title="Render the mutation error"}
`useMutation` catches a rejection and exposes it as `error`. An app that calls
`mutate` and drops the promise has no failure surface: a dead worker or a
validation rejection reads as "the app ignored me". Render `error`.
:::

::checkpoint[After `upsert` resolves, the `useQuery` that covers the row re-renders with it, offline too.]
::::
:::::

## Errors in a query result

An `error` phase carries either the latest read failure or, while required
coverage is incomplete, the latest sync attempt failure. A failed attempt sets
`error` to a `SyncRoundFailedError` whose `code` is the attempt's stable error
code, for example `sync.transport_failed`. `retryable` is true when the client
scheduled a background retry, and `retryDelayMs` is that retry's delay: 250 ms,
doubling per consecutive failure up to 30,000 ms. A failure with
`retryable: false` has no automatic next attempt. The query returns to `loading`
or `partial` when the next attempt starts.

## Cached reads during sync

A query hook requests a local snapshot while its window claim registers. A
complete cached window renders at once, and incomplete coverage stays `partial`.
A registration failure stays visible even when the snapshot holds rows, so
handle the query `error` and `useRetainedWindow().error` in the owning view.
Imports and cache eviction yield between committed chunks automatically. See
[Windowed sync](/concepts-windowing/) for coverage semantics.

## Raw SQL

`useRawSql` handles statements assembled at runtime:

```tsx title="src/Search.tsx"
const result = useRawSql(
  'SELECT id, title FROM todos WHERE list_id = ?',
  [listId],
  { dependencies: [{ table: 'todos', scopeKeys: [`list:${listId}`] }] },
);
```

It returns the same phase and revision result. The options are `dependencies`,
`coverage`, `rowKey`, `claimCoverage`, `enabled`, and `id`. Set `id` to a
stable value without protected data for support diagnostics; the default id is
`raw` and never contains SQL. The table-list shorthand `tables` with `scopeKeys`
still works. Without dependencies, the hook infers tables with a conservative
`FROM` and `JOIN` scanner.

The core accepts exactly one read-only statement: `SELECT`, `WITH`, `EXPLAIN`,
`PRAGMA`, or `VALUES`. Writes always go through mutations and the outbox. For
typed `.sql` reads, see [Named queries](/tooling-queries/).
