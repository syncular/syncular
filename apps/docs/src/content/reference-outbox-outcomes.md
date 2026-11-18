# Outbox & commit outcomes

This page is for developers who build recovery UI or debug the client's local write path. It lists the rules the client follows between `mutate`, the server's answer, and the moment authoritative data replaces local intent. The model is on [Subscriptions & the outbox](/concepts-subscriptions/) and [Conflicts & optimistic writes](/concepts-conflicts/).

::meta{for="App developers and SDK maintainers" time="Reference" spec="6 7"}

:::terms
- **Acknowledged intent**: Local row changes the server accepted and no authoritative change has replaced yet.
- **Retained commit**: A failed commit whose intended rows stay as durable local intent (`retainFailedCommits`).
- **Commit outcome**: The durable journal entry for one commit's final result.
:::

## Local constraint failures

The client applies a new local commit to the optimistic read model inside the same SQLite transaction that appends its outbox entry. A write that violates a declared secondary unique index throws `sync.constraint_violation`. The transaction leaves no rows from the commit, no outbox entry, and no local revision change.

## Atomic sparse aggregates

`mutate` accepts `op: 'patch'` alongside full `upsert` and `delete` operations. Include each patch's primary key in `values`. The client queues one atomic commit and updates all local rows in one transaction.

```ts title="src/sync.ts"
client.mutate([
  { table: 'todos', op: 'patch', values: { id: 't1', position: 2 }, baseVersion: 3 },
  { table: 'todos', op: 'patch', values: { id: 't2', position: 1 }, baseVersion: 4 },
  { table: 'events', op: 'upsert', values: auditEvent, baseVersion: 0 },
]);
```

| Rule | Behavior |
|---|---|
| Every sparse patch needs a base row | The base is the row as the batch's earlier operations leave it, otherwise the local row at call time. A patch may follow an upsert of its row in the same batch. A missing base, including one an earlier delete in the batch removed, rejects the whole batch with `sync.row_missing` before any local write or outbox insert. |
| `baseVersion` after an earlier write of the row | Omit it. The server judges it against the row the earlier operation wrote, so the pre-commit version conflicts. |
| Omitted columns | Retain their values. |
| Encrypted columns | A patch that writes only plaintext columns needs no encryption key for omitted encrypted columns. Their stored ciphertext stays unchanged. |

## Caller-supplied commit IDs

`mutate` returns the commit's `clientCommitId` once the commit is queued. A worker or native bridge that fails mid-call can lose that reply after the commit was queued. To know your commit regardless, pass your own ID:

```ts title="src/sync.ts"
const eventId = crypto.randomUUID();
await client.mutate([{ table: 'todos', op: 'upsert', values: todo }], {
  clientCommitId: eventId,
});
```

After a lost reply, read the commit by that ID instead of calling `mutate` again. `pendingCommits()` lists it while it is queued, and `commitOutcome(eventId)` returns its final outcome once the server answered. When neither knows the ID, the lost call queued nothing, and calling `mutate` again with the same ID is safe. A call with an ID the outbox or the outcome journal still holds throws `client.commit_id_reused` with `details.clientCommitId` and writes nothing. An empty ID throws `sync.invalid_request`. The client does not detect an ID it no longer holds, such as one whose outcome left the journal through retention; never reuse an ID for a different commit. Kotlin, Swift and Flutter take the ID as a `clientCommitId` argument of `mutate`, and the command bridge as the `clientCommitId` parameter of the `mutate` command.

## Pending commits

`pendingCommits()` returns the outbox in send order. The in-process `SyncClient` returns the array; the worker handle and the Tauri and React Native bridges return a promise of the same JSON. The Rust core exposes it as `pending_commits()` and the command bridge as the `pendingCommits` command, whose reply is `{ commits }`. Each commit has these fields:

