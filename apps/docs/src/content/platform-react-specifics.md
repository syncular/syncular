# React: platform specifics

Reference for how the hooks behave beneath the call: change batches, re-render
rules, the complete hook list, the client surface the hooks share, the security
lifecycle, and router scheduling.

::meta{for="Developers debugging render behavior or writing a custom client" time="10 minutes" first="platform-react-reads-writes" spec="4.8 7.6"}

:::terms
- **Change batch**: One exact, revisioned set of table, scope, and window changes from one observer transaction.
- **`SyncClientLike`**: The structural interface every host implements; the hooks target it.
- **Window claim**: A query's registration of the coverage it needs.
:::

## Change batches and re-renders

Every observer transaction produces one exact, monotonically revisioned change
batch. Scope keys stay associated with their table. A completed window can
invalidate a zero-row query without a row changing. Status-only and
conflict-only changes do not rerun SQL.

A hook re-renders only when its value changes:

| Hook value | Stability rule |
|---|---|
| Query `rows` | A re-read keeps each unchanged row object, and keeps the `rows` array when no row changed, including an empty result that stays empty. |
| Query without a successful read | All such queries share one frozen snapshot per phase and availability, so a query whose parameters or coverage change before its first read returns the same result object and `rows` array. |
| Status, conflict, and outcome hooks | Each new snapshot is compared by value, and the current object stays when the values are equal. The comparison matches `Date` values by time and compares `Error` and other class instances by identity. |

Generated query coverage uses unioned claims. `useWindow(base)` stays available
for explicit prefetching and dynamic query builders; an ordinary generated
query does not need it.

## Hook list

| Hook | Observes |
|---|---|
| `useQuery(descriptor, params)` | A generated live query. |
| `useRawSql(sql, params, options)` | A runtime-built read-only statement. |
| `useMutation(table?)` | Local writes, with typed helpers when you pass a table. |
| `useSyncStatus()` | Outbox, upgrading, lease, schema floor, availability, pull state. `syncNeeded` is an inbound pull or catch-up; `outbox` is pending local push work. |
| `useConflicts()` | Conflict and rejection changes. |
| `useCommitOutcomes()` | The durable newest-first final-outcome journal and its resolution transitions. |
| `usePresence(scopeKey)` | Ephemeral realtime peers. |
| `useSyncProgress(client)` | Live download and import progress. |
| `useWindow(base)`, `useRetainedWindow` | Explicit window claims. |
| `useSyncClient()`, `useReactiveStore()` | Integration-level access to the client and the store. |

## The shared client surface

`SyncProvider` keeps the client identity you supply, and `useSyncClient()`
returns that client. A custom client implements the canonical snapshot methods
and method-form collection reads. Its read methods can return values or
promises, so application code that supports several hosts awaits them:

```ts title="src/status.ts"
const status = await client.statusSnapshot();
// schemaFloor, leaseState, upgrading, syncNeeded come from this snapshot.
```

`conflicts()`, `rejections()`, and `securityLifecycle()` are methods on every
client. `purgeLocalData({ purgeId, targets })` is an application-authorized
security operation on every host that implements the shared surface; follow the
subscription-gating workflow in
[Authorized local purge](/concepts-local-data-purge/).

## Security lifecycle

The shared client also exposes `securityLifecycle()`,
`beginSecurityPreflight()`, and keyless `activateSecurity()`. Install a portable
or direct keyring through the concrete client before you mount the ordinary
provider tree. React must not render protected hooks while the client reports
`preflight`.

## Router transition scheduling

Syncular hooks use `useSyncExternalStore` and can publish continuously while
realtime, local commits, diagnostics, or status are active. Your router remains
the sole owner of route and query state: do not mirror its location in a
Syncular table or a second React store.

Some React Router releases publish router state through a transition by
default. Under sustained external-store traffic, the address bar and the
router's internal location can advance while a mounted route keeps rendering its
previous `useLocation()` or `useSearchParams()` snapshot. Syncular cannot
control another library's transition scheduling. For route-owned controls that
must agree synchronously with the visible URL, use the router's explicit
synchronous publication policy:

```tsx title="src/main.tsx"
import { RouterProvider } from 'react-router-dom';

<RouterProvider router={router} useTransitions={false} />
```

Set that policy at the application router boundary. Scattering `flushSync`,
browser-global reads, or mirrored query state through feature components does
not replace it. The maintained React fixture changes a checked, query-owned
control repeatedly while it bursts Syncular status notifications, and verifies
that the rendered `useSearchParams()` value, the React Router location, and the
browser URL converge without a reload. Re-evaluate the policy when you upgrade
React or React Router.

## Related

- [Named queries](/tooling-queries/) and [Windowed sync](/concepts-windowing/).
- The [package README](https://github.com/syncular/syncular/tree/main/packages/react).
