# Start without a server

A local authority runs the Syncular server inside your app's process over its own SQLite file. The client syncs against it exactly as it syncs against a remote server: writes leave the outbox, declared references cascade, and a schema upgrade rebuilds the replica from the authority. When a remote server exists, attach uploads the authority's rows to it and the client switches over without migrating its storage. This page is for developers who ship an app before its sync backend exists. You finish with a client syncing against a local authority and the attach sequence that moves its data.

::meta{for="App developers shipping before a sync backend exists" time="15 minutes" first="concepts-commits" spec="12"}

:::terms
- **Local authority**: The reference server running in the client's process over its own database, serving one partition (SPEC §12).
- **Attach**: The one-time upload of the authority's rows to a remote server (SPEC §12.3).
- **Remote server**: The server the client syncs with after attach.
:::

The local authority ships in `@syncular/server` for Bun, Node 22.13 or newer, and the browser worker, and in the `syncular-authority` Rust crate for the native cores (Tauri, Swift, Kotlin, Flutter, React Native, the C FFI).

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

## In the browser

The browser client runs in a worker, so the worker entry opens the authority. Pass `openLocalAuthority` to `startSyncWorker`:

```ts title="src/worker.ts"
import { startSyncWorker } from '@syncular/client/worker';
import { clientSqliteDatabase, openLocalAuthority } from '@syncular/server';

startSyncWorker({
  openLocalAuthority: (database, schema) =>
    openLocalAuthority({ database: clientSqliteDatabase(database), schema }),
});
```

Only a worker entry that imports `openLocalAuthority` bundles the server code. Measured with `bun build --target=browser --minify`, the authority adds 134.6 KB minified and 36.3 KB gzipped to a bundle that already holds the client core.

Create the handle with `localAuthority: true`. `endpoints.syncUrl` names the remote server that attach uploads to:

```ts title="src/sync.ts"
export const handle = await createSyncClientHandle({
  worker: () =>
    new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' }),
  schema,
  database: { mode: 'persistent', name: 'my-app' },
  endpoints: { syncUrl: '/sync', segmentsUrl: '/segments' },
  localAuthority: true,
  autoSync: true,
});
```

The worker opens the authority in a sibling OPFS file beside the replica and routes every round to it. Without the override, `createSyncClientHandle` rejects with `client.local_authority_unconfigured`. While the authority serves the client, the worker connects no realtime socket. `handle.localAuthorityState()` returns `local`, `attaching`, or `attached`.

`handle.attachLocalAuthority()` holds the client's rounds, uploads the rows with the headers set through `setHeaders`, and then routes rounds to `endpoints.syncUrl`, where the replica rebinds through the log-epoch reset. After attach the authority file keeps only its state, so the page keeps passing `localAuthority: true` and the worker keeps syncing with the remote server. `handle.abandonLocalAuthorityAttach()` rolls a stopped attach back ([When attach stops](#when-attach-stops)).

## In a native app

The native cores open the Rust authority when the client config names `localAuthorityPath`, the authority's own SQLite file beside the replica. `baseUrl` names the remote server that attach uploads to. Rounds reach the authority until attach completes, and the remote server afterwards. While the authority serves the client, realtime and segment downloads are unavailable. Every binding exposes the same three calls:

- `localAuthorityState()`: `local`, `attaching`, `attached`, or none without `localAuthorityPath`.
- `attachLocalAuthority()`: uploads the rows to `baseUrl` with the current headers, then routes rounds there.
- `abandonLocalAuthorityAttach()`: rolls a stopped attach back.

Measured on an Apple M6 (12 cores, 16 GB, macOS 27.0.1) with Rust 1.99.1, a release build, and file-backed databases: one `mutate` followed by a sync until idle delivered the row in 1.41 ms at p50 and 1.99 ms at p95 over 500 writes. After 100,500 rows in 700 commits (500 single-row commits, then 200 commits of 500 rows) the replica held 18.9 MB and the authority 38.9 MB, and the authority retained all 700 commits under the SPEC §4.6 floor of 1,000. Writing the 100,000 bulk rows took 8.4 s, of which the authority's push handler used about 4.3 ms per 500-row commit. A fresh client bootstrapped all 100,500 rows from the authority's inline rows segments in 340 ms, and attach uploaded them to a second authority in 1.03 s. Four runs ranged from 315 to 614 ms for bootstrap and from 0.97 to 1.79 s for attach. Write latency p50 ranged from 1.17 to 1.53 ms. Re-run with `cargo run --release -p syncular-bench --bin authority-bench` in `rust/` ([benchmarks](https://github.com/syncular/syncular/blob/main/bench/README.md)).

A native build without the `local-authority` feature refuses a `localAuthorityPath` config with `client.local_authority_unconfigured`. The Rust authority serves bootstrap rows inline and builds no SQLite images. The per-platform field names and call signatures are on the [Swift](/platform-swift-specifics/#local-authority), [Kotlin](/platform-kotlin-specifics/#local-authority), [Flutter](/platform-flutter-specifics/#local-authority), [React Native](/platform-react-native-specifics/#local-authority), [Tauri](/platform-tauri-specifics/#local-authority), [Rust](/platform-rust-specifics/#local-authority), and [C FFI](/platform-ffi/#local-authority) pages.

## Upgrade the schema

Ship the new generated schema and open both components with it. `openLocalAuthority` migrates the authority's tables in place (added tables and appended nullable columns), and the client runs its ordinary reset and bootstraps from the authority. Every acknowledged row survives.

A write still queued at the upgrade replays after it. A queued insert stores NULL in the appended columns, and a queued update leaves them unchanged ([Appended columns](/concepts-schema-upgrades/#appended-columns)).

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

The remote server's log epoch differs from the authority's, so the first round resets the replica: the client discards its synced rows, keeps its client ID and outbox, and bootstraps from the remote server. After attach the authority file keeps only its state; delete `./data/authority.sqlite` once the client runs against the remote server.

Writes made while attaching wait in the outbox and push after the reset. A write that carries `baseVersion` names an authority version, and every attached row starts at version 1 on the remote server, so a `baseVersion` above 1 is refused with `sync.invalid_request`. Queue only unversioned writes while attaching.

## When attach stops

`attach` rejects with a `LocalAuthorityAttachError` whose `code` is `sync.attach_rejected` and whose `details.reason` names the cause:

| `reason` | Cause | Next step |
|---|---|---|
| `commit_rejected` | The remote server refused a commit; `details.code` and `details.opIndex` name the operation | Abandon with the transport, fix the data or the server, attach again |
| `cycle_too_large` | More than 500 rows reference each other in one cycle | Break the cycle locally, then attach |
| `schema_floor` | The remote server does not serve this schema version | Deploy the matching server version, then call `attach` again |
| `request_failed` | The remote server answered with an error frame; `details.code` names it | Fix the cause, then call `attach` again |
| `log_epoch_changed` | The remote partition's log was reset during the upload | Abandon with the transport, attach again |

A transport failure rejects with the transport's own error and leaves the attach resumable. A refused commit is final for that attach: the remote server stores the rejection under the commit's idempotency key and returns it again on every retry.

`authority.abandonAttach(transport)` ends a stopped attach. Pass the same remote transport: the authority deletes every row the remote server applied from this attach, children before parents, and then serves the client again. The remote server keeps a tombstone per deleted row, and the next `attach` recreates the rows under new commit IDs. When no upload request reached the remote server, `abandonAttach()` needs no transport. A rollback delete the remote server refuses, for example a `RESTRICT` reference from a row another client added, stops `abandonAttach` with `sync.attach_rejected` and leaves the attach in place.
