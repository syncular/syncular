# Domain actions and event rows

Row changes describe state and say little about why the state changed. A
reservation time moves because a patient rescheduled, a clinician changed
availability, or an operator repaired bad data, and a consumer that infers the
action from the changed columns will eventually misclassify one of them. This
page is for developers whose consumers need the action itself. You finish with
state rows and one immutable event row written in a single commit, a server
validator that requires the event, and a consumption rule for the event.

::meta{for="App developers with downstream consumers of changes" time="20 minutes" first="concepts-commits" spec="6"}

:::terms
- **Domain event**: An immutable row that records one business action, such as `appointment_rescheduled`.
- **Aggregate**: The state rows and the event row that one action writes together.
- **Commit validator**: A server hook that accepts or rejects a whole candidate commit.
- **Event ID**: The event row's primary key, which doubles as the consumer's idempotency key.
:::

:::figure{title="One action, one commit" note="State and event land together or not at all" ticks}
<div class="d-row">
<div class="d-stack">
<div class="node hot"><span class="t">appointments</span>starts_at_ms updated</div>
<div class="node hot"><span class="t">reservations</span>starts_at_ms updated</div>
<div class="node ok"><span class="t">domain_events</span>appointment_rescheduled</div>
</div>
<span class="d-arrow"></span>
<div class="node"><span class="t">One mutate([...])</span>One outbox commit, retried under one idempotency key</div>
<span class="d-arrow"></span>
<div class="node cool"><span class="t">Server transaction</span>Rows, commit-log entry, and idempotency result commit together; a rejection rolls all of it back</div>
</div>

::caption[The event row syncs to every replica that holds the scope, so the event follows the same authorization boundary as the state it describes.]
:::

## Steps

:::::steps
::::step{title="Declare state and event tables in one scope" time="3 min"}
This example keeps appointments, reservations, and domain events in the same
clinic scope:

```sql
CREATE TABLE appointments (
  id TEXT PRIMARY KEY,
  clinic_id TEXT NOT NULL,
  reservation_id TEXT NOT NULL,
  starts_at_ms BIGINT NOT NULL,
  updated_at_ms BIGINT NOT NULL
);

CREATE TABLE reservations (
  id TEXT PRIMARY KEY,
  clinic_id TEXT NOT NULL,
  starts_at_ms BIGINT NOT NULL,
  updated_at_ms BIGINT NOT NULL
);

CREATE TABLE domain_events (
  id TEXT PRIMARY KEY,
  clinic_id TEXT NOT NULL,
  aggregate_type TEXT NOT NULL,
  aggregate_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  occurred_at_ms BIGINT NOT NULL,
  payload JSON NOT NULL
);
```

Declare the same `clinic:{clinic_id}` scope pattern for all three tables in
`syncular.json`. Event rows then follow the same authorization boundary as the
state they describe ([Schema & typegen](/guide-schema/)).

::checkpoint[`syncular generate` succeeds and the generated schema lists `domain_events` beside the two state tables.]
::::

::::step{title="Write the state and the action together" time="3 min"}
Generate the event ID once and keep it with the logical action. The local outbox
retains the commit across retries.

```ts
const occurredAtMs = Date.now();
const eventId = crypto.randomUUID();

const commitId = client.mutate([
  {
    table: 'appointments',
    op: 'upsert',
    values: {
      id: appointment.id,
      clinic_id: appointment.clinicId,
      reservation_id: appointment.reservationId,
      starts_at_ms: newStartsAtMs,
      updated_at_ms: occurredAtMs,
    },
  },
  {
    table: 'reservations',
    op: 'upsert',
    values: {
      id: appointment.reservationId,
      clinic_id: appointment.clinicId,
      starts_at_ms: newStartsAtMs,
      updated_at_ms: occurredAtMs,
    },
  },
  {
    table: 'domain_events',
    op: 'upsert',
    values: {
      id: eventId,
      clinic_id: appointment.clinicId,
      aggregate_type: 'appointment',
      aggregate_id: appointment.id,
      event_type: 'appointment_rescheduled',
      occurred_at_ms: occurredAtMs,
      payload: JSON.stringify({
        reservationId: appointment.reservationId,
        previousStartsAtMs: appointment.startsAtMs,
        startsAtMs: newStartsAtMs,
      }),
    },
  },
]);
```

`crypto.randomUUID()` is stable for retries of this durable local commit. If the
action originates from a retried webhook or job, derive the event ID from that
upstream request ID, or persist the generated ID with the job.

The three operations form one Syncular commit. The server applies every row, the
commit-log entry, and the idempotency result in one storage transaction. A
rejection or a conflict rolls the complete commit back.

::checkpoint[`client.pendingCommits()` lists one commit that holds three operations.]
::::

