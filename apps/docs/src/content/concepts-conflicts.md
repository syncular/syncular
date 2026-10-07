# Conflicts & optimistic writes

Writes are optimistic: `mutate` applies to the local database at once, and the commit waits in the outbox for the next push. When two clients edit the same row, the server detects it by version and returns a **conflict** for your app to resolve. This page is for developers who need to know when a conflict fires and what the three resolutions do; the full React repair flow is [Handling conflicts](/guide-concurrency-correction/).

::meta{for="App developers on any SDK" time="6 minutes" first="concepts-subscriptions" spec="6 7"}

:::terms
- **`baseVersion`**: The row version a client says it edited. A push opts into conflict checks by passing it.
- **`column_version`**: The row version at a column's last server write.
- **Conflict**: A push that names a column written after `baseVersion`. The record carries the server row.
- **Rejection**: A refused commit that is not a version conflict, such as `sync.forbidden`.
- **Commit outcome**: The durable record of how the server answered one commit.
:::

:::figure{title="When two clients edit one row" note="todo t1 · title" ticks}
<div class="d-row">
<div class="node"><span class="t">Server row</span>"Buy milk"<br><span class="chip">version 3</span></div>
<span class="d-arrow"></span>
<div class="node ok"><span class="t">Client B pushes first</span>title = "Buy oat milk", baseVersion 3<br><span class="chip ok">Applied · version 4</span></div>
<span class="d-arrow"></span>
<div class="node hot"><span class="t">Client A pushes later</span>title = "Buy 2 milk", baseVersion 3, but column_version is 4<br><span class="chip amber">Conflict</span></div>
</div>
<p class="d-label">Your app resolves the conflict with the server row attached</p>
<div class="d-cols-3">
<div class="node"><span class="t">Keep server</span>Apply serverRow, drop the operation</div>
<div class="node"><span class="t">Keep local</span>Re-push with baseVersion = serverVersion</div>
<div class="node"><span class="t">Custom merge</span>Push merged values for conflictColumns</div>
</div>

::caption[The server rolls back the whole conflicted commit. Rebase the whole commit.]
:::

## Optimistic writes

`mutate` appends the commit to the [outbox](/concepts-subscriptions/#the-outbox) and applies it to the local table in one transaction, so your queries see the row at once. The next `sync()` round pushes the outbox and drains the results. The outbox stores commits in a schema-independent form and encodes them at send time, so a commit written under schema N replays under N+1 ([Schema upgrades](/concepts-schema-upgrades/)).

## Conflict detection

Pass a `baseVersion` on a mutation to assert "I edited version K". The server tracks a `column_version` per column. A push payload is a sparse row naming the columns the operation writes, and the server compares only those. A conflict (`sync.version_conflict`) fires when a named non-`crdt` column has `column_version > baseVersion`, and `conflictColumns` lists exactly those columns. Edits that name disjoint columns both apply ([SPEC §6.2](https://github.com/syncular/syncular/blob/main/docs/SPEC.md#62-conflict-detection)).

```ts title="src/sync.ts"
const client = new SyncClient({
  /* … */
  onConflict: (c) => {
    console.log(c.table, c.rowId, 'server has', c.serverRow, 'version', c.serverVersion);
    console.log('contended columns', c.conflictColumns);
  },
});

client.patch('todos', 't1', { title: 'Buy oat milk' }, { baseVersion: 3 });
// after a round, read the conflicts instead of the callback:
client.conflicts; // readonly ConflictRecord[]
```

Without a `baseVersion`, upserts apply with last-write-wins per column; conflicts arise only when you opt into version checking. The server rejects a `baseVersion` above the row's `server_version` with `sync.invalid_request`, because a client cannot hold a version the server never issued.

`patch` records one sparse operation: the primary key plus the columns the caller supplied. The keys of the operation's `values` are the presence set, and they survive restart on conflict and rejection records. A full-row `mutate` marks every column present; Syncular never infers intent by diffing against a changing local base.

## Resolving a conflict

The conflict record carries the current server row, already decoded, so resolution needs no round trip ([SPEC §6.5](https://github.com/syncular/syncular/blob/main/docs/SPEC.md#65-conflict-resolution-contract-client)).

| Resolution | What you do |
|---|---|
| Keep server | Apply `serverRow` and drop the operation. |
| Keep local | Re-push the same sparse operation with `baseVersion = serverVersion`. This is an explicit overwrite. |
| Custom merge | Compute new values for the columns in `conflictColumns`, then push a sparse operation carrying them with `baseVersion = serverVersion`. |

## Rejections

A rejected commit that is not a version conflict surfaces in `client.rejections` instead. Examples are `sync.forbidden` from a scope check and a retryable serving error. Retry behavior follows the error's `retryable` flag. The [error catalog](https://github.com/syncular/syncular/blob/main/docs/SPEC.md#10-errors) is normative.

Conflicts and rejections persist as durable commit outcomes with structured recovery metadata: bounded `details` attached by server validators, and the sparse operation that `patch` recorded. [Handling conflicts](/guide-concurrency-correction/) covers server validators, aggregate validation, the outcome journal, restart, and acknowledgement. [Outbox & commit outcomes](/reference-outbox-outcomes/) lists the retention, acknowledgement, and persistence rules.

## Delete precedence

A delete beats a concurrent upsert that carries no `baseVersion`. The server records a tombstone for every applied delete and keeps it until the [pruning horizon](/concepts-commits/#the-pruning-horizon). An unversioned upsert that finds the row absent with its tombstone still inside the horizon rejects with `sync.row_deleted`; the client drops the operation and journals the rejection. Pass `baseVersion = 0` to recreate the row deliberately, because an explicit insert intent clears the tombstone. Once pruning moves the horizon past the delete, the ordinary insert rule applies again ([SPEC §6.2](https://github.com/syncular/syncular/blob/main/docs/SPEC.md#62-conflict-detection), [§4.6](https://github.com/syncular/syncular/blob/main/docs/SPEC.md#46-the-pruning-horizon)).

## Declared references

Parent and child existence rules belong in the schema. A declared `REFERENCES` column enforces parent existence, `RESTRICT`, `CASCADE`, and `SET NULL` on the server once per commit ([Schema & typegen](/guide-schema/#declared-references)). A violation rejects the commit with `sync.reference_violation` and structured details, listed in [Outbox & commit outcomes](/reference-outbox-outcomes/#reference-violations).
