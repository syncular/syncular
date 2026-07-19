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
  if (tasks.phase === 'blocked') {
    return <p>Sync unavailable: {tasks.availability.reason}</p>;
  }
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
availability, refresh }`. `availability` is the typed `ready`, `migrating`, or
`blocked` state shared by every client host. `phase` is:

- `loading`: there is not yet a complete answer and there are no partial rows;
- `partial`: rows exist, but some required window coverage is incomplete;
- `ready`: the atomic snapshot says the answer is complete, including an
  honestly empty result;
- `blocked`: sync cannot safely serve a fresh result because the generated
  schema is incompatible or the browser leader is unreachable. `isLoading`
  is `false`; previously read rows remain available for deliberate read-only
  UI, and `availability.reason` identifies the boundary;
- `error`: the initial read failed. A later refresh error keeps existing rows
  and phase visible through `error`/`isRefreshing`.

## Provider and async initialization

A ready client can be passed directly:

```tsx
<SyncProvider client={client}><Tasks projectId="p1" /></SyncProvider>
```

For async engines, create one resource outside React render. It owns one
initialization attempt across StrictMode remounts, can retry a failed startup
without replacing the provider, and closes the client exactly once when
explicitly disposed:

```tsx
import { createSyncClientResource, SyncProvider } from '@syncular/react';

const clientResource = createSyncClientResource(() => createClient());

<SyncProvider
  client={clientResource}
  fallback={<p>Starting local database…</p>}
  renderError={(error, retry) => (
    <div>
      <p>{error.message}</p>
      <button onClick={() => void retry()}>Try again</button>
    </div>
  )}
>
  <App />
</SyncProvider>
```

Call `await clientResource.dispose()` from the application's real lifecycle
owner, not from a StrictMode-sensitive child effect. Resource disposal and
provider-effect cleanup are safe in either order: provider teardown treats
window release as best effort when the owned client has already closed. Callers
do not need to stage a provider unmount before disposing its resource.

If the application requires authentication or signed quarantine processing
before protected data is visible, complete the concrete client's security
preflight before returning it from the resource factory. Do not mount the
ordinary provider tree while `securityLifecycle` is `preflight`: reactive store
startup intentionally touches protected status/outcome/query surfaces.

```ts
const clientResource = createSyncClientResource(async () => {
  const client = await createClient({ securityPreflight: true });
  await applyValidatedLocalPurge(client);
  await client.activateSecurity({ encryption: acceptedKeyring });
  return client;
});
```

The normalized client exposes `securityLifecycle()`,
`beginSecurityPreflight()`, and keyless `activateSecurity()` for host-agnostic
coordination. Key-bearing activation stays on each concrete client type because
direct TypeScript uses an `EncryptionConfig`, while Worker/Tauri/React Native
use the portable keyring.

Use `renderBoundary` as the canonical application guard across browser and
native hosts. It covers resource startup/errors, migration, client upgrade,
server-behind, incompatible-schema, and unreachable-leader states. The
provider restores its children automatically when the public status becomes
ready again:

```tsx
<SyncProvider
  client={clientResource}
  renderBoundary={(state, actions) => (
    <SyncBlockedScreen state={state} onRetry={actions.retry} />
  )}
>
  <App />
</SyncProvider>
```

`fallback` and `renderError` retain their existing behavior when
`renderBoundary` is absent. `useSyncStatus()` exposes the same classified
`availability` plus `currentSchemaVersion`, `schemaFloor`, and the raw status
fields for status chrome outside the provider guard.

The resource is stable across React remounts, not JavaScript module replacement.
During development, preserve it in the bundler's hot-module data or dispose the
old resource before creating another one. Otherwise the old worker and the new
worker can briefly compete for the same persistent OPFS directory. Never wipe
or rename the database in response to a retryable startup error.

For Vite, use `retainViteSyncClientResource(hot.data, schema.version,
createClient)`. It retains a `{ schemaVersion, runtimeVersion, resource }`
record, reuses it for same-schema HMR on the same published Syncular runtime,
and awaits old-resource disposal before creating a schema-bump or
package-upgrade replacement. Request `hot.invalidate()` only when its
`ownerChanged` result is true and `disposalError` is absent; the official
example, optimizer exclusion, and upgrade workflow are in the
[Vite guide](https://syncular.dev/guide-vite/). The helper may close
the retained client before React runs cleanup for the old provider; Syncular
absorbs that teardown-only window-release race while still surfacing failures
from closing the resource itself.

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

- `useDiagnostics({ expectedSubscriptions })` observes the versioned,
  privacy-safe support snapshot. Native/Worker events trigger a fresh request,
  preserving expected-but-unregistered intent on every host. Subscription ids
  must be stable and PHI-free; scopes are not accepted.
- `useSyncStatus()` observes the status domain without a follow-up read after
  every row change. It includes `availability` and `currentSchemaVersion`;
  `outbox` is local push work, while `syncNeeded` specifically means an inbound
  pull/catch-up signal.
- `useConflicts()` observes conflicts and rejections only when that domain
  changes.
- `useCommitOutcomes()` observes the durable newest-first final-outcome journal
  from exact `outcomesChanged` batches. Resolve entries through
  `useSyncClient().resolveCommitOutcome(...)`.
- `usePresence(scopeKey)` observes ephemeral realtime peers.
- `useSyncClient()` and `useReactiveStore()` expose the normalized low-level
  surfaces for integrations.

The hooks are SSR-safe: no local query runs during server rendering.

### Privacy-safe support view

Use application-owned, stable, PHI-free subscription ids to make missing
registration distinguishable from a completed zero-row bootstrap. The hook
refreshes after diagnostics events on direct, Worker, Tauri, and React Native
hosts while preserving that expected intent:

```tsx
import { useDiagnostics } from '@syncular/react';

const expectedSubscriptions = [
  { id: 'membership-security', table: 'facility_memberships' },
  { id: 'scheduler-window', table: 'surgeries' },
] as const;

function SyncSupportPanel() {
  const { snapshot, isLoading, error, refresh } = useDiagnostics({
    expectedSubscriptions,
  });

  if (isLoading) return <p>Collecting local sync evidence…</p>;
  if (error) return <p>Diagnostics unavailable: {error.message}</p>;

  return (
    <section>
      <button type="button" onClick={() => void refresh()}>
        Refresh
      </button>
      <button
        type="button"
        disabled={!snapshot}
        onClick={() =>
          snapshot &&
          void navigator.clipboard.writeText(JSON.stringify(snapshot, null, 2))
        }
      >
        Copy support snapshot
      </button>
      <pre>{JSON.stringify(snapshot, null, 2)}</pre>
    </section>
  );
}
```

The snapshot deliberately excludes scopes, rows, clinical counts, SQL, paths,
identities, credentials, mutation bodies, stack traces, and arbitrary prose.
Do not enrich the copied bundle with database files, query results, or console
dumps. See SPEC §7.6 for the complete contract.
