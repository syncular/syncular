# Concurrency and conflict correction

This guide is the complete application path for an ordinary synced write:
read a confirmed server version, submit one optimistic multi-row aggregate,
classify a conflict or rejection, build a corrected replacement, acknowledge
the old outcome, and restore any remaining correction UI after restart.

Use this for user-owned offline creation and editing. The final section explains
when an operation needs a server-authoritative command instead.

## 1. Read the confirmed version

Project Syncular's private version column explicitly and alias it. This SYQL
query produces an exact generated `serverVersion: number`; `_sync_version`
itself remains absent from mutation types and `select *`:

```syql
sync query appointmentForCorrection(clinicId, appointmentId) {
  select
    appointments.id,
    appointments.clinic_id,
    appointments.clinician_id,
    appointments.starts_at_ms,
    appointments.status,
    appointments._sync_version as server_version
  from appointments
  where appointments.clinic_id = :clinicId
    and appointments.id = :appointmentId;
}
```

```tsx
const appointment = useQuery(appointmentForCorrectionQuery, {
  clinicId,
  appointmentId,
}).rows[0];
```

Choose `baseVersion` from intent, not convenience:

| Intent | `baseVersion` |
| --- | --- |
| Create only if the primary key is absent | `0` |
| Compare-and-set an existing confirmed row | The positive generated `serverVersion` you read |
| Deliberate last-write-wins | Omit it |
| Chain edits on a new/unconfirmed local row | Omit it until a positive confirmed version arrives |

A newly optimistic local row uses an internal negative sentinel. That sentinel
is evidence only that the server has not confirmed the row; it is never a
server concurrency token. Do not pass it as `baseVersion`. Use `0` when the
domain means create-if-absent, or omit the base when deliberately chaining
unconfirmed offline work.

## 2. Validate the complete aggregate

Suppose rescheduling writes three rows atomically: the appointment, its room
reservation, and an audit event. A per-row validator can validate each proposed
row, but it cannot prove that all three siblings are present. Install a
`commitValidator` for that aggregate invariant:

```ts
import {
  CommitValidationRejection,
  type SyncServerConfig,
} from '@syncular/server';

const config: SyncServerConfig = {
  schema,
  storage,
  segments,
  resolveScopes,
  commitValidator: ({ operations }) => {
    const appointment = operations.find(
      (operation) =>
        operation.table === 'appointments' &&
        operation.op === 'upsert' &&
        operation.row !== undefined &&
        operation.stored !== undefined &&
        (operation.row.starts_at_ms !== operation.stored.starts_at_ms ||
          operation.row.clinician_id !== operation.stored.clinician_id),
    );
    if (appointment === undefined) return;

    const hasReservation = operations.some(
      (operation) =>
        operation.table === 'room_reservations' &&
        operation.row?.appointment_id === appointment.rowId,
    );
    const hasAuditEvent = operations.some(
      (operation) =>
        operation.table === 'appointment_events' &&
        operation.row?.appointment_id === appointment.rowId &&
        operation.row?.kind === 'rescheduled',
    );
    if (hasReservation && hasAuditEvent) return;

    throw new CommitValidationRejection(
      appointment.opIndex,
      'appointment.reschedule_aggregate_required',
      'diagnostic only',
      {
        fieldPaths: ['starts_at_ms', 'clinician_id'],
        reason: 'missing_sibling_operation',
        requiredAction: 'repair_aggregate',
      },
    );
  },
};
```

The hook runs after every decoded, authorized operation is staged and reads the
final candidate transaction. Throwing rejects the whole commit: the valid
appointment and reservation siblings, indexes, and commit-log candidate all
roll back. Use ordinary row validators for one authorized proposed row; use
`commitValidator` when correctness depends on the complete candidate aggregate.

## 3. Submit one optimistic aggregate from React

Use one `mutate()` call. Splitting the rows across calls would create separate
server commits and defeat atomic validation:

