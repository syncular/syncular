---
title: 'After the Offline Write: Durable Server Work in Syncular'
description: Follow an offline appointment change through server acceptance, a durable notification, and a worker crash. Domain events, reactions, and remote clients in Syncular.
author: Benjamin Kniffler
publishedAt: '2026-09-05'
---

# After the Offline Write: Durable Server Work in Syncular

A receptionist moves an appointment from Tuesday to Thursday while the clinic's connection is down. The calendar updates immediately. When the connection returns, the server accepts the change. The patient still needs a notification.

Now stop the server between saving the appointment and sending that message.

The calendar says Thursday. The patient is still planning for Tuesday. Every replica can agree on the appointment and the application can still have unfinished work.

In my [last post](/blog/offline-first-writes/), I followed writes from local persistence to server acceptance. The August work takes them further: durable server reactions handle follow-up work, and remote clients let jobs and webhooks submit their own changes. Both fit around a documented pattern for recording domain actions alongside the rows they change.

I'll use the clinic example from the docs, with `appointments`, the associated `reservations`, and `domain_events`. Syncular keeps local SQLite replicas in sync with a server that authorizes and validates their writes. The [architecture overview](/what-is/) covers that setup.

## Keep the action with the appointment

An appointment row tells us when the visit is scheduled. It doesn't tell us whether someone rescheduled it, corrected a typo, or imported it from another calendar. Those actions could need different follow-up work.

For this example, the client updates the appointment and its reservation and inserts an `appointment_rescheduled` event row in one `mutate()` call. A domain event is an ordinary application row that records what happened. Its ID identifies the action; its payload can preserve the previous and new appointment times.

<details>
<summary>Show the state-and-event mutation</summary>