- `seq`: the outbox sequence number, increasing in creation order.
- `clientCommitId`: the ID `mutate` returned or the caller supplied.
- `createdAtMs`: the client clock when `mutate` queued the commit. A Rust replica reports `0` for a commit it queued before 0.89.
- `operations`: one entry per operation, with `table`, `rowId`, `op` (`upsert` or `delete`; a patch is a sparse `upsert`), `baseVersion` when the write carried one, `values` on an upsert (the columns the operation writes, bytes as `{ "$bytes": "<hex>" }`), and `insert: true` on a full-row write of a row the replica did not hold.

```json
{
  "seq": 2,
  "clientCommitId": "patch",
  "createdAtMs": 1700000000000,
  "operations": [
    { "table": "todos", "rowId": "t1", "op": "upsert", "baseVersion": 3, "values": { "id": "t1", "title": "x" } }
  ]
}
```

Kotlin, Swift and Flutter list only the IDs, through `pendingCommitIds()`.

## Delivery status

`commitDelivery(id)` reads one commit's delivery status in one local read transaction:

- `{ status: 'pending', clientCommitId }`: the outbox holds the ID. The outbox entry wins when the journal holds the ID as well.
- `{ status: 'known', clientCommitId, outcome }`: the outcome journal holds the commit's final outcome. The outcome omits `retainedRows`; read them with `commitOutcome(id)`.
- `{ status: 'unknown', clientCommitId }`: neither holds the ID. This client never queued it, or retention removed its outcome.

The in-process `SyncClient` returns the value; the worker handle and the Tauri and React Native bridges return a promise with the same states. The bridges read it through the native core's `snapshotRead`, and the Rust core exposes it as `commit_delivery`. `snapshotRead({ statements: [], commitIds })` reads several deliveries in one transaction. React follows a list of commits with [`useCommitDelivery(ids)`](/platform-react-realtime/#follow-a-write-to-its-outcome). Kotlin, Swift and Flutter do not expose `commitDelivery`.

## Acknowledgement and replay

An `applied` or `cached` acknowledgement confirms server acceptance and removes the commit from the send queue. The client keeps its local intent in protected storage until an authoritative change for the same row arrives at that commit sequence or later. A completed covering bootstrap also retires it. Empty pulls, restarts, and later edits keep acknowledged intent. This runs automatically in Bun, the web worker, and native clients, independent of `retainFailedCommits`.

| Event | Effect on acknowledged intent |
|---|---|
| Acknowledgement | Schedules a following pull, even when realtime sends no notification to the originating client. |
| Row delivery | Delivery and overlay reconciliation share one local transaction. |
| Revocation or security purge | Removes the affected aggregates. |
| Window eviction | Removes the evicted row's intent. |
| Unrelated bootstrap, including an empty one | Does not rewrite acknowledged rows or decode their protected operations. |

Imports restore and replay only affected rows or tables. Unique constraints can require peer rows in the same table.

### Rejection rollback

Without `retainFailedCommits`, the round that receives a rejection or conflict removes that commit from the visible rows. The client returns each affected row to the last row the server delivered, then replays every later pending commit in FIFO order. A server write that arrived after the rejected edit was queued stays visible.

### Replay failures

Clients surface overlay replay failures on reopen and during sync. SQL reads, value decoding, row writes, savepoints, and FTS maintenance must succeed before the local apply transaction commits. A failure rolls back that transaction's visible rows, FTS projection, base changes, cursor, acknowledgements, outbox changes, and observation revision. Earlier completed protocol commits stay applied, and pending intent stays available for retry after the storage failure is corrected.

- Replay leaves a sparse operation over a genuinely absent row unapplied. A read or decode failure does not establish absence.
- Replay defers a confirmed secondary unique conflict until a later replay admits the intended row or the server answers its push.
- Every other replay failure aborts the local transaction.

## Retain failed local intent

Set `retainFailedCommits: true` when constructing the browser, worker, or Tauri client. The Rust core exposes `set_retain_failed_commits(true)`. The default removes rejected optimistic overlays. The enabled policy keeps the complete failed aggregate as durable local intent.

