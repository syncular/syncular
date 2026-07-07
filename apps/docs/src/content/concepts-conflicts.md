# Conflicts & optimistic writes

Writes are **optimistic**: `mutate` applies to the local database immediately
and queues the commit for the next push. Reads never wait for the server. When
two clients edit the same row, syncular surfaces a **conflict** for your app to
resolve.

Normative detail: [SPEC.md §6](https://github.com/syncular/syncular/blob/main/docs/SPEC.md#6-push-and-commit-application) and
[§7](https://github.com/syncular/syncular/blob/main/docs/SPEC.md#7-the-client-outbox).

## The optimistic outbox

`mutate` does two things in one local transaction: append the commit to the
**outbox** (in schema-agnostic form) and apply it optimistically to the local
mirror. The row shows up in your queries at once. The next `sync()` round
pushes the outbox and drains the results.

```ts
const commitId = client.mutate([
  { table: 'notes', op: 'upsert', values: { id: 'n1', list_id: 'welcome', body: 'draft', updated_at_ms: Date.now() } },
]);
// the row is already visible locally:
client.query('SELECT * FROM notes WHERE id = ?', ['n1']);
```

Because the outbox is schema-agnostic and encoded at send time, a commit
written under schema N replays cleanly after an upgrade to N+1: the outbox
re-encodes it with the current codec, so the server only ever sees current
encodings
([SPEC §2.4](https://github.com/syncular/syncular/blob/main/docs/SPEC.md#24-schema-ir-and-the-generated-row-codec)).

## Conflict detection

Pass a `baseVersion` on a mutation to assert "I edited version K." If the
server's stored `server_version` has moved on, the commit is **rejected with a
conflict record** and the stored row stays as it was
([SPEC §6.2](https://github.com/syncular/syncular/blob/main/docs/SPEC.md#6-push-and-commit-application)):

```ts
client.mutate([
  { table: 'notes', op: 'upsert', baseVersion: 3, values: { /* … */ } },
]);
```

The conflict record carries the current server row already decoded, so you can
resolve without a round-trip:

```ts
const client = new SyncClient({
  /* … */
  onConflict: (c) => {
    console.log(c.table, c.rowId, 'server has:', c.serverRow, 'version', c.serverVersion);
    // present a merge UI, or re-issue with the new baseVersion
  },
});
// or drain them after a round:
client.conflicts; // readonly ConflictRecord[]
```

Without a `baseVersion`, upserts are last-write-wins on the server; conflicts
only arise when you opt into version checking.

## Rejections vs conflicts

A rejected commit that is not a version conflict (e.g. `sync.forbidden` from a
scope check, or a serving hiccup that is retryable) surfaces as a
**rejection** instead, with its own list (`client.rejections`) and retry
semantics driven by the error's `retryable` flag. The
[error catalog](https://github.com/syncular/syncular/blob/main/docs/SPEC.md#10-errors) is normative.
