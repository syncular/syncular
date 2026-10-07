# Server-side clients

Choose how a backend process talks to a Syncular server, then set up the local-replica option. This page is for backend developers whose CLI, cron job, webhook handler, or service reads or writes synced data. You finish knowing which surface fits and, for a local replica, with a running `SyncClient` that syncs on a schedule.

::meta{for="Backend developers" time="15 minutes" first="guide-server"}

:::terms
- **Headless client**: A `SyncClient` that runs in a process with no UI, such as a CLI, a background worker, or a long-running Node or Bun service. It is the same client a browser runs and has no DOM dependency when given a native SQLite backend.
- **Local replica**: The SQLite database a `SyncClient` keeps, holding subscribed rows and the outbox.
- **Remote client**: A `SyncRemoteClient`. It talks to the server over HTTP and keeps no local database.
- **Scheduler**: The host code that decides when a round runs. A `SyncClient` never starts one by itself.
:::

:::figure{title="Which server-side client" note="Decide by what the process needs" ticks}
<div class="node hot"><span class="t">The process needs</span>Reads and writes to synced rows</div>
<div class="d-cols-2">
<div class="d-stack">
<div class="node"><span class="t">Question</span>Local SQL, an offline outbox, or realtime convergence?</div>
<div class="d-down ok">Yes</div>
<div class="node ok"><span class="t">Local replica</span><b>SyncClient</b><br>SQLite file, outbox, subscriptions<br><span class="chip ok">This page</span></div>
</div>
<div class="d-stack">
<div class="node"><span class="t">Question</span>Only commits, registered queries, or commands?</div>
<div class="d-down">Yes</div>
<div class="node cool"><span class="t">Remote client</span><b>SyncRemoteClient</b><br>No database, HTTP calls<br><span class="chip cool">Reference below</span></div>
</div>
</div>

::caption[A local replica reads at SQLite speed and survives offline periods, and it must hold a persistent database. A remote client needs only a token and the network.]
:::

## Capability matrix

| Need | Surface | Local SQLite | Authorization | Durable retry |
|---|---|---:|---|---|
| Local SQL read model and offline outbox | Server-side `SyncClient` | Required | Resolved scopes or wildcard access | Outbox owned by client |
| Ordinary commit from a job or webhook | `SyncRemoteClient.commit()` | None | Normal write scopes | Caller retains prepared bytes |
| Predefined typed server SQL | `SyncRemoteClient.query()` | None | Generated scope coverage or privileged callback | Read-only request |
| Privileged transactional operation | `SyncRemoteClient.command()` | None | Command callback plus normal write scopes | Stable request ID |
| Live predefined query | `SyncRemoteClient.watch()` | None | Same rule as the query | Replacement snapshots while connected |
| Operator SQL next to the database | Storage or driver directly | None | Server trust boundary | Application-owned |
| Protocol telemetry | `SyncularServerEvents` | None | Operator access | Sink-owned |
| Durable post-commit work | [Durable server reactions](/server-reactions/) | None | Server configuration | Reaction store |

Application intent that must be durable and queryable belongs in immutable [domain event rows](/guide-domain-events/). `SyncRemoteClient` is documented on [Remote server operations](/guide-remote-operations/).

## Set up a local replica

Use a persistent database path. An in-memory database loses rows, subscription cursors, client identity, and the outbox on restart.

:::::steps
::::step{title="Open the local replica" time="4 min"}
```ts title="src/worker.ts"
import {
  httpSegmentDownloader,
  httpSyncTransport,
  SyncClient,
} from '@syncular/client';
import { openSqliteDatabase } from '@syncular/client/sqlite';
import { schema } from './syncular.generated';

const serviceToken = process.env.SYNCULAR_SERVICE_TOKEN;
if (serviceToken === undefined) throw new Error('missing service token');

const database = openSqliteDatabase('./data/appointment-worker.sqlite');

const client = new SyncClient({
  database,
  schema,
  clientId: 'appointment-worker-eu-1',
  transport: httpSyncTransport('https://api.example.com/sync', {
    headers: { Authorization: `Bearer ${serviceToken}` },
  }),
  segments: httpSegmentDownloader('https://api.example.com/segments', {
    headers: { Authorization: `Bearer ${serviceToken}` },
  }),
});

await client.start();
client.subscribe({
  id: 'clinic-42-appointments',
  table: 'appointments',
  scopes: { clinic_id: ['clinic-42'] },
});
await client.syncUntilIdle();
```

This is a complete client for batch-style work. `syncUntilIdle()` runs sync rounds until the outbox is pushed and the subscription has caught up. A CLI or cron worker calls it explicitly, once after start and again after writing. The [quickstart](/quickstart/) runs this shape in a terminal.

The bearer token is application auth: the server's `authenticate` callback maps it to an actor and partition. The client ID identifies the replica and is no authentication credential. `openSqliteDatabase()` selects `bun:sqlite` on Bun and built-in `node:sqlite` on Node 22.13 or newer, so no SQLite package or native addon is needed. Runtime-specific code can import `openBunDatabase()` from `@syncular/client/bun` or `openNodeDatabase()` from `@syncular/client/node`.

::checkpoint[`client.query('SELECT count(*) FROM appointments')` returns the rows in `clinic-42`.]
::::

::::step{title="Schedule sync rounds in a long-running service" time="5 min"}
A batch job skips this step. A `SyncClient` never starts a round itself, and a long-running service is its own host. In the browser the shipped worker host contains the scheduler, so the browser never shows one. A service reacts to two callbacks:

