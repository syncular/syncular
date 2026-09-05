---
title: 'After the Offline Write: Durable Server Work in Syncular'
description: A technician finishes a repair offline. Follow the work order and service report through server acceptance, a queued customer email, and recovery after a worker crash.
author: Benjamin Kniffler
publishedAt: '2026-09-05'
---

# After the Offline Write: Durable Server Work in Syncular

A technician replaces a broken pump in a basement with no mobile signal. They mark work order #184 complete and write the service report on their phone. The app saves both locally. Once the phone reconnects, the office should see the finished job and the customer should receive the report by email.

If the server saves the completed job and then crashes before sending the email, the office sees no work left to do. The customer is still waiting for the report. Retrying the email has its own failure case: the provider might have accepted it before the worker crashed.

I've been working on this part of Syncular: what runs on the server after a device's changes arrive. Syncular is an open-source sync engine that keeps local SQLite databases in sync with your server. My [previous post](/blog/offline-first-writes/) covered saving offline writes and getting them accepted. This one follows the work order through acceptance, report delivery, and recovery after a worker stops.

The example uses three application tables: `work_orders`, `service_reports`, and `domain_events`. A partner's maintenance system can submit the same completion through a webhook, which I'll cover toward the end.

## Save the completed job with its report

A work order's status tells the office whether the job is complete. The service report records what the technician did. An immutable `work_order_completed` event connects that completion to the report the customer should receive.

The client updates the work order and inserts the report and event in one `mutate()` call. A domain event is an ordinary application row that records an action. Here, its payload holds the report ID, so delivery can find the report for this completion even if somebody later reopens the work order.

<details>
<summary>Show the work order schema and completion mutation</summary>

This is an illustrative application schema. Declare the same `organization:{organization_id}` scope for all three tables using the [schema configuration](/guide-schema/).

```sql
CREATE TABLE work_orders (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  customer_id TEXT NOT NULL,
  status TEXT NOT NULL,
  updated_at_ms BIGINT NOT NULL
);

CREATE TABLE service_reports (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  work_order_id TEXT NOT NULL,
  summary TEXT NOT NULL,
  completed_at_ms BIGINT NOT NULL
);

CREATE TABLE domain_events (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  aggregate_type TEXT NOT NULL,
  aggregate_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  occurred_at_ms BIGINT NOT NULL,
  payload JSON NOT NULL
);
```

Here, `client` is an initialized `SyncClient`, `workOrder` is the full local work order row, and `reportSummary` is the technician's report text.

```ts
const reportId = crypto.randomUUID();
const eventId = crypto.randomUUID();
const occurredAtMs = Date.now();

const commitId = client.mutate([
  {
    table: 'work_orders',
    op: 'upsert',
    values: {
      ...workOrder,
      status: 'completed',
      updated_at_ms: occurredAtMs,
    },
  },
  {
    table: 'service_reports',
    op: 'upsert',
    values: {
      id: reportId,
      organization_id: workOrder.organization_id,
      work_order_id: workOrder.id,
      summary: reportSummary,
      completed_at_ms: occurredAtMs,
    },
  },
  {
    table: 'domain_events',
    op: 'upsert',
    values: {
      id: eventId,
      organization_id: workOrder.organization_id,
      aggregate_type: 'work_order',
      aggregate_id: workOrder.id,
      event_type: 'work_order_completed',
      occurred_at_ms: occurredAtMs,
      payload: JSON.stringify({ reportId }),
    },
  },
]);
```

The IDs are generated once for this action. The local outbox retains the commit when the connection fails; retrying it does not rerun this UI code.

</details>

The client persists the optimistic rows and the outbox entry in one local transaction. The server later accepts or rejects the complete commit. Configure a whole-commit validator to require a new report and completion event when a work order changes to `completed`. Check that the report belongs to that work order and that the event names that report. The [domain event guide](/guide-domain-events/) shows this validation pattern with a different application schema.

Make accepted reports and events immutable with table validators. A correction creates a new report and event, preserving what the earlier email referred to. All three tables share the organization's access boundary.

The phone should show the completion as pending sync until the server accepts it. If the work order was cancelled while the technician was offline, the server's business rules decide whether to reject the completion. A rejection leaves no queued report email. The [concurrency and correction guide](/guide-concurrency-correction/) covers how the app presents and resolves rejected writes.

## Queue the report email with the accepted job

Sending the report email in a validator would let it escape before the database transaction commits. Sending it after the transaction without first recording the work leaves the crash window from the opening example.

This is the transactional outbox pattern. A [durable server reaction](/server-reactions/) records the pending report email in that transaction. The application supplies a `reactionPlanner` that examines the candidate commit after validation and returns small JSON records. Syncular commits those records with the application rows, commit log, and idempotency result. If the transaction rolls back, all of them roll back.

