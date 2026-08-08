# Remote server operations

Server processes do not all need a local replica. `SyncRemoteClient` is the
database-less client for ordinary commits, registered authoritative queries,
server-authoritative commands, and live query snapshots. It fits
machine-to-machine (M2M) integrations, admin queries, and workers without local
SQLite.

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
| Durable post-commit work | Durable server reactions | None | Server configuration | Reaction store |

## Database-less ordinary commits

The client uses the existing `/sync` push path. It does not create a local
database, subscription cursor, or outbox.

```ts
import {
  httpRemoteOperationTransport,
  httpSyncTransport,
  SyncRemoteClient,
} from '@syncular/client';
import { schema } from './syncular.generated';

const serviceToken = process.env.SERVICE_TOKEN;
if (serviceToken === undefined) throw new Error('missing service token');
const headers = { Authorization: `Bearer ${serviceToken}` };
const client = new SyncRemoteClient({
  schema,
  clientId: 'billing-webhooks',
  transport: httpSyncTransport('https://api.example.com/sync', { headers }),
  operations: httpRemoteOperationTransport(
    'https://api.example.com/operations',
    { headers },
  ),
});

const prepared = await client.prepareCommit({
  requestId: 'stripe-event-evt_123',
  mutations: [
    {
      table: 'invoices',
      op: 'upsert',
      values: invoice,
    },
  ],
});

const result = await client.sendCommit(prepared);
```

Persist `prepared.bytes` as binary data or base64 with the job when a retry
must survive process restart. Send the exact decoded bytes again after a lost
response. This also preserves random encryption nonces. The server returns
`cached` after the first applied delivery.

## Registered typed queries

Typegen already emits a typed `NamedQuery` descriptor for SQL and SYQL. The
server registers that descriptor; the remote client sends its generated ID and
parameters. Query text never crosses the network.

```ts
import {
  registerRemoteQuery,
  RemoteOperationRegistry,
} from '@syncular/server';
import { tasksInProjectQuery } from './syncular.queries';

export const operations = new RemoteOperationRegistry([
  registerRemoteQuery(tasksInProjectQuery, {
    maxRows: 500,
    auth: { access: 'scoped' },
  }),
]);
```

A scoped registration requires generated coverage for every table and every
declared scope in the query. In SYQL, declare it as a `sync query`; typegen then
emits coverage only when every scope is constrained by required equality or
`IN` predicates. The server resolves the caller's scopes and verifies every
covered value before executing SQL. Ordinary queries and queries without a
complete proof fail with `operation.invalid_request` when registered as
scoped.

An administrative query uses a mandatory privileged authorizer:

```ts
registerRemoteQuery(allInvoicesQuery, {
  maxRows: 2_000,
  auth: {
    access: 'privileged',
    authorize: ({ actorId }) => operatorIds.has(actorId),
  },
});
```

Mount the registry with Hono:

```ts
const app = createSyncularHono({
  config,
  operations,
  authenticate,
});
```

Call it with the same generated descriptor:

```ts
import {
  httpRemoteOperationTransport,
  SyncRemoteClient,
} from '@syncular/client';
import { tasksInProjectQuery } from './syncular.queries';

const token = process.env.SYNCULAR_SERVICE_TOKEN;
if (token === undefined) throw new Error('missing service token');
const headers = { Authorization: `Bearer ${token}` };

const queryClient = new SyncRemoteClient({
  clientId: 'reporting-worker',
  operations: httpRemoteOperationTransport(
    'https://api.example.com/operations',
    { headers },
  ),
});

const snapshot = await queryClient.query(tasksInProjectQuery, {
  projectId: 'project-42',
});

console.log(snapshot.rows, snapshot.maxCommitSeq);
```

The schema and `/sync` transport are optional when a process only calls
registered queries or commands. Ordinary commits require both.

The storage adapter rewrites every generated app-table relation into a
partition-filtered relation. It executes the rows and `maxCommitSeq` reads in
one database snapshot. SQLite, D1, and Postgres adapters implement this
capability. The authored query still needs syntax supported by the selected
server database. Typegen currently checks the SQLite form, so a Postgres
deployment should keep remotely registered SQL within the common SQL subset or
test it against Postgres in CI.

Registration requires generated result-column metadata. The server validates
and returns only those columns, so driver-specific or undeclared fields do not
cross the operation boundary.

## Server-authoritative commands

Commands run custom code after the partition write lock and idempotency
recheck. Their reads and returned mutations share the transaction used by the
normal push validator, commit validator, commit log, and realtime notification.

