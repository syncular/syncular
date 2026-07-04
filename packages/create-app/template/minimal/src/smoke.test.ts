/**
 * The template's own smoke test: boots the real Hono server on an ephemeral
 * port and drives two independent bun:sqlite client cores through it over real
 * HTTP, asserting they converge. This runs in the scaffolded app's own `bun
 * test`, AND (because the template lives in the workspace) in the v2 sweep — so
 * the template itself cannot rot.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import {
  MemorySegmentStore,
  SqliteServerStorage,
  type SyncServerConfig,
} from '@syncular-v2/server';
import { createSyncularHono } from '@syncular-v2/server-hono';
import { makeClient } from './make-client';
import { schema } from './syncular.generated';

let server: ReturnType<typeof Bun.serve>;
let baseUrl: string;

beforeAll(() => {
  const config: SyncServerConfig = {
    schema,
    storage: new SqliteServerStorage(':memory:'),
    segments: new MemorySegmentStore(),
    resolveScopes: () => ({ list_id: ['*'] }),
  };
  const app = createSyncularHono({
    config,
    authenticate: async () => ({ actorId: 'demo-user', partition: 'demo' }),
  });
  server = Bun.serve({ port: 0, fetch: app.fetch });
  baseUrl = `http://localhost:${server.port}`;
});

afterAll(() => {
  server.stop(true);
});

test('two clients converge through the server', async () => {
  const a = makeClient(baseUrl, 'client-a');
  const b = makeClient(baseUrl, 'client-b');
  await a.start();
  await b.start();

  const sub = { id: 'notes', table: 'notes', scopes: { list_id: ['welcome'] } };
  a.subscribe(sub);
  b.subscribe(sub);

  a.mutate([
    {
      table: 'notes',
      op: 'upsert',
      values: {
        id: 'note-1',
        list_id: 'welcome',
        body: 'Hello from client A',
        updated_at_ms: Date.now(),
      },
    },
  ]);
  await a.syncUntilIdle();
  await b.syncUntilIdle();

  const rows = b.query('SELECT id, body FROM notes ORDER BY id');
  expect(rows).toEqual([{ id: 'note-1', body: 'Hello from client A' }]);

  await a.close();
  await b.close();
});
