# Admin console

The admin console is an operator page that your sync server serves next to `POST /sync`. It answers the questions a support ticket raises about one partition: what happened to a write, why a device does not see a row, which requests of a person fail, and which devices still run an old schema. This page enables the console and walks through each of those questions.

::meta{for="Server operators" time="10 minutes" first="guide-server"}

## Enable the console

On a Hono server, pass `admin` to `createSyncularHono`:

```ts title="src/server.ts"
import { createSyncularHono } from '@syncular/server-hono';

const app = createSyncularHono({
  config,
  authenticate,
  admin: {
    authorize: ({ request }) => isOperator(request), // your check
    authorizeActions: ({ request }) => isOnCall(request), // optional
  },
});
```

The app serves the console at `/admin` and its JSON routes below that path. `path` moves the mount, and `ringCapacity` sets how many server events the console keeps in memory (default 1000). The option composes its event ring into `config.events` and into the realtime hub in `config.realtime`, so the console sees rounds over `POST /sync` and over the socket. The ring lives in process memory: a restart clears it, and each process of a multi-process deployment keeps its own.

On Cloudflare Workers, pass the same guards to `createWorkersFetchHandler`:

```ts title="src/worker.ts"
const handler = createWorkersFetchHandler<Env>({
  config: (env) => ({ /* config and authenticate */ }),
  realtime: (env) => ({ namespace: env.REALTIME }),
  admin: (env) => ({
    authorize: ({ request }) => isOperator(request, env),
    authorizeActions: ({ request }) => isOnCall(request, env),
  }),
});
```

