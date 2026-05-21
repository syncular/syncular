# @syncular/client-expo

Expo TypeScript host binding for the Syncular Rust runtime.

This package re-exports the React Native bridge with Expo naming. It is not a
JavaScript sync engine; the native module must own SQLite, sync, outbox, auth
leases, conflicts, blobs, realtime, and lifecycle.

```ts
import { createSyncularExpoClient } from '@syncular/client-expo';

const client = await createSyncularExpoClient<AppDb>({
  module: SyncularExpo,
});

const tasks = await client.db.selectFrom('tasks').selectAll().execute();
await client.mutations.tasks.update('task-1', { completed: 1 });
await client.leasedMutations.tasks.update('task-1', { title: 'Offline edit' });
await client.resumeFromBackground();
```

The bridge preserves `rowsChanged.changedRows` row/field metadata for app
refresh policy. It does not fake query-observer/live-query support by rerunning
table-level events.