::::step{title="Require the event with a commit validator" time="5 min"}
A client bug could update the appointment without inserting its event. A
whole-commit validator rejects that shape before the transaction commits:

```ts
import {
  CommitValidationRejection,
  type CommitValidator,
} from '@syncular/server';

export const requireAppointmentEvents: CommitValidator = ({ operations }) => {
  const appointments = operations.filter(
    (operation) =>
      operation.table === 'appointments' &&
      operation.op === 'upsert' &&
      operation.stored !== undefined &&
      operation.row?.starts_at_ms !== operation.stored.starts_at_ms,
  );
  for (const appointment of appointments) {
    const reservationId = appointment.row?.reservation_id;
    const reservation = operations.find(
      (operation) =>
        operation.table === 'reservations' &&
        operation.op === 'upsert' &&
        operation.rowId === reservationId &&
        operation.row?.clinic_id === appointment.row?.clinic_id &&
        operation.row?.starts_at_ms === appointment.row?.starts_at_ms,
    );
    const event = operations.find(
      (operation) =>
        operation.table === 'domain_events' &&
        operation.op === 'upsert' &&
        operation.stored === undefined &&
        operation.row?.clinic_id === appointment.row?.clinic_id &&
        operation.row?.aggregate_type === 'appointment' &&
        operation.row?.aggregate_id === appointment.rowId &&
        operation.row?.event_type === 'appointment_rescheduled',
    );

    if (reservation === undefined || event === undefined) {
      throw new CommitValidationRejection(
        appointment.opIndex,
        'app.incomplete_appointment_reschedule',
        'appointment reschedule requires its reservation and event rows',
      );
    }
  }
};
```

Pass it as `SyncServerConfig.commitValidator`. The callback observes the final
candidate state inside the open commit transaction.

::checkpoint[A push that moves `starts_at_ms` without the reservation and event rows is rejected with `app.incomplete_appointment_reschedule`.]
::::

::::step{title="Make event rows immutable" time="3 min"}
Reject updates of existing `domain_events` rows with a table validator, and allow
deletes only for a dedicated retention actor:

```ts
import { ValidationRejection, type Validator } from '@syncular/server';

export const immutableDomainEvents: Validator = (operation, context) => {
  if (
    operation.stored !== undefined &&
    !(operation.op === 'delete' && context.actorId === 'event-retention-worker')
  ) {
    throw new ValidationRejection(
      'app.domain_event_immutable',
      'existing domain events are immutable',
    );
  }
};
```

Corrections to an event that already landed insert another event, such as
`appointment_reschedule_corrected`, with its own stable ID and a reference to the
event it corrects.

::checkpoint[An upsert that targets an existing event ID is rejected with `app.domain_event_immutable`.]
::::

::::step{title="Consume events idempotently" time="5 min"}
Treat the event primary key as the consumer's idempotency key. A worker records
processed IDs or passes the ID to an idempotent downstream API, because delivery
can repeat after a lost acknowledgement or a process crash.

When [durable server reactions](/server-reactions/) are enabled, use the event
row as the planner input: match `domain_events` operations by `event_type` and
return bounded reaction records. The planner runs after validation while the
source transaction is still open, so its records commit atomically with the
appointment, reservation, event row, commit log, and idempotency result. The full
planner and runner for this schema are on
[Durable server reactions](/server-reactions/). Keep external calls out of both
`mutate()` validation and the planner.

Event rows stay queryable until the retention worker deletes them. Commit-log
pruning does not delete current rows. Define an application retention policy,
then let the dedicated actor delete expired rows through normal mutations so
replicas converge. Keep events required for audit or replay in storage that suits
that retention period.

If a reschedule conflicts, the complete state-and-event commit is rejected.
Resolve against the returned server row and submit a new commit identity
([Handling conflicts](/guide-concurrency-correction/)). The event ID stays stable
when it still identifies the same business action and no event row landed. If an
earlier event already landed, keep it and insert a correction event with a new
ID. Exact retries of one prepared commit keep both the commit identity and the
event ID.

::checkpoint[Replaying the same event ID twice produces one downstream effect.]
::::
:::::

## Related mechanisms

- `SyncularServerEvents` reports protocol and operational activity such as a
  rejected push, a segment download, or a resolver failure. It is an
  observability sink. Domain event rows are application data and sync to
  authorized replicas.
- A CRDT or Yjs column defines how concurrent values merge. It records no
  business action, and a row with a CRDT column can still have a sibling domain
  event.
- A normal client mutation fits when the caller may write the rows under its
  resolved scopes. Use a
  [server-authoritative command](/guide-remote-operations/#server-authoritative-commands)
  when the operation needs privileged reads, secret material, a server-owned
  invariant, or custom command authorization.
