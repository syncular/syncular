# React

`@syncular/react` exposes one hook surface over the browser worker, direct
TypeScript core, Tauri bridge, and React Native bridge. React 18+ is a peer
dependency.

```sh
bun add @syncular/react
```

The hooks adapt a client-scoped reactive store with `useSyncExternalStore`.
Equal queries share one local read per revision; stale async results cannot
replace newer state; rows and required-window completeness are read from one
SQLite snapshot.

## Provider

Pass an already-started client directly:

```tsx
<SyncProvider client={client}><App /></SyncProvider>
```

For an asynchronous engine, create a resource outside render. This is stable
through React StrictMode initialization and can retry a failed startup without
replacing the provider:

```tsx
import { createSyncClientResource, SyncProvider } from '@syncular/react';

const clientResource = createSyncClientResource(() => createClient());

<SyncProvider
  client={clientResource}
  fallback={<p>Starting local database…</p>}
  renderError={(error, retry) => (
    <button onClick={() => void retry()}>Try again: {error.message}</button>
  )}
>
  <App />
</SyncProvider>
```

The application lifecycle owner calls `clientResource.dispose()` when the
engine is truly no longer needed. A resource survives React remounts, but not
automatic module replacement: preserve it in your bundler's HMR data or dispose
the previous resource before constructing another persistent worker. The
[schema-aware Vite recipe](/guide-vite/#keep-one-schema-correct-persistent-owner-during-hmr)
and [official React example](https://github.com/syncular/syncular/blob/main/apps/demo-react/src/frontend/main.tsx)
capture the generated version, reuse same-schema edits, and order disposal
before a schema-bump replacement.

## Generated live queries

The recommended read path is a generated descriptor:

```tsx
import { useQuery } from '@syncular/react';
import { listTodosQuery } from './syncular.queries';

const todos = useQuery(listTodosQuery, { listId });
```

Typegen emits a QueryIR-derived id, exact table/scope dependencies, provable
window coverage, and a safe row key. Observing the query claims its coverage;
unobserving releases only that consumer's claim. There is no separate
`useWindow` effect or completeness read.

The result is `{ rows, phase, revision, isLoading, isRefreshing, error,
refresh }`:

- `loading`: no complete answer and no partial rows yet;
- `partial`: rows exist while required coverage is incomplete;
- `ready`: the atomic snapshot is complete, including a true empty result;
- `error`: the initial read failed.

```tsx
if (todos.phase === 'loading') return <Skeleton />;
if (todos.phase === 'error') return <ErrorView error={todos.error} />;
if (todos.phase === 'ready' && todos.rows.length === 0) return <Empty />;
return <Rows rows={todos.rows} partial={todos.phase === 'partial'} />;
```

## Typed mutations

Generated schema modules export table descriptors. Passing one to
`useMutation` adds typed helpers:

```tsx
import { useMutation } from '@syncular/react';
import { todosTable } from './syncular.generated';

const mutation = useMutation(todosTable);
await mutation.upsert({ id, listId, title, done: false, position, updatedAtMs });
await mutation.patch(id, { done: true, updatedAtMs: Date.now() });
await mutation.remove(id);
```

The hook exposes `pendingCount`, `isPending`, `error`, and `resetError` plus
optional `onSuccess`/`onError` callbacks. Overlapping mutations remain pending
until every promise settles. The untyped `mutate([...])` batch API remains
available from `useMutation()`.

## Raw SQL

`useRawSql` is the escape hatch for statements assembled at runtime:

```tsx
const result = useRawSql(
  'SELECT id, title FROM todos WHERE list_id = ?',
  [listId],
  { dependencies: [{ table: 'todos', scopeKeys: [`list:${listId}`] }] },
);
```

It has the same phase/revision result. Options include `dependencies`,
`coverage`, `rowKey`, `claimCoverage`, `enabled`, and `id`. The legacy
`tables`/`scopeKeys` shorthand remains available. If dependencies are omitted,
a conservative `FROM`/`JOIN` scanner is used.

The core guards raw SQL read-only: exactly one `SELECT`, `WITH`, `EXPLAIN`,
`PRAGMA`, or `VALUES` statement. Writes always use mutations and the outbox.

## Changes, windows, and other hooks

Every observer transaction produces one exact, monotonically revisioned
change batch. Scope keys stay associated with their table. Window completion
can invalidate a zero-row query without pretending a row changed. Status and
conflict-only changes do not rerun SQL.

Generated query coverage uses unioned claims. `useWindow(base)` is retained
for explicit prefetching and dynamic query builders; it is not needed for an
ordinary generated query.

- `useSyncStatus()` observes outbox/upgrading/lease/schema/pull state.
  `syncNeeded` means inbound pull/catch-up; `outbox` is pending local push work.
- `useConflicts()` observes conflict and rejection changes.
- `useCommitOutcomes()` observes the durable newest-first final-outcome journal
  and resolution transitions. Resolve an entry with
  `useSyncClient().resolveCommitOutcome(...)`.
- `usePresence(scopeKey)` observes ephemeral realtime peers.
- `useSyncClient()` and `useReactiveStore()` expose integration-level access.
  A realtime supervisor installed on the concrete client before
  `SyncProvider` is observable through the normalized `useSyncClient()` facade
  with `realtimeSupervisorSnapshot()` and
  `subscribeRealtimeSupervisor()`; the facade does not acquire socket
  ownership.

The normalized client also exposes
`useSyncClient().purgeLocalData({ purgeId, targets })` on every host that
implements the shared surface. This is an application-authorized security
operation, not a UI convenience; follow the subscription-gating workflow in
[Authorized local purge](/concepts-local-data-purge/).

The normalized client also exposes `securityLifecycle()`,
`beginSecurityPreflight()`, and keyless `activateSecurity()`. Install a
portable or direct keyring through the concrete client before mounting the
ordinary provider tree; React must not render protected hooks while the client
reports `preflight`.

## Router transition scheduling

Syncular hooks use React's `useSyncExternalStore` and may publish continuously
while realtime, local commits, diagnostics, or status are active. The router
remains the sole owner of route and query state; do not mirror its location in
a Syncular table or a second React store.

Some React Router releases publish router state through a transition by
default. Under sustained external-store traffic, the address bar and the
router's internal location can advance while a mounted route continues to
render its previous `useLocation()` or `useSearchParams()` snapshot. Syncular
cannot guarantee another library's transition scheduling. For route-owned
clinical controls that must agree synchronously with the visible URL, use the
router's explicit synchronous publication policy:

```tsx
import { RouterProvider } from 'react-router-dom';

<RouterProvider router={router} useTransitions={false} />
```

Keep that choice at the application router boundary rather than scattering
`flushSync`, browser-global reads, or mirrored query state through feature
components. The maintained React fixture repeatedly changes a checked
query-owned control while bursting Syncular status notifications and proves
the rendered `useSearchParams()` value, React Router location, and browser URL
converge without reload. Re-evaluate the explicit policy when upgrading React
or React Router; do not assume Syncular can force synchronous publication on a
router it does not own.

See [Named queries](/tooling-queries/), [Windowing](/concepts-windowing/), and
the [package README](https://github.com/syncular/syncular/tree/main/packages/react).