```tsx
import type { SyncClientHandle } from '@syncular/client';
import { useMutation, useQuery } from '@syncular/react';
import { appointmentForCorrectionQuery } from './syncular.queries';

function AppointmentEditor(props: {
  handle: SyncClientHandle;
  clinicId: string;
  appointmentId: string;
}) {
  const query = useQuery(appointmentForCorrectionQuery, {
    clinicId: props.clinicId,
    appointmentId: props.appointmentId,
  });
  const mutation = useMutation();
  const current = query.rows[0];

  async function reschedule(input: {
    clinicianId: string;
    roomId: string;
    startsAtMs: number;
  }) {
    if (current === undefined || current.serverVersion < 1) {
      throw new Error('rescheduling requires a confirmed appointment');
    }
    const reservationId = `appointment:${props.appointmentId}`;
    const eventId = crypto.randomUUID();
    const clientCommitId = await mutation.mutate([
      {
        table: 'appointments',
        op: 'upsert',
        baseVersion: current.serverVersion,
        values: {
          id: current.id,
          clinic_id: current.clinicId,
          clinician_id: input.clinicianId,
          starts_at_ms: input.startsAtMs,
          status: current.status,
        },
      },
      {
        table: 'room_reservations',
        op: 'upsert',
        baseVersion: 0,
        values: {
          id: reservationId,
          appointment_id: current.id,
          clinic_id: current.clinicId,
          room_id: input.roomId,
          starts_at_ms: input.startsAtMs,
        },
      },
      {
        table: 'appointment_events',
        op: 'upsert',
        baseVersion: 0,
        values: {
          id: eventId,
          appointment_id: current.id,
          clinic_id: current.clinicId,
          kind: 'rescheduled',
          recorded_at_ms: Date.now(),
        },
      },
    ]);

    // With autoSync this is normally host-driven. Awaiting a round here makes
    // a save-and-confirm interaction deterministic.
    await props.handle.syncUntilIdle();
    return await props.handle.commitOutcome(clientCommitId);
  }

  // A focused migration test can reproduce an old two-row client that omitted
  // the audit sibling. Both optimistic rows roll back after this rejection.
  async function reproduceMissingAuditRejection(input: {
    clinicianId: string;
    roomId: string;
    startsAtMs: number;
  }) {
    if (current === undefined || current.serverVersion < 1) {
      throw new Error('test requires a confirmed appointment');
    }
    const clientCommitId = await mutation.mutate([
      {
        table: 'appointments',
        op: 'upsert',
        baseVersion: current.serverVersion,
        values: {
          id: current.id,
          clinic_id: current.clinicId,
          clinician_id: input.clinicianId,
          starts_at_ms: input.startsAtMs,
          status: current.status,
        },
      },
      {
        table: 'room_reservations',
        op: 'upsert',
        baseVersion: 0,
        values: {
          id: `appointment:${current.id}`,
          appointment_id: current.id,
          clinic_id: current.clinicId,
          room_id: input.roomId,
          starts_at_ms: input.startsAtMs,
        },
      },
    ]);
    await props.handle.syncUntilIdle();
    const outcome = await props.handle.commitOutcome(clientCommitId);
    if (outcome?.status !== 'rejected') {
      throw new Error('expected the aggregate validator to reject');
    }
    return outcome;
  }

  // Render the form using `current`; call `reschedule` on submit. The focused
  // recovery test calls `reproduceMissingAuditRejection` instead.
  return null;
}
```

The local mirror updates immediately. If the server rejects the commit, the
client restores the confirmed before-images for every sibling, records one
durable final outcome, and then reapplies any later pending commits.

## 4. Classify what failed

Do not collapse every failed commit into “conflict”:

| Outcome | How to recognize it | What it means |
| --- | --- | --- |
| Version conflict | `status === 'conflict'` and `code === 'sync.version_conflict'` | The positive base is stale; `serverVersion` and `serverRow` contain the winner observed by that push. |
| Protocol rejection | `status === 'rejected'` with a reserved code such as `sync.row_missing` or `sync.constraint_violation` | The request violated a protocol/storage contract. Follow the stable catalog action and retryability, not message text. |
| Host/domain rejection | `status === 'rejected'` with an application code such as `appointment.reschedule_aggregate_required` | The authorized proposal violated domain validation. Map the stable code and bounded `details` to application UI. |

