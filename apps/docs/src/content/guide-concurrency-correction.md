# Handling conflicts

This guide takes one synced write from the form to a durable, recoverable
outcome in React: read a confirmed server version, submit an optimistic
multi-row aggregate, classify a conflict or rejection, build a replacement,
acknowledge the old outcome, and restore the correction UI after a restart. It
is for React developers who edit rows that other clients also edit. The short
model is on [Conflicts & optimistic writes](/concepts-conflicts/), and the
retention, acknowledgement, and persistence rules are on
[Outbox & commit outcomes](/reference-outbox-outcomes/).

::meta{for="React developers handling concurrent edits" time="30 minutes" first="concepts-conflicts" spec="6 7"}

:::terms
- **Confirmed version**: The `serverVersion` the server issued for a row. A positive value is a valid `baseVersion`.
- **Aggregate**: Several rows written by one `mutate()` call, which becomes one atomic server commit.
- **Commit validator**: A server hook that accepts or rejects a whole candidate commit.
- **Correction inbox**: The UI over active conflict and rejection outcomes.
- **Replacement commit**: A new commit that supersedes a failed one and links to it.
:::

:::figure{title="One write, three possible endings" note="The reschedule example" ticks}
<div class="d-row">
<div class="node"><span class="t">1 · Read</span>Row plus <code>serverVersion</code></div>
<span class="d-arrow"></span>
<div class="node hot"><span class="t">2 · Mutate</span>Three rows, one commit, <code>baseVersion</code> on the first</div>
<span class="d-arrow"></span>
<div class="node"><span class="t">3 · Server</span>Per-row validators, then the commit validator</div>
</div>
<div class="d-cols-3">
<div class="node ok"><span class="t">Applied</span>Optimistic rows stay; the journal records the outcome</div>
<div class="node hot"><span class="t">Conflict</span><code>sync.version_conflict</code> with the winning row and <code>conflictColumns</code></div>
<div class="node bad"><span class="t">Rejected</span>A protocol or domain code; all optimistic siblings roll back</div>
</div>
<p class="d-label">A failed commit becomes an active outcome in the correction inbox</p>
<div class="d-cols-3">
<div class="node"><span class="t">Keep server</span>Acknowledge as <code>resolved_keep_server</code></div>
<div class="node"><span class="t">Keep local</span>Replacement on the new base</div>
<div class="node"><span class="t">Merge</span>Replacement with chosen values</div>
</div>

::caption[The outcome journal is durable, so an active conflict is still in the inbox after the app restarts.]
:::

## Steps

:::::steps
::::step{title="Read the confirmed version" time="3 min"}
Project Syncular's private version column explicitly and alias it. This SYQL
query produces an exact generated `serverVersion: number`. The `_sync_version`
column itself stays out of mutation types and `select *`:

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

Read it with the generated descriptor:

```tsx
const appointment = useQuery(appointmentForCorrectionQuery, {
  clinicId,
  appointmentId,
}).rows[0];
```

Choose `baseVersion` by intent:

| Intent | `baseVersion` |
| --- | --- |
| Create only if the primary key is absent | `0` |
| Compare-and-set an existing confirmed row | The positive generated `serverVersion` you read |
| Deliberate last-write-wins | Omit it |
| Chain edits on a new or unconfirmed local row | Omit it until a positive confirmed version arrives |

A positive `baseVersion` compares per column. A stale base conflicts only when
an operation presents a column that moved past it. An operation that leaves the
contended column absent applies, and `conflictColumns` reports the columns that
moved. The server rejects a `baseVersion` above the row's current
`server_version` with `sync.invalid_request`. An unversioned upsert loses to a
delete inside the tombstone horizon with `sync.row_deleted`, so use `0` to
recreate a deleted row deliberately.

:::warning{title="Never pass the local sentinel as a base"}
A newly optimistic local row carries an internal negative version. It marks a row
the server has not confirmed and is never a server concurrency token. Use `0`
when the domain means create-if-absent, or omit the base when you deliberately
chain unconfirmed offline work.
:::

::checkpoint[`appointment.serverVersion` is a positive integer for a row the server has confirmed.]
::::

::::step{title="Validate the complete aggregate on the server" time="5 min"}
Suppose rescheduling writes three rows atomically: the appointment, its room
reservation, and an audit event. A per-row validator checks each proposed row and
cannot see whether the siblings are present. Install a `commitValidator` for
that aggregate invariant:

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
final candidate transaction. Throwing rejects the whole commit: the appointment
and reservation siblings, the indexes, and the commit-log candidate all roll
back. Use a row validator for one authorized proposed row, and `commitValidator`
when correctness depends on the complete candidate aggregate.

