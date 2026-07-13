# Vite

The browser worker mode runs out of the box under Vite once three
non-obvious pieces are in place: a wasm exclusion, the worker output format,
and a dev proxy for the sync endpoints. This page is the whole setup.

(The packages ship compiled JS to browser bundlers — the `browser` exports
condition points at `dist/` — so webpack, Next.js, and Metro consume them
with stock configs too; the pieces on this page are Vite-specific wiring.)

## vite.config.ts

```ts
import { defineConfig } from 'vite';

export default defineConfig({
  optimizeDeps: {
    // sqlite-wasm locates its .wasm and worker assets relative to its own
    // module URL; Vite's dependency pre-bundling relocates the module and
    // breaks that resolution. Excluding it keeps the package's asset
    // layout intact in dev.
    exclude: ['@sqlite.org/sqlite-wasm'],
  },
  worker: {
    // The sync worker is an ES module (it imports @syncular/client, which
    // code-splits). Vite's default worker format is iife, which rejects
    // module imports at build time.
    format: 'es',
  },
  server: {
    // The dev server proxies the sync endpoints to your syncular server,
    // so the frontend can use same-origin relative URLs in dev and prod.
    proxy: {
      '/sync': 'http://localhost:8787',
      '/segments': 'http://localhost:8787',
      '/blobs': 'http://localhost:8787',
      '/realtime': { target: 'ws://localhost:8787', ws: true },
    },
  },
});
```

Drop `/blobs` if your schema has no `blob_ref` columns, and `/realtime` if
you poll instead of holding a socket.

## The worker and the client

Vite's worker idiom is `new Worker(new URL(...), { type: 'module' })` — the
bundler sees the URL at the call site and emits the worker as its own
bundle. `createSyncClientHandle` takes exactly that as a factory:

```ts
// worker.ts — the whole client core runs in here.
import { startSyncWorker } from '@syncular/client/worker';

startSyncWorker();
```

```ts
// main.ts (or your React provider setup)
import { createSyncClientHandle } from '@syncular/client';
import { schema } from './syncular.generated';

const WS = location.protocol === 'https:' ? 'wss' : 'ws';

const client = await createSyncClientHandle({
  worker: () =>
    new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' }),
  schema,
  database: { mode: 'persistent', name: 'app' }, // OPFS, survives reloads
  endpoints: {
    syncUrl: '/sync',
    segmentsUrl: '/segments',
    realtimeUrl: `${WS}://${location.host}/realtime?clientId={clientId}`,
  },
});
```

The relative endpoint URLs ride the dev proxy in development and your
reverse proxy in production, so nothing changes between the two.

## Headers

The persistent OPFS mode (`opfs-sahpool`) uses `FileSystemSyncAccessHandle`
and needs no COOP/COEP headers — the SharedArrayBuffer requirement
documented by sqlite-wasm applies to its other VFSes. A stock Vite dev
server works as-is.

## Where to go next

- **[Web (browser)](/platform-web/)** — the worker mode, OPFS persistence,
  and multi-tab behavior this page wires up.
- **[React](/platform-react/)** — hand the handle to `SyncProvider` and the
  hooks take over.
- **[Troubleshooting](/troubleshooting/)** — the first-integration
  checklist, including wiping OPFS between tests.