Messages are diagnostics. User copy should be selected from stable codes and
bounded detail tokens. A non-retryable outcome has already drained its poison
commit from the outbox; repeatedly calling sync does not repair it.

## 5. Keep server, keep local, or merge

Failed multi-operation outcomes retain their complete ordered local envelope in
`outcome.operations`. That is protected recovery data, not automatically safe
intent: inspect it only in a domain-specific correction flow.

The following functions handle all three choices for the reschedule aggregate.
The replacement uses the conflict's `serverVersion`, or the freshly generated
query version after a domain rejection. It never reuses the stale original
base.

```ts
import type {
  CommitOutcome,
  OutboxOperation,
  SyncClientHandle,
} from '@syncular/client';
import type { AppointmentForCorrectionRow } from './syncular.queries';

type RecoverableUpsert = OutboxOperation & {
  readonly op: 'upsert';
  readonly values: NonNullable<OutboxOperation['values']>;
};

function requiredUpsert(
  outcome: CommitOutcome,
  table: string,
): RecoverableUpsert {
  const operation = outcome.operations?.find(
    (candidate) => candidate.table === table && candidate.op === 'upsert',
  );
  if (operation?.op !== 'upsert' || operation.values === undefined) {
    throw new Error(`outcome has no recoverable ${table} upsert`);
  }
  return operation as RecoverableUpsert;
}

export async function keepServer(
  client: SyncClientHandle,
  outcome: CommitOutcome,
) {
  // Ensure the rollback/pull is visible, then explicitly close the UI item.
  await client.syncUntilIdle();
  await client.resolveCommitOutcome({
    clientCommitId: outcome.clientCommitId,
    resolution: 'resolved_keep_server',
  });
}

export async function replaceReschedule(
  client: SyncClientHandle,
  outcome: CommitOutcome,
  current: AppointmentForCorrectionRow,
  choice:
    | { kind: 'keep-local' }
    | { kind: 'merge'; clinicianId: string; startsAtMs: number },
) {
  const appointment = requiredUpsert(outcome, 'appointments');
  const reservation = requiredUpsert(outcome, 'room_reservations');
  const conflict = outcome.results.find(
    (result) => result.status === 'conflict',
  );
  const newBase =
    conflict?.status === 'conflict'
      ? conflict.conflict.serverVersion
      : current.serverVersion;
  if (newBase < 1) throw new Error('correction requires a confirmed base');

  const desiredAppointment = {
    ...appointment.values,
    ...(choice.kind === 'merge'
      ? {
          clinician_id: choice.clinicianId,
          starts_at_ms: choice.startsAtMs,
        }
      : {}),
  };
  const correctionKey = outcome.clientCommitId;
  const replacementClientCommitId = await client.mutate([
    {
      table: 'appointments',
      op: 'upsert',
      values: desiredAppointment,
      baseVersion: newBase,
    },
    {
      table: 'room_reservations',
      op: 'upsert',
      values: reservation.values,
      baseVersion: 0,
    },
    {
      table: 'appointment_events',
      op: 'upsert',
      values: {
        id: `correction:${correctionKey}`,
        appointment_id: current.id,
        clinic_id: current.clinicId,
        kind: 'rescheduled',
        recorded_at_ms: Date.now(),
      },
      baseVersion: 0,
    },
  ]);

  // The replacement is already durable in the outbox. Link and acknowledge
  // the old item immediately; if the replacement later fails, it becomes the
  // new active outcome instead of resurrecting the stale one.
  await client.resolveCommitOutcome({
    clientCommitId: outcome.clientCommitId,
    resolution: 'superseded',
    replacementClientCommitId,
  });
  await client.syncUntilIdle();
  return await client.commitOutcome(replacementClientCommitId);
}
```

- **Keep server** submits no replacement and acknowledges the failure as
  `resolved_keep_server`.
- **Keep local** reconstructs the authorized local aggregate and compares it
  against the new positive server base.
- **Merge** constructs explicit values from local intent plus the chosen server
  state, then uses that same new base.

