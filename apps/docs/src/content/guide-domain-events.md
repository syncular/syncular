# Domain actions and event rows

Row changes describe state. They do not reliably describe why the state
changed. A reservation time can move because a patient rescheduled, a clinician
changed availability, or an operator repaired bad data. Consumers that infer
the action from the changed columns will eventually misclassify one of those
cases.

Store the action as ordinary relational data. Update the affected domain rows
and insert one immutable event row in the same `mutate([...])` call.

## Schema

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

Declare the same `clinic:{clinic_id}` scope for all three tables. Event rows
then follow the same authorization boundary as the state they describe.

## Write the state and action together

Generate the event ID once and keep it with the logical action. The local
outbox retains the commit across retries.

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

`crypto.randomUUID()` is stable for retries of this durable local commit. If
the action originates from a retried webhook or job, derive the event ID from
that upstream request ID or persist the generated ID with the job.

The three operations form one Syncular commit. The server applies every row,
the commit-log entry, and the idempotency result in one storage transaction.
A rejection or conflict rolls the complete commit back.

## Require the event with `commitValidator`

A client bug could update the appointment without inserting its event. A
whole-commit validator can reject that shape before the transaction commits:

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

Also reject updates of existing `domain_events` rows with a table validator.
Allow deletes only for a dedicated retention actor:

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

Corrections to an event that already landed should insert another event, such
as `appointment_reschedule_corrected`, with its own stable ID and a reference
to the event it corrects.

## Plan durable reactions from event rows

When [durable server reactions](/server-reactions/) are enabled, use the event
row as the planner input. The planner runs after validation while the source
transaction is still open. Its reaction records commit atomically with the
appointment, reservation, event row, commit log, and idempotency result.

```ts
import type { ReactionPlanner } from '@syncular/server';

type AppointmentReactions = {
  'appointment.notify_rescheduled': {
    readonly eventId: string;
    readonly appointmentId: string;
    readonly payload: string;
  };
};

export const appointmentReactionPlanner: ReactionPlanner<
  AppointmentReactions
> = ({ operations }) =>
  operations.flatMap((operation) => {
    if (
      operation.table !== 'domain_events' ||
      operation.op !== 'upsert' ||
      operation.row?.event_type !== 'appointment_rescheduled'
    ) {
      return [];
    }

    const eventId = operation.row.id;
    const appointmentId = operation.row.aggregate_id;
    const payload = operation.row.payload;
    if (
      typeof eventId !== 'string' ||
      typeof appointmentId !== 'string' ||
      typeof payload !== 'string'
    ) {
      throw new Error('invalid appointment_rescheduled event');
    }

    return [
      {
        key: `notify:${eventId}`,
        type: 'appointment.notify_rescheduled',
        version: 1,
        payload: { eventId, appointmentId, payload },
      },
    ];
  });
```

Pass the planner as `SyncServerConfig.reactionPlanner`. A runner handles the
reaction after commit and receives a stable reaction idempotency key. Keep
external calls out of both `mutate()` validation and the planner.

## Consumption and retention

Treat the event primary key as the consumer idempotency key. A worker should
record processed IDs or pass the ID to an idempotent downstream API. Delivery
can repeat after a lost acknowledgement or a process crash.

Event rows remain queryable until the retention worker deletes them.
Commit-log pruning does not delete current rows. Define an application
retention policy, then let the dedicated actor delete expired rows through
normal mutations so replicas converge. Keep events required for audit or
replay in storage appropriate for that retention period.

If a reschedule conflicts, the complete state-and-event commit is rejected.
Resolve against the returned server row and submit a new commit identity. The
event ID can remain stable when it still identifies the same business action
and no event row landed. If an earlier event already landed, preserve it and
insert a correction event with a new ID. Exact retries of one prepared commit
keep both the commit identity and event ID unchanged.

## Related mechanisms

- `SyncularServerEvents` reports protocol and operational activity such as a
  rejected push, a segment download, or a resolver failure. It is an
  observability sink. Domain event rows are application data and sync to
  authorized replicas.
- A CRDT or Yjs column defines how concurrent values merge. It does not record
  the business action that caused an edit. A row may contain a CRDT column and
  still have a sibling domain event.
- A normal client mutation is appropriate when the caller may write the rows
  under its resolved scopes. Use a [server-authoritative command](/guide-remote-operations/#server-authoritative-commands)
  when the operation needs privileged reads, secret material, a server-owned
  invariant, or custom command authorization.