A parent and child existence rule belongs in the schema. A declared `REFERENCES`
column ([Declared references](/guide-schema/#declared-references)) enforces
parent existence, `RESTRICT`, `CASCADE`, and `SET NULL` on the server once per
commit. Keep the aggregate hook for invariants that references and scopes cannot
express.

:::note{title="Validator messages"}
An unexpected exception in a row validator, whole-commit validator, or CRDT
merger produces a static public message. The original text never enters newly
recorded push results or client outcomes. Capture errors inside the host
callback when you need private diagnostics, and isolate diagnostic failures from
the callback result. The messages of deliberate `ValidationRejection` and
`CommitValidationRejection` are public content. Stored rejections keep their
historical messages.
:::

::checkpoint[A push that carries the appointment without the reservation and audit rows returns `rejected` with `appointment.reschedule_aggregate_required`.]
::::

::::step{title="Submit one optimistic aggregate" time="5 min"}
Use one `mutate()` call. Splitting the rows across calls creates separate server
commits and defeats atomic validation.

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
durable final outcome, and reapplies any later pending commits.

::checkpoint[The form shows the new time at once, and `await handle.commitOutcome(clientCommitId)` returns the server's answer after `syncUntilIdle()`.]
::::

::::step{title="Classify what failed" time="2 min"}
Branch on the outcome's `status` and `code`. A failed commit takes one of three
shapes:

| Outcome | How to recognize it | What it means |
| --- | --- | --- |
| Version conflict | `status === 'conflict'` and `code === 'sync.version_conflict'` | The positive base is stale. `serverVersion` and `serverRow` hold the winner that push observed, and `conflictColumns` names the columns that moved past the base. |
| Protocol rejection | `status === 'rejected'` with a reserved code such as `sync.row_missing`, `sync.row_deleted`, or `sync.constraint_violation` | The request violated a protocol or storage contract. Follow the stable catalog action and retryability. |
| Host or domain rejection | `status === 'rejected'` with an application code such as `appointment.reschedule_aggregate_required` | The authorized proposal violated domain validation. Map the stable code and bounded `details` to application UI. |

Messages are diagnostics. Select user copy from stable codes and bounded detail
tokens. A non-retryable outcome has already drained its poison commit from the
outbox, so calling sync again repairs nothing.

::checkpoint[Each failed commit maps to one of the three rows above, and your UI copy keys off `code`.]
::::

::::step{title="Keep server, keep local, or merge" time="8 min"}
A failed multi-operation outcome retains its complete ordered local envelope in
`outcome.operations`. It is protected recovery data. Read it only inside a
domain-specific correction flow, because the stored operations may no longer
express safe intent.

The functions below handle all three choices for the reschedule aggregate. The
replacement uses the conflict's `serverVersion`, or the freshly generated query
version after a domain rejection. It never reuses the stale original base.

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
- **Keep local** rebuilds the authorized local aggregate and compares it against
  the new positive server base.
- **Merge** builds explicit values from local intent plus the chosen server
  state, on that same new base. A conflict names its contended columns in
  `conflictColumns`, so a custom merge recomputes exactly those columns and
  leaves the rest at the server values.

If another writer wins before the replacement lands, the replacement becomes a
new active conflict. Omitting `baseVersion` here would turn the correction into
an unannounced last-write-wins overwrite.

::checkpoint[After a correction, the old outcome shows `resolution: 'superseded'` with a `replacementClientCommitId`, and the replacement is in the outbox.]
::::

::::step{title="Render and restore the correction inbox" time="5 min"}
`useCommitOutcomes()` observes the durable journal. Filter on `resolution` and
failure status, and derive correction state from the journal instead of from
transient toast state:

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

Mount the same component after you reopen the same persistent database:

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
factory so the app builds one handle. On process restart, unresolved conflicts
and rejections are still `active`. Resolved entries keep their resolution and
replacement link. Retention may prune old applied, cached, or resolved history
and never removes active failures, even when active failures alone exceed the
configured cap.

Outside React, the equivalent restoration read is:

```ts
const remaining = await handle.commitOutcomes({ activeOnly: true });
```

::checkpoint[Kill the tab with a conflict showing, reopen it, and the same item appears in the inbox without any new sync.]
::::

::::step{title="Check that sync is the right authority" time="3 min"}
Validators answer "may this authorized client proposal be accepted?" They never
allocate or choose privileged global state. If the server must pick the room,
allocate a scarce operating slot, charge a payment, issue a sequence, connect
facilities, or transform protected state, call a server-authoritative command and
sync its resulting projection back to clients
([Server-authoritative commands](/guide-remote-operations/#server-authoritative-commands)).

| Requirement | Use |
| --- | --- |
| Offline creation or editing with deterministic row ownership | Synced mutation |
| Compare-and-set edit of a confirmed row | Synced mutation with positive `baseVersion` |
| Create only if the primary key is absent | Synced mutation with `baseVersion = 0` |
| Deliberate last-write-wins or chained unconfirmed local edit | Synced mutation without a base |
| Mergeable CRDT field | Synced CRDT mutation without a base for the CRDT-only change |
| Validate one authorized proposed row | Row validator |
| Validate one atomic candidate aggregate | `commitValidator` |
| Allocate scarce or global resources, choose privileged values, or transform authoritative state | Server-authoritative command plus synced projection |

The protocol specification is normative for wire behavior. This page is the
application decision and recovery flow.

::checkpoint[Every write in your feature appears in the table with its mechanism.]
::::
:::::
