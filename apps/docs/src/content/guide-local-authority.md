# Start without a server

A local authority runs the Syncular server inside your app's process over its own SQLite file. The client syncs against it exactly as it syncs against a remote server: writes leave the outbox, declared references cascade, and a schema upgrade rebuilds the replica from the authority. When a remote server exists, attach uploads the authority's rows to it and the client switches over without migrating its storage. This page is for developers who ship an app before its sync backend exists. You finish with a client syncing against a local authority and the attach sequence that moves its data.

::meta{for="App developers shipping before a sync backend exists" time="15 minutes" first="concepts-commits" spec="12"}

:::terms
- **Local authority**: The reference server running in the client's process over its own database, serving one partition (SPEC §12).
- **Attach**: The one-time upload of the authority's rows to a remote server (SPEC §12.3).
- **Remote server**: The server the client syncs with after attach.
:::

The local authority ships in `@syncular/server` for Bun and Node 22.13 or newer. The browser worker and the native cores (Tauri, Swift, Kotlin, Flutter, React Native) have no local authority yet.

## Open the authority and the client

Give the authority its own database file. The client's schema reset drops every replica table outside `_syncular_*` ([Schema upgrades](/concepts-schema-upgrades/)), so the authority cannot share the replica file.

```ts title="src/sync.ts"
import { SyncClient } from '@syncular/client';
import { openSqliteDatabase } from '@syncular/client/sqlite';
import { BunSqliteDatabase, openLocalAuthority } from '@syncular/server';
import { buildSqliteImage } from '@syncular/server/sqlite';
import { schema } from './syncular.generated';

const authority = await openLocalAuthority({
  database: new BunSqliteDatabase('./data/authority.sqlite'),
  schema,
  sqliteImageBuilder: buildSqliteImage,
});

const client = new SyncClient({
  database: openSqliteDatabase('./data/replica.sqlite'),
  schema,
  clientId: 'device-1',
  transport: authority.sync,
  segments: authority.downloadSegment,
});

await client.start();
client.subscribe({ id: 'entries', table: 'entries', scopes: { budget_id: ['b1'] } });
await client.syncUntilIdle();
```

On Node, pass `new NodeSqliteDatabase(path)` from `@syncular/server/sqlite` instead of `BunSqliteDatabase`. A `crdt` column needs the same `crdtMergers` a remote server takes ([CRDT columns](/concepts-crdt/)).

The authority grants every scope value to its one local actor and has no realtime channel, blob routes, validators, reactions, or remote operations. Drive rounds with `syncUntilIdle()` or the shared scheduler ([Server-side clients](/guide-server-clients/)).

::checkpoint[After `client.mutate(...)` and `syncUntilIdle()`, `client.pendingCommits()` is empty.]

Measured on an Apple M-series laptop with Bun 1.4.4 and file-backed databases: one `mutate` followed by `syncUntilIdle()` returned with the row delivered in 2.05 ms at p50 and 2.97 ms at p95 over 500 writes. After 100,500 rows in 700 commits, the replica held 11.1 MB and the authority 51.0 MB, because the authority keeps at least 1,000 commits of change log (SPEC §4.6). A fresh client bootstrapped all 100,500 rows from the authority in 161 ms.

## Upgrade the schema

Ship the new generated schema and open both components with it. `openLocalAuthority` migrates the authority's tables in place (added tables and appended nullable columns), and the client runs its ordinary reset and bootstraps from the authority. Every acknowledged row survives.

A queued insert that the client recorded before an upgrade that appends a column does not survive: it re-encodes without the new column, and the authority refuses it as a partial insert with `sync.row_missing`. Run `syncUntilIdle()` before closing the app so the outbox is empty when the next version opens.

## Choose scope values the remote server will grant

The authority grants every scope value, and the remote server does not. Before attach, the remote server's `resolveScopes` must grant the attaching actor every scope value the local rows carry; a denied row stops attach with `sync.forbidden`. Generate an owner ID on the device, use it as the scope value, and register it to the account when the user signs up.

## Attach a remote server

```ts title="src/attach.ts"
import { httpSegmentDownloader, httpSyncTransport } from '@syncular/client';

const headers = { Authorization: `Bearer ${token}` };

await client.syncUntilIdle();
client.setTransportEnabled(false);
await authority.attach(
  httpSyncTransport('https://api.example.com/sync', { headers }),
);
```

`attach` stops the authority from serving the client, then uploads every live row as an insert, parents before children, in commits of at most 500 operations. Rows that reference each other in a cycle travel in one commit. The uploads use stable commit IDs: after a crash or a lost response, call `attach` again and the remote server answers the commits it already applied with `cached`.

When `attach` resolves, `authority.state` is `attached`. Reopen the client against the remote server over the same replica file:

```ts title="src/attach.ts"
await client.close();
const remote = new SyncClient({
  database: openSqliteDatabase('./data/replica.sqlite'),
  schema,
  clientId: 'device-1',
  transport: httpSyncTransport('https://api.example.com/sync', { headers }),
  segments: httpSegmentDownloader('https://api.example.com/segments', { headers }),
});
await remote.start();
await remote.syncUntilIdle();
```

The remote server's log epoch differs from the authority's, so the first round resets the replica: the client discards its synced rows, keeps its client ID and outbox, and bootstraps from the remote server. Delete `./data/authority.sqlite` afterwards.

Writes made while attaching wait in the outbox and push after the reset. A write that carries `baseVersion` names an authority version, and every attached row starts at version 1 on the remote server, so a `baseVersion` above 1 is refused with `sync.invalid_request`. Queue only unversioned writes while attaching.

## When attach stops

`attach` rejects with a `LocalAuthorityAttachError` whose `code` is `sync.attach_rejected` and whose `details.reason` names the cause:

| `reason` | Cause | Next step |
|---|---|---|
| `commit_rejected` | The remote server refused a commit; `details.code` and `details.opIndex` name the operation | Abandon, fix the data or the server, discard the partial remote data, attach again |
| `cycle_too_large` | More than 500 rows reference each other in one cycle | Break the cycle locally, then attach |
| `schema_floor` | The remote server does not serve this schema version | Deploy the matching server version, then call `attach` again |
| `request_failed` | The remote server answered with an error frame; `details.code` names it | Fix the cause, then call `attach` again |
| `log_epoch_changed` | The remote partition's log was reset during the upload | Abandon, discard the partial remote data, attach again |

A transport failure rejects with the transport's own error and leaves the attach resumable. A refused commit is final for that attach: the remote server stores the rejection under the commit's idempotency key and returns it again on every retry. `authority.abandonAttach()` returns the authority to serving the client, and the next `attach` starts a new upload with new commit IDs. Rows a remote server already applied stay there, so discard that partition before the next attach, or the new inserts conflict with them.
