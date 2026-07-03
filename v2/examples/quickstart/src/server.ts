/**
 * Quickstart server — the whole sync backend in one Bun process.
 *
 * `createSyncularHono` mounts the §1.1 routes (POST /sync, GET /segments/:id,
 * PUT|GET /blobs/:id) over the framework-free `@syncular-v2/server` core.
 * Storage is bun:sqlite; the server manages its own `sync_*` tables — the
 * app migration (migrations/0001_initial) only feeds typegen the schema
 * SHAPE, it is never run here.
 *
 * `resolveScopes` is the whole authorization story: it runs in YOUR backend,
 * next to YOUR auth, and decides which scope values an actor may see. Here
 * the demo actor may see every list (`['*']`); a real backend returns the
 * lists the authenticated user belongs to.
 */
import {
  MemorySegmentStore,
  SqliteServerStorage,
  type SyncServerConfig,
} from '@syncular-v2/server';
import { createSyncularHono } from '@syncular-v2/server-hono';
import { schema } from './syncular.generated';

const config: SyncServerConfig = {
  schema,
  storage: new SqliteServerStorage(process.env.QUICKSTART_DB ?? ':memory:'),
  segments: new MemorySegmentStore(),
  resolveScopes: () => ({ list_id: ['*'] }),
};

const app = createSyncularHono({
  config,
  // Replace with your real auth: return { actorId, partition } or null (401).
  authenticate: async () => ({ actorId: 'quickstart-user', partition: 'demo' }),
});

const port = Number(process.env.PORT ?? 8787);
Bun.serve({ port, fetch: app.fetch });
console.log(`syncular quickstart server: http://localhost:${port}`);