The Worker runs the guards and forwards each partition's requests to that partition's Durable Object, which keeps the event ring ([Cloudflare Workers](/server-workers/#admin-console)).

:::warning{title="Admin access is application-data access"}
`authorize` is mandatory: the option throws without it, and a falsy result answers 401 on every route, the page included. The console shows decoded row values, commit changes, and reaction payloads. Grant it to the people who may read your users' data.
:::

`authorize` receives `{ partition, request }`. The partition comes from `?partition=` or the partition picker. Without one, a deployment with exactly one partition uses it, and a deployment with several asks the operator to pick one. The fleet list (`GET /admin/partitions`) calls `authorize` with an empty partition, so a guard that grants single partitions does not grant the fleet list. `authorizeActions` gates the [operator actions](#operator-actions); without it the console is read-only.

## Find what a report names

The find box (`/`) takes the id a support ticket carries: a client id, an actor id, a row id, a commit number, or a client commit id. A single match opens directly. Several matches list by kind.

### A change did not sync

Search the `clientCommitId` of the write, which the device's outbox holds. The write view lists each stored outcome: `applied` with the commit it became, or `rejected` with the result code and message of each operation. Below the outcomes, the events of the requests that carried the write show how each request ended. No outcome means that the server never received the write, or that its idempotency record expired.

### A device does not see a row

Search the row id, or open Data, pick the table, and open the row. The row page shows the row's values, scopes, and retained history, and lists every client of the partition with its delivery verdict. Open a client's verdict for the trace: the client's subscriptions on the table, the scope values each one requests, the scopes `resolveScopes` allows the actor, and the client's cursor against the row's last change.

| Verdict | Meaning | Next step |
|---|---|---|
| `delivered` | A subscription matches and the client's cursor has passed the row's last change. | Look on the device: its local query or a [local data purge](/concepts-local-data-purge/) hides the row. |
| `pending-pull` | A subscription matches, and the client has not pulled since the row changed. | The client's next pull delivers it. A client that stays here has stopped syncing; check its client page. |
| `scope-mismatch` | The client subscribes to the table, and no subscription requests the row's scope values. | Fix the scopes the app subscribes with. |
| `scope-denied` | A subscription requests the row's scopes, and `resolveScopes` excludes them for the actor. | Fix `resolveScopes` or the actor's membership ([Scopes](/concepts-scopes/)). |
| `no-subscription` | The client has no subscription on the table. | Write-only clients, such as a seeding script, are expected here. |
| `row-deleted` | The row's last change is a delete. | The client drops the row on its next pull. |
| `client-unknown` | The partition has no cursor record for the client. | Check the partition: the client syncs in another one or has never synced. |
| `row-missing` | The partition holds no row with this id in the table. | Check the table and the id. |

### A person's requests fail

People lists every actor with its devices, open sockets, worst cursor lag, and failures in the last 5 minutes. Open an actor, or its failure count, for its failed and warned requests. A request opens its events in order: the outcome, the error code, and, for a rejected or conflicted push, the row it hit. A device opens its client page with its connection, lease, subscriptions, failures, and recent events. The client record also stores the last round per client: `lastRoundAtMs`, and, while the last round failed, `lastErrorCode` and `consecutiveFailures`. `listClients` returns them, so a client whose cursor stays fixed while the log head moves shows the code it fails with and how many rounds in a row. A failure the client observed and reported on its next request (a response that timed out on a slow link, a lost socket) appears there too, as the client's own code such as `transport.timeout`; the next request that reports nothing clears it.

### A schema rollout stalls

People counts devices per schema version above the actor table. A device below the server's schema version carries a `v<n>` tag, so a straggler shows up next to its owner.

### Failures across the partition

Overview charts request volume, error rate, p95 latency, and push outcomes over the last 5 minutes, and groups failures by error code or by client. An error code opens the event tail filtered to that code. When the ring dropped events inside the 5-minute window, the figures carry `partial window` and the chart marks where the data starts.

## Operator actions

`authorizeActions` adds three actions. Each opens a confirmation that names the request it sends, then shows the server's answer or its error code.

- `Retry reaction`: requeues a dead-lettered [durable reaction](/server-reactions/) from the Reactions view.
- `Prune now`: runs one [commit-log prune](/server-operations/#commit-log-pruning) pass from the horizon panel on Overview.
- `Revoke lease`: revokes a client's auth lease from its client page ([SPEC §7.3](https://github.com/syncular/syncular/blob/main/docs/SPEC.md#73-auth-leases)).

## Views and shortcuts

| Key | View | Contents |
|---|---|---|
| `1` | Overview | Request figures, horizon gauge, cursor-lag histogram, failures, and the fleet list. |
| `2` | People | Actors with their devices, connection state, failures, and the schema version spread. |
| `3` | Data | Tables with row counts; a table opens a row browser filtered by scope. |
| `4` | Commits | The commit log, newest first, with each commit's first row changes. |
| `5` | Events | The event tail grouped by request, filtered by kind, client, level, and text. |
| `6` | Reactions | The durable reaction queue, dead letters first. |
| `7` | Storage | Segment and blob store counters and the commit log's retention state. |

`/` focuses the find box, `f` the filter of the open view, and `p` the partition picker. `r` refreshes the open view, `a` cycles auto refresh (off, 2 s, 5 s, 15 s), and `space` pauses the event tail. `?` lists every shortcut. The URL hash keeps the open view and its arguments, so a link to `#/row/cards/c-13` opens that row for the next operator.

## Where the data comes from

Clients, rows, commits, and write outcomes come from server storage and stay available as long as retention keeps them. Requests, failures, metrics, and the event tail come from the event ring. The ring holds the last `ringCapacity` events of one process (one partition's Durable Object on Workers), so a busy server shows minutes of history and a restart starts it empty. Send the same events to your log pipeline for anything older ([Structured events](/server-operations/#structured-events)).

The console is one HTML page of about 110 KiB (31 KiB gzipped) with no external scripts, fonts, or images. It ships inside `@syncular/server-hono`, so every Workers deployment bundles it whether or not `admin` is set. The JSON routes behind it are listed in the [`@syncular/server` README](https://github.com/syncular/syncular/tree/main/packages/server#http-routes--the-single-console-page).

## Try it in the sync lab

The [sync lab](/demo/) opens the console for its in-browser server from "Server console". Select "Simulate conflict", then open People: the actor whose push conflicted shows one failure, which opens the conflicted request and the card it hit.