```ts
import {
  registerRemoteCommand,
  RemoteOperationRegistry,
} from '@syncular/server';
import { captureInvoice } from './remote-operation-descriptors';

const operations = new RemoteOperationRegistry([
  registerRemoteCommand(captureInvoice, {
    authorize: ({ actorId }) => billingServiceActors.has(actorId),
    run: async (command, input) => {
      const invoice = await command.getRow('invoices', input.invoiceId);
      if (invoice === undefined) throw new Error('invoice is unavailable');
      return [
        {
          table: 'invoices',
          op: 'upsert',
          values: { ...invoice, status: 'captured' },
        },
        {
          table: 'domain_events',
          op: 'upsert',
          values: {
            id: JSON.stringify([
              'invoice-captured',
              command.actorId,
              command.clientId,
              command.operationId,
              command.requestId,
            ]),
            account_id: invoice.account_id,
            aggregate_type: 'invoice',
            aggregate_id: input.invoiceId,
            event_type: 'invoice_captured',
            occurred_at_ms: Date.now(),
            payload: '{}',
          },
        },
      ];
    },
  }),
]);
```

Keep the shared descriptor in an import-safe module:

```ts
import {
  remoteCommand,
  type RemoteCommandDescriptor,
} from '@syncular/client';

export const captureInvoice: RemoteCommandDescriptor<{
  invoiceId: string;
}> = remoteCommand('commands/capture-invoice-v1');
```

The client supplies a stable request ID:

```ts
const result = await client.command(
  captureInvoice,
  'capture-request-018f',
  { invoiceId: 'invoice-42' },
);
```

The command authorizer is additional to normal write-scope authorization.
Configure wildcard scopes only for actors that should have full write access.
The command context exposes the request's identity-checked `clientId`, its
`operationId`, and its `requestId` for stable event and application idempotency
keys.
The authorizer can run again on a retry, so it must not have side effects.
Command callbacks should restrict side effects to planning database mutations.
External calls belong after the commit in an idempotent worker or durable
reaction.

## Live query watches

`RemoteOperationWatchHub` reruns affected registered queries and sends full
replacement snapshots. A commit touching unrelated tables does not rerun the
query. If commits arrive during a query, the session coalesces them into one
additional run.

```ts
import {
  composeRealtimeNotifiers,
  RemoteOperationWatchHub,
} from '@syncular/server';

const operationWatches = new RemoteOperationWatchHub(operations);
const config = {
  ...baseConfig,
  realtime: composeRealtimeNotifiers(syncRealtimeHub, operationWatches),
};
```

The host's WebSocket upgrade for `/operations/realtime` authenticates the
request, builds a `SyncRequestContext`, and connects it. The Syncular portion
of that runtime-specific adapter is:

```ts
import type {
  RemoteOperationWatchSession,
  SyncRequestContext,
} from '@syncular/server';

export function connectOperationWatches(
  context: SyncRequestContext,
  send: (bytes: Uint8Array) => void,
): RemoteOperationWatchSession {
  return operationWatches.connect(context, send);
}
```

Forward each inbound binary WebSocket message to `session.receive(bytes)` and
call `session.close()` when the socket closes. If `receive()` rejects, close
the socket with an application protocol error. The Hono adapter mounts the
HTTP `/operations` route; WebSocket upgrade wiring remains with the runtime
host.

Client setup and subscription:

```ts
import {
  httpRemoteOperationTransport,
  httpSyncTransport,
  SyncRemoteClient,
  webSocketRemoteOperationConnector,
} from '@syncular/client';

const token = process.env.SYNCULAR_SERVICE_TOKEN;
if (token === undefined) throw new Error('missing service token');
const realtimeTicket = process.env.SYNCULAR_OPERATION_REALTIME_TICKET;
if (realtimeTicket === undefined) throw new Error('missing realtime ticket');
const headers = { Authorization: `Bearer ${token}` };

const client = new SyncRemoteClient({
  schema,
  clientId: 'reporting-worker',
  transport: httpSyncTransport('https://api.example.com/sync', { headers }),
  operations: httpRemoteOperationTransport(
    'https://api.example.com/operations',
    { headers },
  ),
  operationRealtime: webSocketRemoteOperationConnector(
    `wss://api.example.com/operations/realtime?ticket=${encodeURIComponent(realtimeTicket)}`,
  ),
});

const unwatch = await client.watch(
  tasksInProjectQuery,
  { projectId: 'project-42' },
  {
    onSnapshot: ({ rows }) => replaceReport(rows),
    onError: (error) => reportWatchFailure(error),
  },
);

unwatch();
client.close();
```

Use a short-lived WebSocket ticket because proxy access logs can retain URLs.
A custom `RemoteOperationRealtimeConnector` can obtain a new ticket for each
connection attempt when the application rotates them.

Watches are live invalidations, not durable work delivery. After a connection
loss, reconnect and register the watch again to receive a fresh snapshot.

## Boundaries

- Remote operation requests contain a registered ID and encoded values. They
  never contain caller-supplied SQL.
- Direct authoritative database access is for trusted code already inside the
  database trust boundary. It does not create Syncular commits or realtime
  notifications by itself.
- `SyncularServerEvents` describes protocol operation. Domain event rows
  describe application intent.
- Durable server reactions schedule recoverable post-commit work. Query
  watches provide replaceable live state and may repeat or disappear with the
  connection.
