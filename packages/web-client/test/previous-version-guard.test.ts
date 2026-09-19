/**
 * RFC 0005 storage boundary: the captured container lives in its own database
 * file and is NOT on the connection `client.query()` uses.
 *
 * This replaced the former EXPLAIN/root-page guard suite. That guard protected
 * an in-replica container, which no longer exists, and the tests that asserted
 * its refusal behaviour described a code path that was deleted with the storage
 * move. What remains real, and is asserted here, is the architectural property
 * itself: an older client's ordinary query connection does not attach this
 * file, so no SQL it runs can reach the container. That is the whole guarantee
 * — it is NOT protection against arbitrary same-origin or native filesystem
 * access.
 */
import { describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type ClientSchema, RawSqlError } from '@syncular/client';
import type { RowColumn } from '@syncular/core';
import type { ServerSchema } from '@syncular/server';
import { makeClient, makeServer } from './helpers';

const CONTAINER = 'syncular_prev_context';
const SCOPES = ['project:{project_id}'] as const;

const COLUMNS_V1: readonly RowColumn[] = [
  { name: 'id', type: 'string', nullable: false },
  { name: 'project_id', type: 'string', nullable: false },
  { name: 'title', type: 'string', nullable: false },
  { name: 'meta', type: 'string', nullable: true },
];

const COLUMNS_V2: readonly RowColumn[] = [
  ...COLUMNS_V1.filter((column) => column.name !== 'meta'),
  { name: 'note', type: 'string', nullable: true },
];

const V1_SCHEMA: ClientSchema = {
  version: 1,
  tables: [
    { name: 'tasks', columns: COLUMNS_V1, primaryKey: 'id', scopes: SCOPES },
  ],
};
const V2_SCHEMA: ClientSchema = {
  version: 2,
  tables: [
    { name: 'tasks', columns: COLUMNS_V2, primaryKey: 'id', scopes: SCOPES },
  ],
};
const V2_SERVER: ServerSchema = { version: 2, tables: V2_SCHEMA.tables };

function tempPath(): string {
  return join(mkdtempSync(join(tmpdir(), 'syncular-guard-')), 'client.db');
}

describe('RFC 0005 container is off the replica query connection', () => {
  test('the replica cannot name it, list it, or read it; ordinary reads work', async () => {
    const server = makeServer(V2_SERVER);
    server.allowed['actor-1'] = { project_id: ['*'] };
    const path = tempPath();

    const seeded = await makeClient(server, {
      clientId: 'guard-boundary',
      databasePath: path,
      schema: V1_SCHEMA,
    });
    seeded.client.mutate([
      {
        table: 'tasks',
        op: 'upsert',
        values: {
          id: 't1',
          project_id: 'p1',
          title: 'task',
          meta: 'm1',
        },
      },
    ]);
    await seeded.client.close();
    seeded.db.close();

    const { client, db } = await makeClient(server, {
      clientId: 'guard-boundary',
      databasePath: path,
      schema: V2_SCHEMA,
      previousVersionContext: { enabled: true },
    });
    try {
      // The capture ran and the feature can read it.
      const snap = client.previousVersionSnapshot({ table: 'tasks' });
      expect(snap.available).toBe(true);
      expect(snap.rows).toHaveLength(1);

      // The replica's own catalog does not list the container.
      expect(
        db.query('SELECT name FROM sqlite_master WHERE name = ?', [CONTAINER]),
      ).toHaveLength(0);
      // Naming it on the replica connection fails at SQLite — there is no table
      // to read and no guard to bypass.
      expect(() => client.query(`SELECT * FROM ${CONTAINER}`)).toThrow();
      // An app query is unaffected.
      expect(client.query('SELECT 1 AS one')).toEqual([{ one: 1 }]);
      expect(
        client.querySnapshot<{ one: number }>({ sql: 'SELECT 1 AS one' }).rows,
      ).toEqual([{ one: 1 }]);
      // The read-only verb guard is still wired through the public tier.
      expect(() => client.query('DELETE FROM tasks')).toThrow(RawSqlError);
    } finally {
      await client.close();
      db.close();
    }
  });
});