A failed commit leaves the outbox and is never retried implicitly. Incoming server rows keep advancing a separate base while local reads retain the intended changes. A restart preserves that state.

`commitOutcome(id)` and `commitOutcomes()` expose `retainedRows`. Each row carries its table, primary key, the complete intended `localRow`, and the latest delivered authorized `serverRow` and `serverVersion`. A deletion or absent server row is `null`. The outcome's results carry the conflict or rejection reason. Display that reason on the affected item and offer an explicit resolution.

### Refresh a retained base before recovery

A rejection reaches the client before the pull section of the same sync round. The retained `serverRow` can therefore still contain the before-image when the rejection first appears. An empty outbox, an online connection, and a non-null `serverRow` do not establish freshness.

Call `await client.proveCurrentBase(outcome)` when the user requests a reviewed replacement. The call waits for an earlier drive, completes a new idle drive, checks unit coverage in a snapshot, and rereads the retained outcome. On success, `rows` contains the authorized bases and versions for every retained row in the aggregate. The call returns no rows when any row lacks proof. It also checks the coverage of returned `uniqueConflicts` rows.

```ts
const proof = await client.proveCurrentBase(outcome);
if (!proof.proven) {
  showRecoveryUnavailable(proof.reason);
  return;
}
// Construct the replacement from proof.rows and the saved operation intent.
```

The failure reason is `offline`, `sync_failed`, `schema_floor`, `budget_exhausted`, `snapshot_failed`, `missing_coverage`, `revoked`, or `outcome_unavailable`. Keep the failed outcome and show a message for the reason. Pass a positive round limit as the second argument to bound the drive. A null `serverRow` means the covering unit holds no authorized base; it does not establish that the primary key is absent outside the actor's scopes. Another writer can change a row after proof, so submit the replacement with the domain's version check and retain any new rejection.

### Decide without waiting for the server

`replaceCommitOutcome({ clientCommitId, sequence, replacement? })` records a decision against an active conflict or rejection and returns the replacement's commit id. It needs no connection. Pass the outcome itself to keep the local intent, or add `replacement`, a list of mutations, to record an edited payload.

```ts
// Keep mine: the failed operations again, against the server row shown.
client.replaceCommitOutcome(outcome);

// Save an edit of a record with an open conflict.
client.replaceCommitOutcome({
  ...outcome,
  replacement: [{ table: 'todos', op: 'patch', values: { id: 't1', title: 'Buy oat milk' } }],
});
```

In one local transaction the client appends the replacement to the outbox, applies it to local reads, and stores its id as the outcome's `replacementClientCommitId`. The outcome stays `active` while the decision is pending. Each replacement operation on a retained row carries that row's `serverVersion` as its `baseVersion`, or 0 when `serverRow` is null. A `replacement` operation on a retained row must not set `baseVersion`; the call fails with `sync.invalid_request`. Operations on other rows keep the `baseVersion` you pass. A pending decision accepts no `resolveCommitOutcome` and no second `replaceCommitOutcome`; both fail with `client.replacement_pending`.

The replacement is held: pushes stop at it, so it and every later commit wait. When the client's next sync drive completes, the client runs the `proveCurrentBase` check for every decision pending when that drive began.

| Proof result | State | What happens |
|---|---|---|
| Proven, every retained row still at the recorded version | written | The outcome becomes `superseded`. The drive runs one more round and pushes the replacement, which gets its own outcome. |
| Proven, a row moved past the recorded version | refused, `base_moved` | The replacement leaves the outbox as a rejected outcome with `sync.replacement_refused` and keeps its retained intent. The original outcome becomes `superseded`. Show the new outcome and decide again. |
| `schema_floor`, `missing_coverage`, `revoked`, `outcome_unavailable` | refused with that reason | Same as `base_moved`; `details.reason` names the reason. |
| `offline`, `sync_failed`, `budget_exhausted`, `snapshot_failed` | pending | The next drive tries again. |

