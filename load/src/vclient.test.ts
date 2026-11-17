/**
 * `HttpVClient.push` encodes app-defined commits by column name: one request
 * carries several commits, each applies, and the server stores the values
 * the operations named. An in-process server over in-memory SQLite.
 */
import { afterAll, expect, test } from 'bun:test';
import {
  MemorySegmentStore,
  SqliteServerStorage,
  type ValidateCommitInput,
} from '@syncular/server';
import { createSyncularHono } from '@syncular/server-hono';
import { COLUMNS, SCHEMA, TABLE } from './fixture';
import { HttpVClient } from './vclient';

const storage = new SqliteServerStorage(':memory:');
const validated: ValidateCommitInput['operations'][] = [];
const hono = createSyncularHono({
  config: {
    schema: SCHEMA,
    storage,
    segments: new MemorySegmentStore(),
    resolveScopes: () => ({ project_id: ['*'] }),
    commitValidator: ({ operations }) => {
      validated.push(operations);
    },
  },
  authenticate: async () => ({ actorId: 'a', partition: 'p' }),
});
const server = Bun.serve({ port: 0, fetch: (request) => hono.fetch(request) });
afterAll(async () => {
  await server.stop(true);
  storage.db.close();
});

test('push sends app-defined commits in one request', async () => {
  const client = new HttpVClient({
    baseUrl: `http://127.0.0.1:${server.port}`,
    clientId: 'push-test',
    schemaVersion: SCHEMA.version,
    headers: { 'x-test': '1' },
  });
  client.subscribe({ project_id: 'p1' });
  await client.pull();
  const row = (id: string, title: string) => ({
    table: TABLE,
    rowId: id,
    op: 'upsert' as const,
    values: {
      id,
      project_id: 'p1',
      title,
      done: true,
      priority: 3,
      updated_at_ms: 1,
    },
  });
  const result = await client.push(
    [{ name: TABLE, columns: COLUMNS, primaryKey: 'id' }],
    [[row('r1', 'first'), row('r2', 'second')], [row('r1', 'third')]],
  );
  expect(
    result.message.frames
      .filter((frame) => frame.type === 'PUSH_RESULT')
      .map((frame) => frame.status),
  ).toEqual(['applied', 'applied']);
  expect(validated.map((operations) => operations.map((op) => op.row))).toEqual(
    [
      [
        {
          id: 'r1',
          project_id: 'p1',
          title: 'first',
          done: true,
          priority: 3,
          updated_at_ms: 1,
        },
        {
          id: 'r2',
          project_id: 'p1',
          title: 'second',
          done: true,
          priority: 3,
          updated_at_ms: 1,
        },
      ],
      [
        {
          id: 'r1',
          project_id: 'p1',
          title: 'third',
          done: true,
          priority: 3,
          updated_at_ms: 1,
        },
      ],
    ],
  );
});