<figure>
  <img src="/blog/service-report-transaction.svg" width="480" height="1040" alt="A technician completes pump repair #184 offline and saves its report. On reconnect, the server accepts the completed work order, report R184, completion event, and pending report email in one transaction. The office sees job #184 complete. A worker submits report R184 to the email provider for the customer." />
  <figcaption>Work order #184 and its report email follow the same completion. The office can see an accepted job while its email is still queued. <a href="/blog/service-report-transaction.svg">Open the full-size diagram</a>.</figcaption>
</figure>

The planner selects newly inserted `work_order_completed` events. The event ID is enough for a handler that loads the accepted event and the immutable report it references.

```ts
import type { ReactionPlanner } from '@syncular/server';

type ServiceReactions = {
  'service_report.email': { eventId: string };
};

const reactionPlanner: ReactionPlanner<ServiceReactions> = ({ operations }) =>
  operations.flatMap((operation) => {
    if (
      operation.table !== 'domain_events' ||
      operation.op !== 'upsert' ||
      operation.stored !== undefined ||
      operation.row?.event_type !== 'work_order_completed'
    ) {
      return [];
    }

    const eventId = operation.row.id;
    if (typeof eventId !== 'string') {
      throw new Error('app.invalid_completion_event');
    }

    return [
      {
        key: `report-email:${eventId}`,
        type: 'service_report.email',
        version: 1,
        payload: { eventId },
        maxAttempts: 8,
      },
    ];
  });
```

