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
| Every sparse patch needs a local row at call time | An absent row rejects the whole batch with `sync.row_missing` before any local write or outbox insert. |
| Omitted columns | Retain their values. |
| Encrypted columns | A patch that writes only plaintext columns needs no encryption key for omitted encrypted columns. Their stored ciphertext stays unchanged. |

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

### Replay failures

Clients surface overlay replay failures on reopen and during sync. SQL reads, value decoding, row writes, savepoints, and FTS maintenance must succeed before the local apply transaction commits. A failure rolls back that transaction's visible rows, FTS projection, base changes, cursor, acknowledgements, outbox changes, and observation revision. Earlier completed protocol commits stay applied, and pending intent stays available for retry after the storage failure is corrected.

- Replay leaves a sparse operation over a genuinely absent row unapplied. A read or decode failure does not establish absence.
- Replay defers a confirmed secondary unique conflict until a later replay admits the intended row or the server answers its push.
- Every other replay failure aborts the local transaction.

## Retain failed local intent

Set `retainFailedCommits: true` when constructing the browser, worker, or Tauri client. The Rust core exposes `set_retain_failed_commits(true)`. The default removes rejected optimistic overlays. The enabled policy keeps the complete failed aggregate as durable local intent.

A failed commit leaves the outbox and is never retried implicitly. Incoming server rows keep advancing a separate base while local reads retain the intended changes. A restart preserves that state.

`commitOutcome(id)` and `commitOutcomes()` expose `retainedRows`. Each row carries its table, primary key, the complete intended `localRow`, and the latest authorized `serverRow` and `serverVersion`. A deletion or absent server row is `null`. The outcome's results carry the conflict or rejection reason. Display that reason on the affected item and offer an explicit resolution.

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
| `missing_parent` | A present, non-null reference column names an absent parent. | `fieldPaths` names the column; `references` carries the parent table and row. |
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
- Server transactions and their realtime notifications still run per commit.
