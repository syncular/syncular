# Browser: realtime & lifecycle

Keep the socket connected, credentials fresh, and the page informed while the
worker syncs. You finish with the realtime supervisor installed, a transport
gate you can close, progress and sync events wired to your UI, and a dev setup
that survives hot reloads.

::meta{for="Web developers running the handle in production" time="10 minutes" first="platform-web-install" spec="8"}

:::terms
- **Supervisor**: The policy layer that owns connect, reconnect, and catch-up for the realtime socket.
- **Transport gate**: A switch that closes all network work while local reads and writes continue.
- **Wake-up**: A server message that raises an immediate sync intent.
- **Round**: One request and its response: push, then pull.
:::

:::figure{title="Who owns what at runtime" note="Page, supervisor, worker" ticks}
<div class="d-row">
<div class="node"><span class="t">Page</span>Renders local rows; reacts to events and revisions</div>
<span class="d-arrow"></span>
<div class="node hot"><span class="t">Supervisor</span>Connect, retry with jitter, suspend, catch up</div>
<span class="d-arrow"></span>
<div class="node ok"><span class="t">Worker</span>Owns the socket, coalesces wake-ups into rounds</div>
</div>

::caption[With `autoSync`, the worker is the sync host. The supervisor adds reconnect policy and never opens a second socket.]
:::

:::::steps
::::step{title="Install the supervisor" time="2 min"}
Install it after you register subscription intent. Render local rows
immediately instead of blocking startup on a network promise.

```ts title="src/sync.ts"
import {
  browserConnectivitySignal,
  documentLifecycleSignal,
  installRealtimeSupervisor,
} from '@syncular/client';

await handle.subscribe({ id: 'todos', table: 'todos', scopes });
installRealtimeSupervisor(handle, {
  connectivity: browserConnectivitySignal(),
  lifecycle: documentLifecycleSignal(),
});
```

The supervisor owns the initial connect, reconnect after a socket close,
bounded retry with jitter, suspension while the page is hidden or offline,
cancellation on close, and an explicit catch-up before it publishes
`connected`. `browserConnectivitySignal()` observes online and offline;
`documentLifecycleSignal()` observes visibility and page lifecycle. Unknown
browser connectivity stays connectable.

For an encrypted or locked app, also pass the host's protection signal. An
explicit protection signal keeps the supervisor suspended until it reports
`active`. A protected app passes a signal that publishes `preflight` before it
drains keys.

::checkpoint[`realtimeSupervisorSnapshot(handle).phase` reads `connected` after the socket opens.]
::::

::::step{title="Show the connection state" time="1 min"}
```ts title="src/status.ts"
import {
  realtimeSupervisorSnapshot,
  subscribeRealtimeSupervisor,
} from '@syncular/client';

const off = subscribeRealtimeSupervisor(handle, renderConnectionState);
const state = realtimeSupervisorSnapshot(handle);
// idle | connecting | connected | retrying | offline | background |
// protected | unsupported | stopped
```

The snapshot holds only the phase, the attempt count, and the library-owned
retry delay. Transport errors, URLs, identities, and headers never reach it.

::checkpoint[`renderConnectionState` fires once on subscribe and again on each phase change.]
::::

::::step{title="Authenticate and rotate" time="2 min"}
Pass `headers` (for example `Authorization`) to the handle config to
authenticate sync, segment, and blob requests. Rotate them without recreating
the handle:

```ts title="src/auth.ts"
await handle.setHeaders({ Authorization: `Bearer ${freshToken}` });
```