- `onSyncNeeded(reason)`: a wake-up. Startup found queued work, the server's hello requested a sync, or a realtime message announced new commits. Run a round soon.
- `onSyncIntent(intent)`: the core's exact scheduling instruction, emitted whenever its state changes.
  - `{ kind: 'interactive' }`: work is queued, for example a local write entered the outbox. Run a round now.
  - `{ kind: 'background', delayMs }`: the last round failed with a retryable error. Retry after `delayMs`. The core owns the backoff, which doubles up to a cap of 30 seconds.
  - `{ kind: 'none' }`: nothing is pending. Cancel any scheduled round.

`installSyncScheduler` is the shared scheduler. It coalesces duplicate wake-ups, runs one round at a time, replaces an older retry deadline with the newest intent, and removes its listeners on stop.

```ts title="src/worker.ts"
import {
  installSyncScheduler,
  installRealtimeSupervisor,
  webSocketRealtimeConnector,
} from '@syncular/client';

const realtimeTicket = process.env.SYNCULAR_REALTIME_TICKET;
if (realtimeTicket === undefined) throw new Error('missing realtime ticket');
const clientId = 'appointment-worker-eu-1';

const client = new SyncClient({
  // database, schema, clientId, transport, segments: as above
  realtime: webSocketRealtimeConnector(
    `wss://api.example.com/realtime?clientId=${encodeURIComponent(clientId)}&ticket=${encodeURIComponent(realtimeTicket)}`,
  ),
});

await client.start();
const scheduler = installSyncScheduler(client, {
  onError: (error) => console.error('sync failed', error),
});
client.subscribe({
  id: 'clinic-42-appointments',
  table: 'appointments',
  scopes: { clinic_id: ['clinic-42'] },
});
installRealtimeSupervisor(client);
```

With a realtime connection the callbacks fire while the service sits idle: the server announces new commits over the WebSocket, the client raises `onSyncNeeded`, and the scheduler pulls them. `installRealtimeSupervisor` owns the initial connection, reconnection with bounded backoff, and a catch-up sync after reconnect. A custom service loop can call `connectRealtime()` and `disconnectRealtime()` directly.

The built-in connector uses the standard `WebSocket` constructor, which Bun and Node 22.13 or newer provide globally and which cannot send headers. The example therefore authenticates the socket with a query parameter. Keep long-lived service bearers out of URLs that a proxy may log. Mint and verify a short-lived ticket ([Realtime tickets](/guide-auth/#realtime-tickets)), and supply a custom `RealtimeConnector` that obtains one per connection attempt when you rotate.

::checkpoint[A commit written by another client reaches the service's replica without a manual `syncUntilIdle()`.]
::::

::::step{title="Query and mutate" time="3 min"}
Reads use the local SQLite replica and do not wait for the network:

```ts title="src/worker.ts"
const rows = client.query(
  `SELECT id, starts_at_ms, status
     FROM appointments
    WHERE clinic_id = ?
    ORDER BY starts_at_ms`,
  ['clinic-42'],
);
```

Writes enter the same durable outbox as browser writes:

```ts title="src/worker.ts"
const commitId = client.mutate([
  {
    table: 'appointments',
    op: 'upsert',
    values: updatedAppointment,
  },
]);

await client.syncUntilIdle();
console.log({ commitId });
```

Keep one live client per database file. The default server-side lock assumes a single owner and does not coordinate across processes. Enforce ownership with your service manager, or supply a `LeaderLock` backed by a cross-process lock when several processes could open the same path.

::checkpoint[After `syncUntilIdle()` resolves, the commit appears in the server's commit log and on other clients.]
::::

::::step{title="Shut down cleanly" time="2 min"}
Stop the scheduler before closing the client and SQLite. `client.close()` aborts an in-flight round and releases the client lock.

```ts title="src/worker.ts"
let shutdownPromise: Promise<void> | undefined;

function shutdown(): Promise<void> {
  shutdownPromise ??= (async () => {
    scheduler.stop();
    await client.close();
    database.close();
  })();
  return shutdownPromise;
}

process.once('SIGINT', () => void shutdown());
process.once('SIGTERM', () => void shutdown());
```

::checkpoint[The process exits on SIGTERM without a held lock on the database file.]
::::
:::::

## Advanced: consume event rows idempotently

Use immutable [domain event rows](/guide-domain-events/) as the work source and keep consumer receipts in a worker-local table. Direct database writes suit this local-only table. Never write a synced table through `client.database`.

```ts title="src/worker.ts"
client.database.exec(`
  CREATE TABLE IF NOT EXISTS worker_receipts (
    event_id TEXT PRIMARY KEY,
    processed_at_ms INTEGER NOT NULL
  )
`);

const pending = client.query(`
  SELECT e.id, e.event_type, e.payload
    FROM domain_events AS e
    LEFT JOIN worker_receipts AS r ON r.event_id = e.id
   WHERE r.event_id IS NULL
   ORDER BY e.occurred_at_ms, e.id
   LIMIT 100
`);

for (const event of pending) {
  const eventId = String(event.id);
  await fetch('https://jobs.example.com/appointment-events', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Idempotency-Key': eventId,
    },
    body: String(event.payload),
  });
  client.database.exec(
    'INSERT OR IGNORE INTO worker_receipts(event_id, processed_at_ms) VALUES (?, ?)',
    [eventId, Date.now()],
  );
}
```

The downstream idempotency key covers a crash after the external call and before the local receipt insert. The local receipt avoids repeated calls in normal operation.
