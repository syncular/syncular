# React: install & first sync

Install `@syncular/react`, mount `SyncProvider` around your tree, and render a
first live query. You finish with a component that re-renders when synced rows
change.

::meta{for="React developers who already create a client" time="6 minutes" first="platform-web-install"}

:::terms
- **Provider**: `SyncProvider`, which supplies the client and its reactive store to the hooks.
- **Client resource**: A handle for an asynchronous client. It survives StrictMode and retries a failed startup.
- **Generated query**: A descriptor typegen emits from a `.sql` file, with exact table and scope dependencies.
:::

:::figure{title="Provider states" note="Before your tree renders" ticks}
<div class="d-row">
<div class="node"><span class="t">Pending</span><code>fallback</code> renders</div>
<span class="d-arrow"></span>
<div class="node ok"><span class="t">Ready</span>Your tree renders</div>
</div>
<div class="d-row">
<div class="node bad"><span class="t">Error</span><code>renderError(error, retry)</code></div>
<span class="d-arrow"></span>
<div class="node"><span class="t">Retry</span>Runs the factory again, no new provider</div>
</div>

::caption[A failed startup with no `renderError` or `renderBoundary` throws the error to the nearest React error boundary.]
:::

This page assumes a client from one of the host pages: [Browser](/platform-web-install/),
[Tauri](/platform-tauri-install/), or [React Native](/platform-react-native-install/).

:::::steps
::::step{title="Install the package" time="1 min"}
```sh
bun add @syncular/react
```

React 18 or later is a peer dependency.

::checkpoint[`@syncular/react` appears in your dependencies and your app still builds.]
::::

::::step{title="Mount the provider" time="2 min"}
Pass an already-started client directly:

```tsx title="src/main.tsx"
<SyncProvider client={client}><App /></SyncProvider>
```

For an asynchronous engine, create a resource outside render. The resource is
stable through React StrictMode initialization and retries a failed startup
without replacing the provider:

```tsx title="src/main.tsx"
import { createSyncClientResource, SyncProvider } from '@syncular/react';

const clientResource = createSyncClientResource(() => createClient());

<SyncProvider
  client={clientResource}
  fallback={<p>Starting local database…</p>}
  renderError={(error, retry) => (
    <button onClick={() => void retry()}>Try again: {error.message}</button>
  )}
>
  <App />
</SyncProvider>
```

The application's lifecycle owner calls `clientResource.dispose()` when it no
longer needs the engine. A resource survives React remounts and does not survive
automatic module replacement: keep it in your bundler's HMR data, or dispose the
previous resource before you construct another persistent worker. The Vite
recipe is in [Browser: realtime & lifecycle](/platform-web-realtime/#keep-one-owner-during-hmr).

::checkpoint[The fallback shows while the client starts, then your tree renders.]
::::

::::step{title="Render a live query" time="2 min"}
```tsx title="src/Todos.tsx"
import { useQuery } from '@syncular/react';
import { listTodosQuery } from './syncular.queries';

const todos = useQuery(listTodosQuery, { listId });
```

::checkpoint[`todos.rows` fills after the first sync, and the component re-renders when another client writes a row in the list.]
::::
:::::

## Render boundary

`SyncProvider` also accepts `renderBoundary(state, actions)` for one place that
renders every non-ready state. `state.state` is `starting`, `startup-error`
(with `error` and `retryable`), `migrating`, or `blocked` (with a `reason`:
`client-upgrade-required`, `server-behind`, `incompatible-schema`,
`leader-unreachable`, or `leader-incompatible`). `actions.retry` is present when
the client is a resource. [Troubleshooting](/platform-react-troubleshooting/)
maps each state to its fix.

## Next

- [Reads & writes](/platform-react-reads-writes/): phases, typed mutations, and raw SQL.
- [Realtime & lifecycle](/platform-react-realtime/): status, outcomes, and presence.
