# Browser: install & first sync

Install `@syncular/client`, start the worker, configure Vite, and run a first
sync round against a Syncular server. You finish with a persistent local
database in OPFS and a row that arrived from the server.

::meta{for="Web developers adding the TypeScript client" time="8 minutes" first="platform-web quickstart"}

:::terms
- **Worker entry**: The file that calls `startSyncWorker()` and hosts the core.
- **Generated schema**: The `syncular.generated.ts` module typegen writes from your migrations.
- **Endpoints**: The sync, segment, blob, and realtime URLs the worker calls.
:::

:::figure{title="What you build" note="Four files" ticks}
<div class="d-row">
<div class="node"><span class="t">vite.config.ts</span>Optimizer exclusions, ES worker format, dev proxy</div>
<span class="d-arrow"></span>
<div class="node"><span class="t">worker.ts</span><code>startSyncWorker()</code></div>
<span class="d-arrow"></span>
<div class="node hot"><span class="t">sync.ts</span><code>createSyncClientHandle</code> and the first round</div>
</div>

::caption[Vite emits `worker.ts` as its own bundle because `new Worker(new URL(...))` appears at the call site in `sync.ts`.]
:::

This page assumes a running Syncular server and a generated schema. For the
schema, follow [Add Syncular to an existing app](/add-to-existing-app/); the
scaffolded templates already include it. [Quickstart](/quickstart/) runs the
server.

:::::steps
::::step{title="Install the package" time="1 min"}
```sh
bun add @syncular/client   # or: npm install @syncular/client
```

The package ships compiled JS through the `browser` export condition, so Vite,
webpack, Next.js, and Metro consume it with stock configs. The Vite wiring below
is the only bundler-specific part.

::checkpoint[`@syncular/client` appears in your `package.json` dependencies.]
::::

::::step{title="Add the worker entry" time="1 min"}
The worker file is one line that boots the whole core:

```ts title="src/worker.ts"
import { startSyncWorker } from '@syncular/client/worker';

startSyncWorker();
```

::checkpoint[The file exists and imports without errors.]
::::

::::step{title="Configure Vite" time="3 min"}
Four pieces make the worker mode run under Vite: the optimizer exclusions, the
ES worker format, a dev proxy for the sync endpoints, and (for development) one
HMR owner, covered in [Realtime & lifecycle](/platform-web-realtime/#keep-one-owner-during-hmr).

```ts title="vite.config.ts"
import { SYNCULAR_VITE_OPTIMIZE_DEPS_EXCLUDE } from '@syncular/react/vite';
import { defineConfig } from 'vite';

export default defineConfig({
  optimizeDeps: {
    // sqlite-wasm locates its .wasm and worker assets relative to its own
    // module URL; pre-bundling relocates the module and breaks that lookup.
    exclude: [
      '@sqlite.org/sqlite-wasm',
      ...SYNCULAR_VITE_OPTIMIZE_DEPS_EXCLUDE,
    ],
  },
  worker: {
    // The sync worker is an ES module. Vite's default worker format (iife)
    // rejects module imports at build time.
    format: 'es',
  },
  server: {
    // Same-origin relative URLs in dev and production.
    proxy: {
      '/sync': 'http://localhost:8787',
      '/segments': 'http://localhost:8787',
      '/blobs': 'http://localhost:8787',
      '/realtime': { target: 'ws://localhost:8787', ws: true },
    },
  },
});
```

Drop `/blobs` if your schema has no `blob_ref` columns, and `/realtime` if you
do not hold a socket. `SYNCULAR_VITE_OPTIMIZE_DEPS_EXCLUDE` comes from
`@syncular/react/vite`; install `@syncular/react` even when the app does not
use React.

The persistent mode uses `opfs-sahpool`, which needs no COOP/COEP headers. A
stock Vite dev server works as is.

::checkpoint[`vite build` and `vite dev` start without errors mentioning `sqlite-wasm` or the worker.]
::::

::::step{title="Create the handle and sync" time="3 min"}
`createSyncClientHandle` spawns the worker through the factory and returns the
handle. It takes the Web Locks leader lock first, so there is one core per
origin.

```ts title="src/sync.ts"
import { createSyncClientHandle } from '@syncular/client';
import { schema } from './syncular.generated';

const WS = location.protocol === 'https:' ? 'wss' : 'ws';

export const handle = await createSyncClientHandle({
  worker: () =>
    new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' }),
  schema,
  database: { mode: 'persistent', name: 'my-app' },
  endpoints: {
    syncUrl: '/sync',
    segmentsUrl: '/segments',
    realtimeUrl: `${WS}://${location.host}/realtime?clientId={clientId}`,
  },
  autoSync: true,
});

await handle.subscribe({ id: 'todos', table: 'todos', scopes: { list_id: ['groceries'] } });
await handle.syncUntilIdle();
console.log(await handle.query('SELECT id, title FROM todos ORDER BY id'));
```

The relative endpoint URLs ride the dev proxy in development and your reverse
proxy in production. `database.mode: 'persistent'` stores the file in OPFS; it
survives reloads while the origin stays stored.
[Realtime & lifecycle](/platform-web-realtime/) covers `headers`,
`realtimePolicy`, and the events the page receives.

::checkpoint[The console prints the rows the server holds for `list_id: groceries`. Reload the page: the rows appear again without a network round trip.]
::::
:::::

## Next

- [Reads & writes](/platform-web-reads-writes/): `mutate`, SQL reads, and typed queries.
- [Realtime & lifecycle](/platform-web-realtime/): keep the socket connected and credentials fresh.
- [React](/platform-react/): live queries over this handle.