The realtime socket cannot carry headers. It authenticates by cookie or ticket;
see [Authentication](/guide-auth/#browser-send-and-rotate-the-header).

::checkpoint[The next `POST /sync` request carries the new `Authorization` header.]
::::
:::::

## Realtime policy

Under the default `optional` policy, a round runs over `POST /sync` whenever
the socket is absent, so continuous convergence still needs a host event, a
deadline, or an explicit command to start that round. Set
`realtimePolicy: 'required'` when the socket is the designated sync path: a
round then fails with `sync.realtime_unavailable` (`RealtimeUnavailableError`)
instead of using `POST /sync`. [Realtime](/concepts-realtime/#required-realtime)
defines the states.

After connection, deltas arrive over the socket, and server wake-ups raise an
immediate sync intent. With `autoSync` the worker coalesces those intents; the
page reacts to revisioned changes and re-queries. On a direct `SyncClient`,
provide `onSyncNeeded` and call `sync()` when it fires.

The handle's `onSyncNeeded`, `onConflict`, `onSynced`, `onUpgrading`,
`onPresence`, and `onDiagnostics` callbacks give the main thread the events it
needs for rendering. `connectRealtime()` and `disconnectRealtime()` remain for
custom hosts. Both are idempotent and single-flight, so repeated or concurrent
connects cannot orphan another socket.

## Transport gate

Direct clients accept `transportEnabled: false` at construction and expose
`setTransportEnabled(enabled)`. Worker handles accept the same initial option
and expose `setOffline(offline)`, which controls the same gate.

A closed gate keeps authorized SQLite reads and queued local commits available,
refuses new network work with `sync.offline`, and suspends automatic retry
scheduling. Resuming emits one interactive wake. An already-started round
finishes its atomic apply; the client closes realtime afterwards and starts no
follow-up round while the gate is closed. The gate is independent of security
preflight and defaults open on each new client instance. Install fresh
transport headers before you resume.

## Sync progress

`onProgress(listener)` on a direct client or worker handle delivers the latest
snapshot immediately when one exists, then updates during download and import.
It returns an unsubscribe function; unsubscribing stops observation and leaves
sync running.

```ts title="src/progress.ts"
const unsubscribe = handle.onProgress((progress) => {
  console.log(progress.phase, progress.bytesReceived, progress.rowsProcessed);
});
```

`progressSnapshot()` returns the cached value synchronously. The fields:

| Field | Meaning |
|---|---|
| `attempt` | Identifies one sync round. Counters reset when the payload changes or a new attempt starts. |
| `phase` | `request`, `download`, or `import`. |
| `state` | `running`, `complete`, or `failed`. |
| `subscriptionId`, `table`, `segmentId` | The current payload; `segmentId` is optional. |
| `bytesTotal`, `rowsTotal` | Absent when unknown. |
| `rowsProcessed` | Work inside an import transaction, including rows a failure can roll back. |
| `errorCode`, `retryDelayMs` | Set on `failed`. A scheduled background retry also sets `retryDelayMs`: 250 ms, doubling per consecutive failure up to 30,000 ms. |

`complete` follows checkpoint persistence and optimistic read-model
reconciliation for that round. It does not mean every subscription has
finished bootstrap. A failure retains the last counters. React views read the
same events with `useSyncProgress(client)` from `@syncular/react`; the Tauri and
React Native handles expose the same listener and snapshot methods.

## Offline replay

Keep calling `mutate` with the network gone: the outbox accumulates and local
reads stay live. On reconnect, the next sync drains the outbox with
[idempotent retry](/concepts-commits/). Applied commits leave the outbox;
conflicts and rejections surface. The outbox is schema-agnostic and re-encodes
at send time, so a schema upgrade loses nothing. Whole-origin deletion or
eviction is outside that guarantee: use the
[persistence setup](/platform-web-specifics/#eviction-resistant-storage) and
warn while best-effort storage holds pending commits.

The [demo app](https://github.com/syncular/syncular/tree/main/apps/demo)
exercises this live: two panes with offline toggles, a pending-commit counter,
surfaced conflicts, and file attachments.

## Keep one owner during HMR

React remounts do not duplicate a `createSyncClientResource`, but Vite can
replace the module that created it while its old worker is alive. A same-schema
component or query edit on the same Syncular release reuses that owner. A
generated-schema change or a Syncular package upgrade closes it before a
replacement worker starts:

```ts title="src/main.ts"
import {
  createViteSyncClientResource,
  type RetainedSyncularResource,
} from '@syncular/react';
import { schema } from './syncular.generated';

// Capture this evaluation's number. A live ESM binding read later could
// assign it to a resource an older module evaluation created.
const capturedSchemaVersion = schema.version;
const retained = createViteSyncClientResource(
  import.meta.hot?.data,
  capturedSchemaVersion,
  createClient,
);
const clientResource = retained.resource;

void retained.handoff.then(
  () => {
    if (import.meta.hot && retained.ownerChanged) {
      import.meta.hot.invalidate('Syncular owner identity changed');
    }
  },
  () => {
    // clientResource publishes the same close failure through
    // SyncProvider.renderBoundary; no replacement owner was opened.
  },
);
```

The helper stores this record in `import.meta.hot.data.syncularClientResource`:

```ts
interface RetainedSyncularResource {
  readonly schemaVersion: number;
  readonly runtimeVersion: string;
  readonly resource: SyncClientResource;
}
```

The published `@syncular/react` package carries the runtime version; the
application does not maintain it. On ordinary HMR both captured identities
match and the resource is reused. On a schema bump or a package upgrade, the
returned resource stays pending while disposal finishes, and its factory cannot
build the replacement client or worker until the handoff completes. Then the
module requests invalidation so the page, worker, generated schema, and query
modules advance together. If disposal fails, the replacement worker never opens
and the resource reports the close failure through `SyncProvider.renderBoundary`
as a startup error.

This bootstrap contains no top-level `await`, so it builds with Vite's ordinary
browser targets. `schemaChanged` is a compatibility alias for `ownerChanged`;
use `ownerChanged`. `retainViteSyncClientResource` implements the same
contract for module graphs whose target supports top-level await.

Effect cleanup of the old React provider can run after the retained resource
closed its client. Window release during store teardown is best effort, and a
closed handle does not escape as an unhandled rejection, so you do not need to
force a provider unmount first.

Keeping a worker on a new schema is unsafe even when a hot query module appears
to work: the page adopts new SQL immediately while the running worker still owns
the old local schema, and boot-time schema recovery runs only in the
replacement worker. Without the handoff, two workers can briefly compete for one
OPFS pool and report retryable `client.storage_busy`, which is no reason to
wipe the database. The
[official React example](https://github.com/syncular/syncular/blob/main/apps/demo-react/src/frontend/main.tsx)
uses this record.

### Upgrade Syncular during development

The optimizer exclusion keeps Syncular's worker graph out of hashed
`node_modules/.vite/deps` chunks, and the retained owner includes the published
Syncular runtime version. Together they replace the worker safely when a
package upgrade leaves the application schema unchanged. With a dev server
running:

1. Stop the Vite server.
2. Install the new packages with the repository's frozen-lockfile workflow.
3. Restart Vite once with `--force` to rebuild its third-party dependency cache.
4. Reload every open app tab so no old page keeps an obsolete worker graph.

Keep OPFS and site data. The replica, device identity, subscription cursors,
and unsynced outbox belong to the application origin and survive the worker
replacement. If the browser still reports a retired dynamic module, Syncular
raises `client.worker_restart_required` without exposing the chunk URL; repeat
the server restart and full reload.
