import { afterEach, describe, expect, it } from 'bun:test';
import type { Kysely } from 'kysely';
import { createBunSqliteDb } from '../../dialect-bun-sqlite/src';
import { createClient } from './create-client';
import type { SyncClientDb } from './schema';

interface TasksTable {
  id: string;
  user_id: string;
  title: string;
  server_version: number;
}

interface TestDb extends SyncClientDb {
  tasks: TasksTable;
}

async function createTestDb(): Promise<Kysely<TestDb>> {
  const db = createBunSqliteDb<TestDb>({ path: ':memory:' });
  await db.schema
    .createTable('tasks')
    .addColumn('id', 'text', (col) => col.primaryKey())
    .addColumn('user_id', 'text', (col) => col.notNull())
    .addColumn('title', 'text', (col) => col.notNull())
    .addColumn('server_version', 'integer', (col) => col.notNull().defaultTo(0))
    .execute();
  return db;
}

describe('createClient url normalization', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('accepts sync endpoint URLs without duplicating /sync', async () => {
    const requests: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const request = input instanceof Request ? input : new Request(input);
      requests.push(request.url);
      return new Response(
        JSON.stringify({
          ok: true,
          pull: { ok: true, subscriptions: [] },
        }),
        {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }
      );
    }) as typeof fetch;

    const db = await createTestDb();
    try {
      const { destroy } = await createClient<TestDb>({
        db,
        actorId: 'user-1',
        clientId: 'client-1',
        url: 'http://localhost:4311/api/sync',
        handlers: [
          {
            table: 'tasks',
            subscribe: false,
            async applySnapshot() {},
            async clearAll() {},
            async applyChange() {},
          },
        ],
      });

      destroy();
      expect(requests).toContain('http://localhost:4311/api/sync');
      expect(requests).not.toContain('http://localhost:4311/api/sync/sync');
    } finally {
      await db.destroy();
    }
  });
});