Pass `reactionPlanner` into the existing [server configuration](/server-reactions/#add-the-planner-to-the-server). It must finish without calling the email provider. The source transaction is still open while the planner runs, so a slow planner also delays the original write.

A queued reaction containing only an event ID depends on both the event and its report still existing when delivery runs. Retain them through the delivery and retry period, or put the required immutable values into the reaction payload. Building the email from the current work order could pick up edits made after this completion.

A replay of an applied client commit returns its cached result and skips the planner. Syncular therefore records one reaction for that commit and planner key. The [planning tests](https://github.com/syncular/syncular/blob/main/packages/server/test/reactions.test.ts) exercise rollback, rejection, and overlapping duplicate pushes.

## Let a worker deliver it

[`ReactionRunner`](https://github.com/syncular/syncular/blob/main/packages/server/src/reactions.ts#L400) claims committed reactions and calls their handlers. Each claim has a lease: a period during which that worker owns the delivery attempt. If the worker stops, another worker can reclaim the record after the lease expires.

The application schedules `runOnce()`, for example from a process loop or a queue wake. Constructing a runner does not start background delivery.

```ts
import { PermanentReactionError, ReactionRunner } from '@syncular/server';

const runner = new ReactionRunner<ServiceReactions>({
  storage,
  partition: 'tenant-42',
  workerId: 'report-email-1',
  handlers: {
    'service_report.email': async ({
      payload,
      version,
      idempotencyKey,
      extendLease,
    }) => {
      if (version !== 1) {
        throw new PermanentReactionError('app.report_email_version_unsupported');
      }

      await extendLease();
      await reports.emailFromEvent({
        eventId: payload.eventId,
        idempotencyKey,
      });
    },
  },
});

await runner.runOnce();
```

`storage` is the server's configured storage adapter. `reports.emailFromEvent()` is application code: it loads the accepted event and its report, resolves the work order's customer, and submits the report email to the provider. It must throw on failure and forward the idempotency key when the provider supports one. Persist the recipient and rendered email before the first provider call, then reuse that exact request on retries. A long handler needs to [extend its lease before expiry](/server-reactions/#run-handlers-after-commit).

After a successful handler call, the runner records completion. Ordinary exceptions schedule another attempt with bounded backoff. Permanent errors, or exhaustion of the configured attempts, leave a `dead-letter` record for an operator to inspect and explicitly retry. Work order #184 remains complete even if its report email exhausts all attempts. Completing the reaction means the provider accepted the email; delivery to the customer's inbox still depends on the provider. Track bounces separately if the office needs that status.

## Stop the process at different points

I find this easier to reason about by interrupting the same operation in a few places. Expand a failure point to follow its recovery.

<details>
<summary>The server stops before the source transaction commits</summary>

The completed work order, report, event, and pending email do not commit. The device still holds its outbox entry and can retry. No worker can claim an uncommitted reaction.

</details>

<details>
<summary>The commit succeeds, but its response never reaches the device</summary>

The device sends the same commit again. The server returns the stored outcome and skips reaction planning. The reaction already recorded by the first delivery remains available to the worker.

</details>

<details open>
<summary>The provider accepts the message, then the worker stops</summary>

The reaction still looks unfinished because the worker stopped before recording completion. After the lease expires, another worker can call the provider again. It receives the same idempotency key. The provider must recognize that key for the repeated call to produce only one report email.

</details>

<figure>
  <img src="/blog/notification-retry.svg" width="480" height="1000" alt="Worker A submits report R184 for pump repair #184 using key K. The provider accepts the report email, but worker A stops before recording completion. Work order #184 stays complete while its email reaction is unfinished. After lease expiry, worker B submits the same report with key K. A provider retaining K returns the earlier result without creating another email, and worker B completes the reaction." />
  <figcaption>The retry still refers to report R184 for work order #184. The provider must retain the key to avoid creating a second email. <a href="/blog/notification-retry.svg">Open the full-size diagram</a>.</figcaption>
</figure>

This is at-least-once delivery. The external provider and Syncular's database cannot usually share a transaction, so there is an interval in which the provider knows it accepted a request and Syncular does not. A local “sent” flag written after the provider call has the same gap.

Syncular derives the handler's idempotency key from the partition, source client, source commit, and planner key. Use that supplied key for every attempt. The provider's deduplication retention must cover your retry period, including manual retries; a key the provider has forgotten cannot prevent another send. If the provider has no deduplication contract, the application must account for possible duplicate report emails.

The repository has a [crash-after-delivery test](https://github.com/syncular/syncular/blob/main/packages/server/test/reactions.test.ts#L442) that interrupts acknowledgement, advances a virtual clock past lease expiry, and runs another worker. It asserts two handler calls with the same key. It cannot prove what an external email provider will do with those calls.

## Bring webhooks and jobs through the same write path

A subcontractor might complete the repair in their own maintenance system. Its webhook needs to submit the completed work order and report through the same server checks. It doesn't need to maintain a local copy of the office's job list.

[`SyncRemoteClient`](/guide-remote-operations/) submits ordinary commits without a local database. The webhook can prepare the same work order, report, and event mutations, then retain the prepared bytes with its job before sending them:

```ts
let prepared = await jobs.loadPreparedCommit(webhook.id);
if (prepared === undefined) {
  prepared = await remote.prepareCommit({
    requestId: webhook.id,
    mutations: completionMutations,
  });
  await jobs.savePreparedCommit(prepared);
}

const outcome = await remote.sendCommit(prepared);
```

Here, `remote` is the [configured remote client](/guide-remote-operations/#construct-the-client), and `completionMutations` contains the three row operations. The application's `jobs` store serializes work for each webhook ID and persists the prepared `{ requestId, bytes }` before the first send. A retry loads that saved commit. Reconstructing it could change its timestamps, event ID, or encryption nonces. The remote client has no outbox to retain them for you.

Ordinary remote commits go through the same server push path as device commits, including reaction planning. The caller receives an `applied`, `cached`, or `rejected` result directly. Rejected results include per-operation evidence, such as a conflict, that the caller uses to decide what to do next.

Other integrations need different capabilities:

| Work the process needs to do | Surface to use |
| --- | --- |
| Retain local SQL data and queue writes across restarts | [Server-side `SyncClient`](/guide-server-clients/) with a persistent SQLite file |
| Submit row changes from a webhook or job | `SyncRemoteClient.prepareCommit()` and `sendCommit()` |
| Read an authoritative report | A [registered query](/guide-remote-operations/#registered-typed-queries) |
| Choose mutations using privileged server reads | A [server-authoritative command](/guide-remote-operations/#server-authoritative-commands) |
| Refresh a connected report when data changes | A [live query watch](/guide-remote-operations/#live-query-watches) |
| Retain notification work after an accepted commit | A durable server reaction |

Commands are useful when the server must choose the operation, such as assigning the next work order using current technician availability. Their returned mutations still pass normal write authorization and validation. External calls belong in the resulting reaction handler; putting them inside the command callback recreates the earlier transaction problem.

A live query watch sends replacement snapshots while connected. Use it to refresh the office's job list. Notifications that must survive a disconnection need retained work, such as a reaction or an event consumer with durable receipts.

## Show the office which reports still need attention

The office needs separate answers for whether the repair is complete and whether its report email was accepted by the provider. For work order #184, a failed email should remain visible after the job leaves the list of unfinished repairs. Staff can inspect the failure and retry the unchanged email request. Correcting the recipient requires a new email request with a new idempotency key.

The [reaction admin API](/server-reactions/#observe-and-inspect-reactions) exposes persisted status, payload, and failure details per partition. An authenticated operations screen can list dead letters and offer an explicit retry. If the job list also needs report email status, write an application status row through a normal Syncular commit so authorized replicas receive it.

Schedule [reaction cleanup](/server-operations/#reaction-retention) separately from commit-log pruning. Keep domain events and service reports long enough for handlers that read them. These are deployment responsibilities, along with driving the runner and checking the provider's idempotency behavior.

For a first implementation, start with the work order schema above, apply the [domain event validation pattern](/guide-domain-events/), then add the [planner and runner](/server-reactions/). Exercise the lost-response and worker-crash cases before connecting a real provider. The [reaction tests](https://github.com/syncular/syncular/blob/main/packages/server/test/reactions.test.ts) and [remote client tests](https://github.com/syncular/syncular/blob/main/packages/web-client/test/remote.test.ts) show how to force those failures without wall-clock sleeps.
