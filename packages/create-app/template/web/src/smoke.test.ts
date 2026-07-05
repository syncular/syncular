/**
 * The web template's smoke test. The browser frontend (worker + OPFS) can't
 * run headless in `bun test`, so this proves the piece that CAN rot silently:
 * the server config + generated schema this scaffold ships actually sync. It
 * boots the same server core config as `src/server.ts` on an ephemeral port
 * and drives two bun:sqlite client cores through real HTTP to convergence.
 *
 * The frontend itself is covered by `tsc` (typecheck) and by the demo app /
 * conformance suite in the syncular tree, which exercise the identical
 * worker + OPFS + realtime path.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import {
  httpSegmentDownloader,
  httpSyncTransport,
  SyncClient,
} from '@syncular/client';
import { openBunDatabase } from '@syncular/client/bun';
import {
  MemorySegmentStore,
  SqliteServerStorage,
  type SyncServerConfig,
} from '@syncular/server';
import { createSyncularHono } from '@syncular/server-hono';
import { schema, todoListSubscription } from './syncular.generated';

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

function makeClient(clientId: string): SyncClient {
  return new SyncClient({
    database: openBunDatabase(),
    schema,
    clientId,
    transport: httpSyncTransport(`${baseUrl}/sync`),
    segments: httpSegmentDownloader(`${baseUrl}/segments`),
  });
}

test('two clients converge through the scaffolded server config', async () => {
  const a = makeClient('client-a');
  const b = makeClient('client-b');
  await a.start();
  await b.start();

  const scopes = todoListSubscription.scopes({ listId: 'welcome' });
  a.subscribe({ id: 'todos', table: 'todos', scopes });
  b.subscribe({ id: 'todos', table: 'todos', scopes });

  a.mutate([
    {
      table: 'todos',
      op: 'upsert',
      values: {
        id: 'todo-1',
        list_id: 'welcome',
        title: 'Buy milk',
        done: false,
        position: 1,
        updated_at_ms: Date.now(),
      },
    },
  ]);
  await a.syncUntilIdle();
  await b.syncUntilIdle();

  const rows = b.query('SELECT id, title, done FROM todos ORDER BY id');
  expect(rows).toEqual([{ id: 'todo-1', title: 'Buy milk', done: 0 }]);

  await a.close();
  await b.close();
});
