# @syncular/react

React 18+ bindings for Syncular's revisioned reactive store. The same hooks
work with the direct TypeScript client, the browser worker handle, and the
Tauri/React Native bridges.

The store is client-scoped, not hook-scoped. Equal queries share one local SQL
read per revision, rows and window completeness come from one SQLite snapshot,
and stale promises cannot overwrite a newer revision. React is only a
`useSyncExternalStore` adapter over that renderer-independent state.

## Recommended query and mutation path

Author reads in `queries/*.sql` or `queries/*.syql`, run `syncular generate`,
and pass the generated descriptor to `useQuery`:

```tsx
import { SyncProvider, useMutation, useQuery } from '@syncular/react';
import { tasksTable } from './syncular.generated';
import { listTasksQuery } from './syncular.queries';

function Tasks({ projectId }: { projectId: string }) {
  const tasks = useQuery(listTasksQuery, { projectId });
  const mutation = useMutation(tasksTable);

  if (tasks.phase === 'loading') return <p>Loading…</p>;
  if (tasks.phase === 'error') return <p>{tasks.error?.message}</p>;
  if (tasks.phase === 'ready' && tasks.rows.length === 0) return <p>Empty</p>;

  return (
    <ul>
      {tasks.rows.map((task) => (
        <li key={task.id}>
          <button onClick={() => mutation.patch(task.id, { done: !task.done })}>
            {task.title}
          </button>
        </li>
      ))}
    </ul>
  );
}
```

Typegen puts these facts on the descriptor:

- a QueryIR-derived cache id, so SQL-only edits cannot reuse old state;
- exact table/scope dependencies for change routing;
- provable window coverage, claimed automatically while observed;
- a stable row key when the projection proves one.

`useQuery` returns `{ rows, phase, revision, isLoading, isRefreshing, error,
refresh }`. `phase` is:

- `loading`: there is not yet a complete answer and there are no partial rows;
- `partial`: rows exist, but some required window coverage is incomplete;
- `ready`: the atomic snapshot says the answer is complete, including an
  honestly empty result;
- `error`: the initial read failed. A later refresh error keeps existing rows
  and phase visible through `error`/`isRefreshing`.

## Provider and async initialization

A ready client can be passed directly:

```tsx
<SyncProvider client={client}><Tasks projectId="p1" /></SyncProvider>
```

For async engines, create one resource outside React render. It owns one
initialization attempt across StrictMode remounts and closes the client exactly
once when explicitly disposed:

```tsx
import { createSyncClientResource, SyncProvider } from '@syncular/react';

const clientResource = createSyncClientResource(() => createClient());

<SyncProvider
  client={clientResource}
  fallback={<p>Starting local database…</p>}
  renderError={(error) => <p>{error.message}</p>}
>
  <App />
</SyncProvider>
```

Call `await clientResource.dispose()` from the application's real lifecycle
owner, not from a StrictMode-sensitive child effect.

## `useMutation`

`useMutation()` retains the raw batch API. `useMutation(generatedTable)` adds
typed `upsert`, `patch`, and `remove` helpers:

```tsx
const mutation = useMutation(tasksTable, {
  onSuccess(commitId) {},
  onError(error) {},
});

await mutation.upsert({ id, projectId, title, done: false });
await mutation.patch(id, { title: 'Renamed' });
await mutation.remove(id);
```

It returns `pendingCount`, `isPending`, `error`, and `resetError`. Overlapping
writes remain pending until all calls settle. Every method still returns a
promise and rejects on failure; callbacks do not replace error handling.

## `useRawSql`

`useRawSql(sql, params?, options?)` is the read-only escape hatch for dynamic
SQL. It returns the same phase/revision result as `useQuery`.

```tsx
const summary = useRawSql<{ total: number }>(
  'SELECT count(*) AS total FROM tasks WHERE project_id = ?',
  [projectId],
  {
    dependencies: [{ table: 'tasks', scopeKeys: [`project:${projectId}`] }],
  },
);
```

Options:

| Option | Meaning |
| --- | --- |
| `dependencies` | Exact table-associated dependencies. |
| `coverage` | Required window units read atomically with the rows. |
| `rowKey` | Stable identity fields used to retain unchanged row objects. |
| `claimCoverage` | Claim declared coverage while observed; default `true`. |
| `enabled` | Disable observation and reads while `false`. |
| `id` | Stable cache identity for a raw query. |
| `tables`, `scopeKeys` | Compatibility shorthand; prefer `dependencies`. |

Without explicit dependencies, raw SQL uses a conservative `FROM`/`JOIN`
scan. Generated queries are preferred whenever the statement is known at
build time because typegen can prove more.

## Exact changes and windows

Both cores emit one revisioned `ClientChangeBatch` per observer transaction.
Table changes keep scope keys associated with their table; window changes can
complete a zero-row unit without inventing a row change; status/conflict-only
batches do not rerun SQL. Bridges forward this batch unchanged.

Generated query coverage uses composable claims. Multiple consumers of the
same window base contribute a union, and unmounting one removes only its own
units. `useWindow(base)` remains the lower-level imperative interface for
prefetching or dynamic query builders. Applications normally do not need it
beside a generated `useQuery`.

For a small known navigation working set,
`useRetainedWindow(base, units)` prefetches and retains those units through the
same coordinator. It returns `{ isPending, error }`, normalizes duplicate
units, and releases only its own claim on unmount, so application code does
not need a custom retention effect.

## Other hooks

- `useSyncStatus()` observes the status domain without a follow-up read after
  every row change. `outbox` is local push work; `syncNeeded` specifically
  means an inbound pull/catch-up signal.
- `useConflicts()` observes conflicts and rejections only when that domain
  changes.
- `useCommitOutcomes()` observes the durable newest-first final-outcome journal
  from exact `outcomesChanged` batches. Resolve entries through
  `useSyncClient().resolveCommitOutcome(...)`.
- `usePresence(scopeKey)` observes ephemeral realtime peers.
- `useSyncClient()` and `useReactiveStore()` expose the normalized low-level
  surfaces for integrations.

The hooks are SSR-safe: no local query runs during server rendering.