The outbox and the journal hold the whole state, so a pending decision survives a restart and a closed page. Read it from `commitOutcomes()`: an `active` outcome with a `replacementClientCommitId` is pending, and `commitDelivery(replacementClientCommitId)` follows the replacement. Every transition publishes `outcomesChanged`, so React's `useCommitOutcomes` re-renders on it. A later `mutate` of the same row queues behind the replacement and moves to the replacement's version when the server acknowledges it.

| Resolution | Call |
|---|---|
| Keep server | `resolveCommitOutcome({ clientCommitId, resolution: 'resolved_keep_server' })` restores the latest server base. |
| Keep local, or edit | Create a new validated aggregate with current base versions, then resolve the failed outcome as `superseded` with the new `replacementClientCommitId`. The replacement retains its own sync outcome. |

Security purge and scope revocation remove whole retained aggregates; retained intent never grants access. Revocation and security purge erase retained rows, the aggregate operation envelope, and row-bearing journal results. Static outcome history remains.

When a sparse conflict loses its server base, its operation and conflict evidence stay readable. The client leaves the local row absent and does not build a complete row from the saved before-image. The application must restore an authorized base or write a complete row before it retries that intent.

### Unique-index collisions

A failed insert can collide with a different server primary key through a secondary unique index. The intended row stays in the journal while physical reads show the server winner. `retainedRows[].uniqueConflicts` lists the matching `index`, `columns`, competing `rowId`, and authorized `serverRow` and `serverVersion`. The same-ID `serverRow` stays null when that primary key has no server base. NULL values follow SQLite's unique-index semantics and do not collide.

- Keep mine: patch the competing `rowId` using its `serverVersion`, then link the replacement through `superseded`.
- Edit: insert the intended ID with a free unique key.
- Take server: `resolved_keep_server` discards the intent.

## Reference violations

A declared `REFERENCES` column rejects a commit with `sync.reference_violation`. A `CASCADE` or `SET NULL` delete applies inside the originating commit and reaches subscribers as ordinary changes. A rejected reference operation removes its optimistic effect on rebuild, like any other rejection. The `reason` detail names the case.

| `reason` | Meaning | Details |
|---|---|---|
| `missing_parent` | A present, non-null reference column names an absent parent, or a parent in a scope the actor cannot write; both answer identically. | `fieldPaths` names the column; `references` carries the parent table and row. |
| `restricted_delete` | A delete is blocked by a live child under `RESTRICT`. | `references.child` names the child table. |
| `cascade_limit` | A cascade passed the per-commit operation cap. | |

## Outcome persistence

The client records a final outcome and removes its outbox entry in one local transaction. If the journal write, revision write, or transaction commit fails, sync reports `client.outcome_persistence_failed`. The pending commit keeps its original ID and optimistic state. Conflicts and rejections from the failed transaction stay absent from local collections and change events, and earlier completed acknowledgements stay durable.

Restore the local store's ability to commit, then run sync again. The server's idempotency record lets the original commit retry without applying its writes twice. TypeScript's `onConflict` callback runs after the outcome commits. An exception in that callback leaves the outcome durable and the outbox drained.

### Acknowledgement batches

Consecutive `applied` or `cached` acknowledgements commit in one local transaction, and each commit keeps its own journal entry. The client publishes one change batch with the final outbox count after the transaction commits, so progress observers receive one update for a successful run.

- A rejected result ends the run and keeps its own rollback and conflict-publication boundary.
- Other frames also end the run, and a run never crosses a response boundary.
- If a local write or commit fails, every acknowledgement in that run rolls back. A later response error keeps earlier completed runs.
- The server applies a push request in one transaction, rolls a rejected commit back without touching the request's other commits, and sends realtime notifications per applied commit after it commits ([Storage reference](/server-storage-reference/#push-path)).