Here, `client` is an initialized `SyncClient`; `appointment` and `reservation` are the full local rows from the [clinic schema](/guide-domain-events/#schema). `newStartsAtMs` is the time selected in the UI.

```ts
const eventId = crypto.randomUUID();
const occurredAtMs = Date.now();

const commitId = client.mutate([
  {
    table: 'appointments',
    op: 'upsert',
    values: {
      ...appointment,
      starts_at_ms: newStartsAtMs,
      updated_at_ms: occurredAtMs,
    },
  },
  {
    table: 'reservations',
    op: 'upsert',
    values: {
      ...reservation,
      starts_at_ms: newStartsAtMs,
      updated_at_ms: occurredAtMs,
    },
  },
  {
    table: 'domain_events',
    op: 'upsert',
    values: {
      id: eventId,
      clinic_id: appointment.clinic_id,
      aggregate_type: 'appointment',
      aggregate_id: appointment.id,
      event_type: 'appointment_rescheduled',
      occurred_at_ms: occurredAtMs,
      payload: JSON.stringify({
        previousStartsAtMs: appointment.starts_at_ms,
        startsAtMs: newStartsAtMs,
      }),
    },
  },
]);
```

The IDs are generated once for this action. The local outbox retains the commit when the connection fails; retrying it does not rerun this UI code.

</details>

The client persists the optimistic rows and the outbox entry in one local transaction. The server later accepts or rejects the complete commit. A [whole-commit validator](/guide-domain-events/#require-the-event-with-commitvalidator) can require the matching reservation and event whenever the appointment time changes. A table validator makes existing event rows immutable. All three tables use the same clinic scope, so the event follows the appointment's access boundary.

The current appointment remains the read model. Event rows preserve application history alongside it, for as long as the application retains them.

It also leaves business rules with the application. An offline reschedule is provisional. If booking a slot requires checking authoritative availability, enforce that rule on the server. The event row does not prevent a double booking by itself. The [concurrency and correction guide](/guide-concurrency-correction/) covers those decisions.

## Save the notification work before acknowledging the commit

Sending a notification in a validator would let it escape before the database transaction commits. Sending it after the transaction without first recording the work leaves the crash window from the opening example.

A [durable server reaction](/server-reactions/) records pending work in that transaction. The application supplies a `reactionPlanner` that examines the candidate commit after validation and returns small JSON records. Syncular commits those records with the application rows, commit log, and idempotency result. If the transaction rolls back, all of them roll back.

<figure>
  <img src="/blog/appointment-transaction.svg" width="480" height="660" alt="The device saves rows and an outbox entry locally. After reconnecting, one server transaction saves the appointment, reservation, event, reaction, commit log, and idempotency result. A worker calls the notification provider only after that transaction commits." />
  <figcaption>The server saves pending notification work before acknowledging the write. The provider call happens in a separate step. <a href="/blog/appointment-transaction.svg">Open the full-size diagram</a>.</figcaption>
</figure>

For the clinic, the planner selects newly inserted reschedule events. The event ID is enough for a handler that will load the accepted event and build the message from its payload.

```ts
import type { ReactionPlanner } from '@syncular/server';

type ClinicReactions = {
  'appointment.notify_rescheduled': { eventId: string };
};

const reactionPlanner: ReactionPlanner<ClinicReactions> = ({ operations }) =>
  operations.flatMap((operation) => {
    if (
      operation.table !== 'domain_events' ||
      operation.op !== 'upsert' ||
      operation.stored !== undefined ||
      operation.row?.event_type !== 'appointment_rescheduled'
    ) {
      return [];
    }

    const eventId = operation.row.id;
    if (typeof eventId !== 'string') {
      throw new Error('app.invalid_reschedule_event');
    }

    return [
      {
        key: `notify:${eventId}`,
        type: 'appointment.notify_rescheduled',
        version: 1,
        payload: { eventId },
        maxAttempts: 8,
      },
    ];
  });
```

Pass `reactionPlanner` into the existing [server configuration](/server-reactions/#add-the-planner-to-the-server). It must finish without calling the notification provider. The source transaction is still open while the planner runs, so a slow planner also delays the original write.

A queued reaction containing only an event ID depends on that event still existing when delivery runs. Retain the event through the delivery and retry period, or put the required immutable values into the reaction payload. Loading the current appointment instead could produce a message about a later reschedule.

A replay of an applied client commit returns its cached result and skips the planner. Syncular therefore records one reaction for that commit and planner key. The [planning tests](https://github.com/syncular/syncular/blob/main/packages/server/test/reactions.test.ts) exercise rollback, rejection, and overlapping duplicate pushes.

## Let a worker deliver it

[`ReactionRunner`](https://github.com/syncular/syncular/blob/main/packages/server/src/reactions.ts#L400) claims committed reactions and calls their handlers. Each claim has a lease: a period during which that worker owns the delivery attempt. If the worker stops, another worker can reclaim the record after the lease expires.

The application schedules `runOnce()`, for example from a process loop or a queue wake. Constructing a runner does not start background delivery.

```ts
import { PermanentReactionError, ReactionRunner } from '@syncular/server';

const runner = new ReactionRunner<ClinicReactions>({
  storage,
  partition: 'tenant-42',
  workerId: 'clinic-notifications-1',
  handlers: {
    'appointment.notify_rescheduled': async ({
      payload,
      version,
      idempotencyKey,
      extendLease,
    }) => {
      if (version !== 1) {
        throw new PermanentReactionError('app.notify_version_unsupported');
      }

      await extendLease();
      await notifications.sendRescheduleFromEvent({
        eventId: payload.eventId,
        idempotencyKey,
      });
    },
  },
});

await runner.runOnce();
```

`storage` is the server's configured storage adapter. `notifications.sendRescheduleFromEvent()` is application code: it loads the accepted event, resolves the recipient, and calls the provider. It must throw on failure and forward the idempotency key when the provider supports one. A long handler needs to [extend its lease before expiry](/server-reactions/#run-handlers-after-commit).

After a successful handler call, the runner records completion. Ordinary exceptions schedule another attempt with bounded backoff. Permanent errors, or exhaustion of the configured attempts, leave a `dead-letter` record for an operator to inspect and explicitly retry. The appointment remains accepted while notification delivery is pending or has failed.

## Stop the process at different points

I find this easier to reason about by interrupting the same operation in a few places. Expand a failure point to follow its recovery.

<details>
<summary>The server stops before the source transaction commits</summary>

The appointment change and pending reaction do not commit. The device still holds its outbox entry and can retry. No worker can claim an uncommitted reaction.

</details>

<details>
<summary>The commit succeeds, but its response never reaches the device</summary>

The device sends the same commit again. The server returns the stored outcome and skips reaction planning. The reaction already recorded by the first delivery remains available to the worker.

</details>

<details open>
<summary>The provider accepts the message, then the worker stops</summary>

The reaction still looks unfinished because the worker stopped before recording completion. After the lease expires, another worker can call the provider again. It receives the same idempotency key. The provider must recognize that key for the repeated call to produce only one notification.

</details>

<figure>
  <img src="/blog/notification-retry.svg" width="480" height="670" alt="Worker A calls the provider with key K. The provider accepts the message, but worker A crashes before recording completion. After lease expiry, worker B calls with the same key K. A provider honoring that key returns the prior result, then worker B records completion." />
  <figcaption>Two handler calls can refer to one notification. Collapsing them depends on the provider's idempotency contract. <a href="/blog/notification-retry.svg">Open the full-size diagram</a>.</figcaption>
</figure>

This is at-least-once delivery. The external provider and Syncular's database cannot usually share a transaction, so there is an interval in which the provider knows it accepted a request and Syncular does not. A local “sent” flag written after the provider call has the same gap.

Syncular derives the handler's idempotency key from the partition, source client, source commit, and planner key. Use that supplied key for every attempt. The provider's deduplication retention must cover your retry period, including manual retries; a key the provider has forgotten cannot prevent another send. If the provider has no deduplication contract, the application must account for possible duplicate notifications.

The repository has a [crash-after-delivery test](https://github.com/syncular/syncular/blob/main/packages/server/test/reactions.test.ts#L442) that interrupts acknowledgement, advances a virtual clock past lease expiry, and runs another worker. It asserts two handler calls with the same key. It cannot prove what an external email provider will do with those calls.

## Bring webhooks and jobs through the same write path

A scheduling integration might originate the reschedule through a webhook. It needs authorization, validation, and retry handling too, but it doesn't necessarily need a local calendar replica.

[`SyncRemoteClient`](/guide-remote-operations/) submits ordinary commits without a local database. The webhook can prepare the same appointment, reservation, and event mutations, then retain the prepared bytes with its job before sending them:

```ts
let prepared = await jobs.loadPreparedCommit(webhook.id);
if (prepared === undefined) {
  prepared = await remote.prepareCommit({
    requestId: webhook.id,
    mutations: rescheduleMutations,
  });
  await jobs.savePreparedCommit(prepared);
}

const outcome = await remote.sendCommit(prepared);
```

Here, `remote` is the [configured remote client](/guide-remote-operations/#construct-the-client), and `rescheduleMutations` contains the three row operations. The application's `jobs` store serializes work for each webhook ID and persists the prepared `{ requestId, bytes }` before the first send. A retry loads that saved commit. Reconstructing it could change its timestamps, event ID, or encryption nonces. The remote client has no outbox to retain them for you.

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

Commands are useful when the server must choose the operation, such as confirming a booking against current availability. Their returned mutations still pass normal write authorization and validation. External calls belong in the resulting reaction handler; putting them inside the command callback recreates the earlier transaction problem.

A live query watch sends replacement snapshots while connected. Use it to refresh the clinic's operations screen. Notifications that must survive a disconnection need retained work, such as a reaction or an event consumer with durable receipts.

## Give the clinic a way to find failed notifications

The calendar can show an accepted appointment even when its notification has exhausted all attempts. Someone needs to see that failure and decide whether to retry, contact the patient another way, or correct the recipient details.

The [reaction admin API](/server-reactions/#observe-and-inspect-reactions) exposes persisted status, payload, and failure details per partition. An authenticated operations screen can list dead letters and offer an explicit retry. If the patient-facing UI also needs notification status, write an application status row through a normal Syncular commit so authorized replicas receive it.

Schedule [reaction cleanup](/server-operations/#reaction-retention) separately from commit-log pruning. Keep domain events long enough for handlers that read them. These are deployment responsibilities, along with driving the runner and checking the provider's idempotency behavior.

For a first implementation, use the [clinic schema and validators](/guide-domain-events/), then add the [planner and runner](/server-reactions/). Exercise the lost-response and worker-crash cases before connecting a real provider. The [reaction tests](https://github.com/syncular/syncular/blob/main/packages/server/test/reactions.test.ts) and [remote client tests](https://github.com/syncular/syncular/blob/main/packages/web-client/test/remote.test.ts) show how to force those failures without wall-clock sleeps.
