/**
 * The template's own smoke test: boots the real Hono server on an ephemeral
 * port and drives two independent bun:sqlite client cores through it over real
 * HTTP, asserting they converge. This runs in the scaffolded app's own `bun
 * test`, AND (because the template lives in the workspace) in the repo test sweep — so
 * the template itself cannot rot.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import {
  MemorySegmentStore,
  SqliteServerStorage,
  type SyncServerConfig,
} from '@syncular/server';
import { createSyncularHono } from '@syncular/server-hono';
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

  const sub = {
    id: 'todos',
    table: 'todos',
    scopes: { list_id: ['groceries'] },
  };
  a.subscribe(sub);
  b.subscribe(sub);

  a.mutate([
    {
      table: 'todos',
      op: 'upsert',
      values: {
        id: 'todo-1',
        list_id: 'groceries',
        title: 'Buy milk',
        done: false,
        position: 1,
        updated_at_ms: Date.now(),
      },
    },
  ]);
  await a.syncUntilIdle();
  await b.syncUntilIdle();

  const rows = b.query('SELECT id, title FROM todos ORDER BY id');
  expect(rows).toEqual([{ id: 'todo-1', title: 'Buy milk' }]);

  await a.close();
  await b.close();
});
