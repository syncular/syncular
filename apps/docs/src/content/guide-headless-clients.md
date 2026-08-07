# Headless Node and Bun clients

`SyncClient` is the server client for a process that needs a local synchronized
read model. The same client used in a browser runs in a CLI, background worker,
or long-running Node or Bun service. It has no DOM dependency when supplied a
native SQLite backend.

Use a persistent database path. An in-memory database loses rows, subscription
cursors, client identity, and the outbox on restart.

## Open the local replica

```ts
import {
  httpSegmentDownloader,
  httpSyncTransport,
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

let client: SyncClient;
let timer: ReturnType<typeof setTimeout> | undefined;
let closed = false;
let running = Promise.resolve();

function schedule(intent: SyncIntent): void {
  if (closed || intent.kind === 'none') return;
  if (timer !== undefined) clearTimeout(timer);
  const delay = intent.kind === 'background' ? intent.delayMs : 0;
  timer = setTimeout(() => {
    running = running
      .then(() => client.syncUntilIdle())
      .then(() => undefined)
      .catch((error) => console.error('sync failed', error));
  }, delay);
}

client = new SyncClient({
  database,
  schema,
  clientId: 'appointment-worker-eu-1',
  transport: httpSyncTransport('https://api.example.com/sync', {
    headers: { Authorization: `Bearer ${serviceToken}` },
  }),
  segments: httpSegmentDownloader('https://api.example.com/segments', {
    headers: { Authorization: `Bearer ${serviceToken}` },
  }),
  realtime: webSocketRealtimeConnector(
    `wss://api.example.com/realtime?access_token=${encodeURIComponent(serviceToken)}`,
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
await client.connectRealtime();
```

The HTTP and WebSocket credentials are application auth. The server's
`authenticate` callback maps them to an actor and partition. The example uses a
query parameter for WebSocket authentication because the built-in connector
uses the standard `WebSocket` constructor. Configure the server to accept that
credential, or provide a custom `RealtimeConnector` for a runtime that supports
headers. Bun and current Node runtimes provide `fetch`; the WebSocket connector
also requires a global `WebSocket` implementation.

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

Keep one live client per database file. The leader lock fails if another
process tries to own the same replica concurrently.

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
async function shutdown(): Promise<void> {
  closed = true;
  if (timer !== undefined) clearTimeout(timer);
  await running;
  await client.close();
  database.close();
}

process.once('SIGINT', () => void shutdown());
process.once('SIGTERM', () => void shutdown());
```

## Choose the correct server-side surface

- Headless `SyncClient`: persistent local SQLite, local SQL reads, scoped or
  wildcard access from `resolveScopes`, durable outbox, subscriptions, and
  realtime convergence.
- [`SyncRemoteClient`](/guide-remote-operations/): no SQLite. It submits
  ordinary commits and calls registered remote queries or commands.
- Direct authoritative database access: trusted code located with the server
  database. It bypasses the Syncular client protocol and should remain inside
  the server trust boundary.
- `SyncularServerEvents`: operational telemetry. It is not a durable work
  queue or an application subscription.
- Durable server reactions: durable post-commit work scheduling. They are
  separate from a headless replica and from live query watches.

Search terms: server client, headless client, Node client, Bun client,
background worker, CLI sync.

