# @syncular/client-tauri

Tauri TypeScript host binding for the Syncular Rust runtime.

This package adapts Tauri `invoke`/`listen` to the shared
`@syncular/client` shape. It is not a JavaScript sync engine; the native side
must own SQLite, sync, outbox, auth leases, conflicts, blobs, realtime, and
lifecycle.

```ts
import { createSyncularTauriClient } from '@syncular/client-tauri';

const client = await createSyncularTauriClient<AppDb>({
  invoke,
  listen,
});

const tasks = await client.db.selectFrom('tasks').selectAll().execute();
await client.mutations.tasks.update('task-1', { completed: 1 });
await client.leasedMutations.tasks.update('task-1', { title: 'Offline edit' });
await client.resumeFromBackground();
```

The bridge preserves `rowsChanged.changedRows` row/field metadata for app
refresh policy. It does not fake query-observer/live-query support by rerunning
table-level events.

