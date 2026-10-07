# React Native: reads & writes

Pass the native client to `SyncProvider` and use the React hooks unchanged. You
finish with a screen that reads local rows and writes through `mutate`, plus the
direct client calls for code outside React.

::meta{for="React Native developers building screens" time="4 minutes" first="platform-react-native-install platform-react-reads-writes"}

:::terms
- **Hook surface**: `useQuery`, `useRawSql`, `useMutation`, `useSyncStatus`, `useCommitOutcomes`, `usePresence`.
- **`SyncClientLike`**: The interface the native client implements, shared with every host.
:::

:::figure{title="Same hooks, native core" note="No React Native specific hook" ticks}
<div class="d-row">
<div class="node hot"><span class="t">SyncProvider</span><code>client={client}</code></div>
<span class="d-arrow"></span>
<div class="node"><span class="t">@syncular/react hooks</span>Identical to the browser</div>
<span class="d-arrow"></span>
<div class="node ok"><span class="t">Native client</span>Rust core, SQLite file</div>
</div>

::caption[The hook semantics, result phases, and mutation helpers are documented once in the React pages.]
:::

:::::steps
::::step{title="Mount the provider" time="1 min"}
```tsx title="App.tsx"
import { SyncProvider } from '@syncular/react';

export function App({ client }) {
  return (
    <SyncProvider client={client}>
      <TodoList />
    </SyncProvider>
  );
}
```

::checkpoint[Components under the provider can call the hooks.]
::::

::::step{title="Read and write with hooks" time="3 min"}
From the example app's `App.tsx`:

```tsx title="TodoList.tsx"
import { useMutation, useRawSql } from '@syncular/react';
import type { TodosRow } from './syncular.generated';

function TodoList() {
  const { mutate } = useMutation();
  const { rows } = useRawSql<TodosRow>(
    'SELECT id, title, done FROM todos WHERE list_id = ? ORDER BY position, id',
    ['groceries'],
  );
  // mutate([{ table: 'todos', op: 'upsert', values: { ... } }])
}
```

`mutate` applies locally at once and queues the commit for the next push.
[React: reads & writes](/platform-react-reads-writes/) covers phases, typed
mutations, and generated queries.

::checkpoint[The list renders the local rows, and a `mutate` call adds a row before any network round trip.]
::::
:::::

## Direct client calls

Outside React, call the client directly. Each method returns a promise:
`subscribe`, `query`, `mutate`, `patch`, `sync`, `syncUntilIdle`, `setWindow`,
`conflicts`, and `statusSnapshot`. Final commit outcomes use the native SQLite
journal: `commitOutcome`, `commitOutcomes`, and `resolveCommitOutcome` survive
process restarts, and `useCommitOutcomes()` observes the journal.

## Collaborative text

The client exposes native CRDT text as typed methods: `crdtText`,
`crdtInsertText`, `crdtDeleteText`, and `crdtApplyUpdate`. The merge model, the
`crdt-yjs` feature flag, and the cross-core convergence guarantees are in
[CRDT columns](/concepts-crdt/).
