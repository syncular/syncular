# React

`@syncular/react` is one hook surface over every client Syncular ships: the
browser worker handle, the direct TypeScript client, the Tauri bridge, and the
React Native bridge. This overview shows how the hooks reach a core and the
calls of a first live query.

::meta{for="React 18+ developers on web, Tauri, or React Native" runs="Whichever client you pass to `SyncProvider`: TypeScript core or Rust core" package="`@syncular/react`, with React 18+ as a peer dependency" threading="Hooks run on the render thread; the client owns the core" time="4 minutes"}

:::terms
- **Client**: Any object that implements `SyncClientLike`: a worker handle, a direct client, or a native bridge.
- **Reactive store**: The client-scoped store the hooks read through `useSyncExternalStore`.
- **Revision**: A monotonic number that identifies one local change batch.
- **Phase**: The state of a query result: `loading`, `partial`, `ready`, or `error`.
:::

## How the pieces connect

:::figure{title="Hooks over one interface" note="Any host, same hooks" ticks}
<div class="d-row">
<div class="node hot"><span class="t">Your components</span><code>useQuery</code>, <code>useMutation</code>, <code>useSyncStatus</code></div>
<span class="d-arrow"></span>
<div class="node"><span class="t">SyncProvider</span>Holds the client and its reactive store</div>
<span class="d-arrow"></span>
<div class="d-stack">
<div class="node ok"><span class="t">Browser</span>Worker handle · TypeScript core</div>
<div class="node cool"><span class="t">Tauri</span>Bridge · Rust core</div>
<div class="node cool"><span class="t">React Native</span>Bridge · Rust core</div>
</div>
</div>

::caption[Every host satisfies one structural interface, `SyncClientLike`, so the hook code never changes with the host.]
:::

The hooks adapt the store with `useSyncExternalStore`. Equal queries share one
local read per revision, stale async results cannot replace newer state, and a
query reads its rows and its required-window completeness from one SQLite
snapshot.

## First live query

[Install & first sync](/platform-react-install/) covers the provider and its
startup handling. The shape:

```tsx title="src/App.tsx"
import { SyncProvider, useQuery } from '@syncular/react';
import { listTodosQuery } from './syncular.queries';

function Todos({ listId }: { listId: string }) {
  const todos = useQuery(listTodosQuery, { listId });
  if (todos.phase === 'loading') return <p>Loading…</p>;
  return (
    <ul>
      {todos.rows.map((todo) => (
        <li key={todo.id}>{todo.title}</li>
      ))}
    </ul>
  );
}

export const App = ({ client }) => (
  <SyncProvider client={client}>
    <Todos listId="groceries" />
  </SyncProvider>
);
```

## The pages of this SDK

| Page | Type | You get |
|---|---|---|
| [Install & first sync](/platform-react-install/) | How-to | The package, the provider, startup handling, and a first query. |
| [Reads & writes](/platform-react-reads-writes/) | How-to | `useQuery`, `useMutation`, `useRawSql`, and the phases of a result. |
| [Realtime & lifecycle](/platform-react-realtime/) | How-to | Status, connectivity, commit outcomes, presence, and sync progress. |
| [Platform specifics](/platform-react-specifics/) | Reference | Re-render rules, the full hook list, the security lifecycle, and router scheduling. |
| [Troubleshooting](/platform-react-troubleshooting/) | Reference | Query phases that stall, startup failures, and blocked clients. |

Client setup lives with each host: [Browser](/platform-web/),
[Tauri](/platform-tauri/), and [React Native](/platform-react-native/). The
[package README](https://github.com/syncular/syncular/tree/main/packages/react)
documents the full API.
