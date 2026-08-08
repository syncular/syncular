# Server-side sync clients

`SyncClient` can run server-side when a process needs a local synchronized
read model. The same client used in a browser runs in a CLI, background worker,
or long-running Node or Bun service. It has no DOM dependency when supplied a
native SQLite backend. This deployment is sometimes called a headless client.

Use a persistent database path. An in-memory database loses rows, subscription
cursors, client identity, and the outbox on restart.

## Open the local replica

```ts
import {
  httpSegmentDownloader,
  httpSyncTransport,
  installRealtimeSupervisor,
  SyncClient,
  webSocketRealtimeConnector,
  type SyncIntent,
} from '@syncular/client';
import { openBunDatabase } from '@syncular/client/bun';
// Node: import { openNodeDatabase } from '@syncular/client/node';
import { schema } from './syncular.generated';

const database = openBunDatabase('./data/appointment-worker.sqlite');
// const database = openNodeDatabase('./data/appointment-worker.sqlite');

const serviceToken = process.env.SYNCULAR_SERVICE_TOKEN;
if (serviceToken === undefined) throw new Error('missing service token');
const realtimeTicket = process.env.SYNCULAR_REALTIME_TICKET;
if (realtimeTicket === undefined) throw new Error('missing realtime ticket');
const clientId = 'appointment-worker-eu-1';

let client: SyncClient;
let timer: ReturnType<typeof setTimeout> | undefined;
let closed = false;
let running = Promise.resolve();

function schedule(intent: SyncIntent): void {
  if (closed) return;
  if (timer !== undefined) {
    clearTimeout(timer);
    timer = undefined;
  }
  if (intent.kind === 'none') return;
  const delay = intent.kind === 'background' ? intent.delayMs : 0;
  timer = setTimeout(() => {
    timer = undefined;
    running = running
      .then(() => client.syncUntilIdle())
      .then(() => undefined)
      .catch((error) => console.error('sync failed', error));
  }, delay);
}

client = new SyncClient({
  database,
  schema,
  clientId,
  transport: httpSyncTransport('https://api.example.com/sync', {
    headers: { Authorization: `Bearer ${serviceToken}` },
  }),
  segments: httpSegmentDownloader('https://api.example.com/segments', {
    headers: { Authorization: `Bearer ${serviceToken}` },
  }),
  realtime: webSocketRealtimeConnector(
    `wss://api.example.com/realtime?clientId=${encodeURIComponent(clientId)}&ticket=${encodeURIComponent(realtimeTicket)}`,
  ),
  onSyncNeeded: () => schedule({ kind: 'interactive' }),
  onSyncIntent: schedule,
});

await client.start();
client.subscribe({
  id: 'clinic-42-appointments',
  table: 'appointments',
  scopes: { clinic_id: ['clinic-42'] },
});
await client.syncUntilIdle();
installRealtimeSupervisor(client);
```

The supervisor owns initial connection, reconnect with bounded backoff, and a
catch-up sync after reconnect. A custom service loop can call
`connectRealtime()` and `disconnectRealtime()` directly instead.

The HTTP and WebSocket credentials are application auth. The server's
`authenticate` callback maps them to an actor and partition. The realtime host
passes `clientId` to `RealtimeHub.connect`; Syncular checks its actor binding.
The client ID identifies the replica and is not an authentication credential.
The example uses a query parameter for WebSocket authentication because the
built-in connector uses the standard `WebSocket` constructor. Configure the
server to accept that short-lived ticket. Do not put a long-lived service
bearer in a URL that a proxy may log. A rotating ticket flow can provide a
custom `RealtimeConnector` that obtains a ticket for each connection attempt.
Bun and current Node runtimes provide `fetch`; the WebSocket connector also
requires a global `WebSocket` implementation.

`openNodeDatabase()` uses the optional `better-sqlite3` peer. Install it in a
Node service. Bun should use `openBunDatabase()` and `bun:sqlite`.

## Query and mutate

Reads use the local SQLite replica and do not wait for the network:

```ts
const rows = client.query(
  `SELECT id, starts_at_ms, status
     FROM appointments
    WHERE clinic_id = ?
    ORDER BY starts_at_ms`,
  ['clinic-42'],
);
```

Writes enter the same durable outbox as browser writes:

```ts
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

Keep one live client per database file. The default server-side lock assumes a
single owner and does not coordinate across processes. Enforce ownership with
your service manager or supply a `LeaderLock` backed by a cross-process lock
when several processes could open the same path.

## Idempotent event consumption

Use immutable [domain event rows](/guide-domain-events/) as the work source.
Keep consumer receipts in a worker-local table. Direct database writes are
appropriate for this local-only table; never write a synced table through
`client.database`.

```ts
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

The downstream idempotency key covers a crash after the external call and
before the local receipt insert. The local receipt avoids repeated calls in
normal operation.

## Clean shutdown

Stop scheduling new rounds, close realtime, wait for the current round, then
close SQLite:

```ts
let shutdownPromise: Promise<void> | undefined;

function shutdown(): Promise<void> {
  shutdownPromise ??= (async () => {
    closed = true;
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
    await running;
    await client.close();
    database.close();
  })();
  return shutdownPromise;
}

process.once('SIGINT', () => void shutdown());
process.once('SIGTERM', () => void shutdown());
```

## Choose the correct server-side surface

- Server-side `SyncClient`: persistent local SQLite, local SQL reads, scoped
  or wildcard access from `resolveScopes`, durable outbox, subscriptions, and
  realtime convergence.
- [`SyncRemoteClient`](/guide-remote-operations/): no SQLite. It submits
  ordinary commits and calls registered remote queries or commands.
- Direct authoritative database access: trusted code located with the server
  database. It bypasses the Syncular client protocol and should remain inside
  the server trust boundary.
- `SyncularServerEvents`: operational telemetry. It is not a durable work
  queue or an application subscription.
- [Durable server reactions](/server-reactions/): durable post-commit work
  scheduling. They are separate from a server-side replica and from live
  query watches.
