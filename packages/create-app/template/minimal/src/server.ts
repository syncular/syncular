/**
 * The whole sync backend in one Bun process.
 *
 * `createSyncularHono` mounts the protocol routes (POST /sync, GET
 * /segments/:id, PUT|GET /blobs/:id) over the framework-free
 * `@syncular/server` core. Storage is bun:sqlite; the server manages its
 * own `sync_*` tables — the app migration (migrations/0001_initial) only feeds
 * typegen the schema SHAPE, it is never run here.
 *
 * EDIT FIRST: `resolveScopes` is the whole authorization story. It runs in
 * YOUR backend, next to YOUR auth, and decides which scope values an actor may
 * see. Here the demo actor may see every list (`['*']`); a real backend
 * returns the lists the authenticated user belongs to. `authenticate` is where
 * you plug in your real session/token check.
 */
import {
  ensureSyncServerReady,
  MemorySegmentStore,
  SqliteServerStorage,
  type SyncServerConfig,
} from '@syncular/server';
import { createSyncularHono } from '@syncular/server-hono';
import { schema } from './syncular.generated';

const config: SyncServerConfig = {
  schema,
  storage: new SqliteServerStorage(process.env.DB_PATH ?? ':memory:'),
  segments: new MemorySegmentStore(),
  resolveScopes: () => ({ list_id: ['*'] }),
};

const app = createSyncularHono({
  config,
  // Replace with your real auth: return { actorId, partition } or null (401).
  authenticate: async () => ({ actorId: 'demo-user', partition: 'demo' }),
});

const port = Number(process.env.PORT ?? 8787);
await ensureSyncServerReady(config);
Bun.serve({ port, fetch: app.fetch });
console.log(`sync server: http://localhost:${port}`);
