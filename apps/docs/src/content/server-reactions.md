# Durable server reactions

Durable server reactions run application work after Syncular accepts a client
commit. Use them for email, webhooks, projection updates, and jobs that must not
disappear when a server process stops after committing the source data.

A reaction has two application callbacks with different constraints:

1. `reactionPlanner` examines an accepted candidate commit inside the
   authoritative transaction and returns bounded JSON records.
2. `ReactionRunner` claims committed records and invokes handlers outside the
   transaction.

Delivery is at least once. A process can stop after a handler calls an external
system and before Syncular records completion. The next worker receives the
same reaction and the same `idempotencyKey`. Pass that key to every external
system that supports idempotent requests.

Normative behavior is defined in
[SPEC §6.9](https://github.com/syncular/syncular/blob/main/docs/SPEC.md#69-durable-server-reactions).

## Define typed reaction records

Map each reaction type to its persisted payload. The type name is the handler
registration key. `version` belongs to the record so handlers can migrate
independently of old queued work.

```ts
import type { ReactionPlanner } from '@syncular/server';

type AppReactions = {
  'invoice.email': {
    readonly invoiceId: string;
    readonly customerId: string;
  };
};

const reactionPlanner: ReactionPlanner<AppReactions> = ({ operations }) =>
  operations.flatMap((operation) => {
    if (
      operation.table !== 'invoice_events' ||
      operation.op !== 'upsert' ||
      operation.row?.kind !== 'invoice_finalized'
    ) {
      return [];
    }

    const invoiceId = operation.row.invoice_id;
    const customerId = operation.row.customer_id;
    if (typeof invoiceId !== 'string' || typeof customerId !== 'string') {
      throw new Error('invalid invoice_finalized event');
    }

    return [
      {
        key: `finalized-email:${invoiceId}`,
        type: 'invoice.email',
        version: 1,
        payload: { invoiceId, customerId },
        maxAttempts: 8,
      },
    ];
  });
```

Each planner `key` must be unique within the source commit. Syncular derives
the persisted handler key from
`[partition, clientId, clientCommitId, plannerKey]`, so retries and partitions
cannot collide.

The planner may use its candidate-state `read` API when the operations do not
contain enough information. Reads observe all staged sibling operations. Keep
the planner short and deterministic because the authoritative transaction and
partition serialization remain open until it returns.

The planner must not send messages, call a provider, publish to a queue, or
perform another external effect. TypeScript cannot enforce callback purity. A
planner exception rolls the transaction back and surfaces as a server failure,
so a later client retry may run the planner again.

## Add the planner to the server

Pass the planner with the rest of the canonical server configuration:

```ts
import type { SyncServerConfig } from '@syncular/server';

const config: SyncServerConfig = {
  schema,
  storage,
  segments,
  resolveScopes,
  reactionPlanner,
};
```

For a new accepted commit, Syncular persists the app rows, commit metadata,
reaction records, and applied idempotency result in one transaction. A
conflict, authorization failure, validator rejection, or whole-commit
rejection plans and enqueues nothing. Replaying an already applied client
commit returns the cached result without running the planner again.

An invalid planned record fails the source transaction. Current bounds are:

| Field | Limit |
|---|---|
| Reactions per commit | 100 |
| `key` | 256 UTF-8 bytes |
| `type` | 128 UTF-8 bytes, code-like characters |
| `version` | Positive signed 32-bit integer |
| `payload` | Plain JSON, 64 KiB, maximum depth 16 |
| `maxAttempts` | 1 through 100, default 10 |

Payloads cannot contain class instances, functions, accessors, symbols,
`undefined`, cyclic values, or non-finite numbers.

## Run handlers after commit

`ReactionRunner` performs one bounded delivery pass. Call `runOnce()` from a
host scheduler, queue wake, process loop, cron event, or Durable Object alarm.
The runner does not start a timer or background task itself.

```ts
import {
  PermanentReactionError,
  ReactionRunner,
} from '@syncular/server';

const runner = new ReactionRunner<AppReactions>({
  storage,
  partition: 'tenant-42',
  workerId: 'invoice-email-worker-1',
  batchSize: 10,
  leaseDurationMs: 30_000,
  handlers: {
    'invoice.email': async ({
      version,
      payload,
      idempotencyKey,
      extendLease,
    }) => {
      if (version !== 1) {
        throw new PermanentReactionError('invoice.email_version_unsupported', {
          version,
        });
      }

      await extendLease();
      await emailProvider.sendInvoice({
        invoiceId: payload.invoiceId,
        customerId: payload.customerId,
        idempotencyKey,
      });
    },
  },
});

const result = await runner.runOnce();
console.log(result);
// { claimed, completed, retried, deadLettered, lostLeases }
```

The runner claims only types present in `handlers`. Each `runOnce()` call uses
a fresh lease token. Before starting each handler in the claimed batch, it
renews that row and skips it if another worker reclaimed the expired lease.
Completion, failure, and explicit lease extension also compare the token.

Call `extendLease()` before the current lease expires when a handler has a long
phase. Repeat it as the work progresses when one extension is insufficient. A
handler that runs past its lease can overlap with a later delivery.

Use a separate runner per partition. This keeps tenant isolation and the
per-partition commit model intact. Several runners may process one partition;
their atomic claims normally return disjoint records.

## Classify failures

An ordinary exception and `RetryableReactionError` schedule another attempt.
The delay is bounded exponential backoff, starting at one second and capped at
five minutes by default.

```ts
import {
  PermanentReactionError,
  RetryableReactionError,
} from '@syncular/server';

if (response.status === 429 || response.status >= 500) {
  throw new RetryableReactionError('invoice.email_provider_unavailable', {
    status: response.status,
  });
}

if (response.status === 400) {
  throw new PermanentReactionError('invoice.email_invalid_request', {
    status: response.status,
  });
}
```

A permanent error enters `dead-letter` immediately. A retryable error enters
`dead-letter` after `maxAttempts`. Persisted failure information contains a
stable code, failure time, and optional plain JSON details limited to 8 KiB.
Syncular does not persist the raw exception message.

Manual retry is an explicit operator action:

```ts
import { retryDeadLetterReaction } from '@syncular/server';

const reset = await retryDeadLetterReaction({
  storage,
  partition: 'tenant-42',
  idempotencyKey,
});
```

The reset clears attempts and failure information and makes the reaction due.
There is no unauthenticated or automatic retry endpoint.

## Understand the crash window

The external effect and Syncular's completion update usually live in different
systems. They cannot share one transaction:

1. A worker claims a reaction.
2. The handler calls the external provider successfully.
3. The process stops before `completeReaction` commits.
4. The lease expires and another worker calls the handler again.

Both calls receive the same `idempotencyKey`. The provider or application
receipt table must collapse the repeated request when one real-world effect is
required. Syncular does not claim exactly-once external execution.

## Observe and inspect reactions

Configure `SyncularServerEvents` to receive these lifecycle events:

| Event | Meaning |
|---|---|
| `reaction.queued` | The source transaction committed the reaction |
| `reaction.started` | A worker confirmed its lease and began an attempt |
| `reaction.retried` | A retryable failure recorded its next due time |
| `reaction.completed` | The current lease owner acknowledged success |
| `reaction.dead_lettered` | A permanent or exhausted failure stopped delivery |
| `reaction.prune_completed` | One bounded terminal-retention pass finished |

Events remain a fire-and-forget observability surface. Reaction storage is the
durable source of lifecycle state.

`SyncularAdmin` provides partition-scoped reads:

```ts
const failed = await admin.listReactions('tenant-42', {
  statuses: ['dead-letter'],
  types: ['invoice.email'],
  limit: 50,
});
```

The authenticated Hono admin routes expose the same data at
`GET /admin/reactions?status=dead-letter&type=invoice.email&limit=50` when the
admin app is mounted at `/admin`. The response includes persisted payloads and
failure details. Treat access as application-data access and keep limits small
when payloads are large.

## Storage and migrations

SQLite and PostgreSQL create `sync_reactions` and its indexes through their
normal storage migration path. D1 construction does not apply DDL during a
request. Regenerate the shared SQLite/D1 migration from
`sqliteDdlStatements()` and apply it before enabling a planner.

D1 source pushes still require the per-partition Durable Object coordinator.
Reaction records join the same atomic `D1Database.batch()` as the source
commit. Delivery claims use one `UPDATE ... RETURNING` statement and fail if
the runtime cannot execute that statement atomically. See
[Cloudflare Workers](/server-workers/) for the coordinator and migration
wiring.

Commit-log pruning never deletes reactions in any lifecycle state. Schedule
`pruneReactions` separately for every partition:

```ts
import { pruneReactions } from '@syncular/server';

let result;
do {
  result = await pruneReactions({
    storage,
    partition: 'tenant-42',
    nowMs: Date.now(),
    events,
    retention: {
      completedRetentionMs: 30 * 24 * 60 * 60 * 1000,
      deadLetterRetentionMs: 90 * 24 * 60 * 60 * 1000,
      batchSize: 1000,
    },
  });
} while (result.mayHaveMore);
```

Those values are the defaults. A pass removes at most `batchSize` terminal
rows. It deletes a `completed` row only when `completedAtMs` is strictly older
than the completed cutoff. It deletes a `dead-letter` row only when its failure
time is strictly older than the dead-letter cutoff. Pending and leased rows,
including expired leases, are never eligible.

The longer dead-letter window preserves failure diagnostics and the manual
retry opportunity. Lower it only when another system retains the information
operators need. Cleanup and manual retry are atomic storage operations, so a
race either resets the row or removes it. `reaction.prune_completed` reports
the cutoffs, limit, removal counts, and `mayHaveMore` value for each pass.

## Performance boundaries

Reaction durability adds work to the source commit. Each record is normalized,
serialized, inserted, and indexed before acknowledgement. Keep payloads small
and avoid using the 100-record limit as a normal batch size.

PostgreSQL currently inserts planned reactions one statement at a time. D1
adds one statement per reaction to the transaction batch; include those
statements when checking the
[current D1 limits](https://developers.cloudflare.com/d1/platform/limits/).
SQLite lifecycle writes share its serialized connection with pushes. Large
backlogs or slow planners can therefore increase push and worker latency.

A successful delivery uses the batch claim plus an ownership-confirmation
write and a completion write for each record. Long handlers add lease-extension
writes. Choose `batchSize` and polling frequency from handler duration and
database capacity.

Terminal cleanup uses timestamp indexes and bounded deletes. Run passes until
`mayHaveMore` is false, then wait for the next scheduled interval. A result can
conservatively report `mayHaveMore: true` when the final full batch emptied the
backlog, which causes one harmless empty pass.

## Testing checklist

Use a virtual clock and deterministic promises around handlers. Tests should
cover:

- source commit and reaction enqueue commit or roll back together;
- rejected and conflicted commits enqueue nothing;
- replay of the same client commit does not plan twice;
- retry due times and attempt exhaustion;
- permanent failure and operator reset;
- lease expiry after a worker stops;
- repeated delivery after the handler succeeds and acknowledgement fails;
- concurrent workers and stale claimed-batch members;
- commit-log pruning with pending work;
- terminal cleanup bounds, strict cutoffs, and active-row preservation;
- the same storage contract on SQLite, PostgreSQL, and D1.

The repository examples are in
[`packages/server/test/reactions.test.ts`](https://github.com/syncular/syncular/blob/main/packages/server/test/reactions.test.ts)
and
[`packages/server/test/storage-contract.ts`](https://github.com/syncular/syncular/blob/main/packages/server/test/storage-contract.ts).

## Choosing the server mechanism

Use a durable reaction when work derives from an accepted Syncular commit and
must execute under server ownership. Use an immutable application row when
history must sync to clients or support relational queries. Use a normal
`SyncClient` when the worker needs a local replica, subscriptions, or its own
outbox.
