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

This is a complete client for batch-style work. `syncUntilIdle()` runs sync
rounds until the outbox is pushed and the subscription has caught up, so a
CLI or cron worker calls it explicitly: once after start, then again after
writing. The [quickstart](/quickstart/) runs exactly this shape in a
terminal.

The bearer token is application auth: the server's `authenticate` callback
maps it to an actor and partition. The client ID identifies the replica and
is not an authentication credential. `openSqliteDatabase()` selects
`bun:sqlite` on Bun and the built-in `node:sqlite` module on Node 22.13 or
newer; there is no SQLite package or native addon to install.
Runtime-specific code can still import `openBunDatabase()` from
`@syncular/client/bun` or `openNodeDatabase()` from
`@syncular/client/node`.

## Long-running services: scheduling sync rounds

A `SyncClient` never starts a sync round on its own; its host decides when to
call `syncUntilIdle()`. In the browser deployment the shipped worker host
contains that scheduler, so you never see it. A headless process is its own
host: explicit calls (above) cover batch jobs, and a long-running service
reacts to two callbacks.

- `onSyncNeeded(reason)`: a wake-up. Startup found queued work, the server's
  hello requested a sync, or a realtime message announced new commits. Run a
  round soon.
- `onSyncIntent(intent)`: the core's exact scheduling instruction, emitted
  whenever its state changes:
  - `{ kind: 'interactive' }`: work is queued (for example a local write
    entered the outbox). Run a round now.
  - `{ kind: 'background', delayMs }`: the last round failed with a
    retryable error. Retry after `delayMs`; the core owns the backoff
    (doubling, capped at 30 seconds).
  - `{ kind: 'none' }`: nothing is pending. Cancel any scheduled round.

A consumer of these callbacks keeps three rules: one round runs at a time,
the newest intent replaces a pending timer, and shutdown stops scheduling.
This is a minimal scheduler holding all three:

```ts
import {
  installRealtimeSupervisor,
  webSocketRealtimeConnector,
  type SyncIntent,
} from '@syncular/client';

let client: SyncClient;
let timer: ReturnType<typeof setTimeout> | undefined;
let closed = false;
// Single-flight chain: the next round starts after the current one ends.
let running = Promise.resolve();

function schedule(intent: SyncIntent): void {
  if (closed) return;
  // The newest intent wins: drop whatever was pending.
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

const realtimeTicket = process.env.SYNCULAR_REALTIME_TICKET;
if (realtimeTicket === undefined) throw new Error('missing realtime ticket');
const clientId = 'appointment-worker-eu-1';

client = new SyncClient({
  // database, schema, clientId, transport, segments: as above
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

The realtime connection makes the callbacks fire while the service sits
idle: the server announces new commits over the WebSocket, the client
raises `onSyncNeeded`, and the scheduler pulls them. `installRealtimeSupervisor`
owns the initial connection, reconnect with bounded backoff, and a catch-up
sync after reconnect. A custom service loop can call `connectRealtime()` and
`disconnectRealtime()` directly instead.

The example authenticates the WebSocket with a query parameter because the
built-in connector uses the standard `WebSocket` constructor. Configure the
server to accept that short-lived ticket, and keep long-lived service bearers
out of URLs that a proxy may log. A rotating ticket flow can provide a custom
`RealtimeConnector` that obtains a ticket for each connection attempt. The
connector requires a global `WebSocket`, which Bun and Node 22.13 or newer
provide.

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

Stop the scheduler (`closed`, `timer`, and `running` are its state from
above), wait for the round in flight, then close the client and SQLite:

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

A server-side `SyncClient` fits a process that needs a persistent local SQL
read model with a durable outbox and realtime convergence. Every other
server-side need (database-less commits, registered queries, commands,
watches, telemetry, durable post-commit work) is compared in the
[capability matrix](/guide-remote-operations/#capability-matrix).