If another writer wins before the replacement lands, the replacement safely
becomes a new active conflict. Omitting `baseVersion` here would turn the
correction into an unannounced last-write-wins overwrite.

## 6. Render and restore the correction inbox

`useCommitOutcomes()` observes the durable journal. Filter on `resolution` and
failure status; do not derive correction state from transient toast state:

```tsx
import type { SyncClientHandle } from '@syncular/client';
import {
  useCommitOutcomes,
  useQuery,
} from '@syncular/react';
import { appointmentForCorrectionQuery } from './syncular.queries';

export function CorrectionInbox(props: {
  handle: SyncClientHandle;
  clinicId: string;
  appointmentId: string;
}) {
  const current = useQuery(appointmentForCorrectionQuery, {
    clinicId: props.clinicId,
    appointmentId: props.appointmentId,
  }).rows[0];
  const { outcomes, isLoading } = useCommitOutcomes();
  const active = outcomes.filter(
    (outcome) =>
      outcome.resolution === 'active' &&
      (outcome.status === 'conflict' || outcome.status === 'rejected'),
  );

  if (isLoading) return <p>Restoring corrections…</p>;
  return (
    <ul>
      {active.map((outcome) => (
        <li key={outcome.clientCommitId}>
          <code>{outcome.clientCommitId}</code>
          <button onClick={() => void keepServer(props.handle, outcome)}>
            Keep server
          </button>
          <button
            disabled={current === undefined}
            onClick={() =>
              current === undefined
                ? undefined
                : void replaceReschedule(
                    props.handle,
                    outcome,
                    current,
                    { kind: 'keep-local' },
                  )
            }
          >
            Keep my reschedule
          </button>
          <button
            disabled={current === undefined}
            onClick={() =>
              current === undefined
                ? undefined
                : void replaceReschedule(
                    props.handle,
                    outcome,
                    current,
                    {
                      kind: 'merge',
                      clinicianId: current.clinicianId,
                      startsAtMs: current.startsAtMs,
                    },
                  )
            }
          >
            Save explicit merge
          </button>
        </li>
      ))}
    </ul>
  );
}
```

Mount the same component after reopening the same persistent database:

```tsx
const handle = await createSyncClientHandle({
  worker,
  schema,
  database: { mode: 'persistent', name: 'medical' },
  endpoints,
});

<SyncProvider client={handle} renderBoundary={renderSyncBoundary}>
  <CorrectionInbox
    handle={handle}
    clinicId={clinicId}
    appointmentId={appointmentId}
  />
</SyncProvider>;
```

For an asynchronous provider resource, expose the ready handle from that same
factory rather than constructing a second handle. On process restart,
unresolved conflicts and rejections are still `active`; resolved entries retain
their resolution and replacement link. Retention may prune old applied/cached
or resolved history, but it never removes active failures—even when active
failures alone exceed the configured cap.

For a non-React lifecycle, the equivalent restoration read is:

```ts
const remaining = await handle.commitOutcomes({ activeOnly: true });
```

## 7. Know when sync is the wrong authority

Validators answer “may this authorized client proposal be accepted?” They must
not allocate or choose privileged global state. If the server must pick the
room, allocate a scarce operating slot, charge a payment, issue a sequence,
connect facilities, or transform protected state, call a server-authoritative
command and sync its resulting projection back to clients.

| Requirement | Use |
| --- | --- |
| Offline creation/editing with deterministic row ownership | Synced mutation |
| Compare-and-set edit of a confirmed row | Synced mutation with positive `baseVersion` |
| Create only if the primary key is absent | Synced mutation with `baseVersion = 0` |
| Deliberate last-write-wins or chained unconfirmed local edit | Synced mutation without a base |
| Mergeable CRDT field | Synced CRDT mutation without a base for the CRDT-only change |
| Validate one authorized proposed row | Row validator |
| Validate one atomic candidate aggregate | `commitValidator` |
| Allocate scarce/global resources, choose privileged values, or transform authoritative state | Server-authoritative command plus synced projection |

The protocol specification remains normative for wire behavior. This guide is
the application decision and recovery flow.
