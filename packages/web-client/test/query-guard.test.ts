/**
 * The public raw-SQL tier (`query`, `querySnapshot`, `snapshotRead`) runs one
 * statement SQLite reports read-only and refuses PRAGMA before SQLite compiles
 * it. The per-adapter statement lists live in the shared adapter contract
 * (`node-database/adapter-contract.ts`); these tests prove the client surface
 * routes through it.
 */
import { expect, test } from 'bun:test';
import { RawSqlError } from '@syncular/client';
import { BunClientDatabase } from '../src/bun-database';
import { runReadOnly } from '../src/query-guard';
import { makeClient, makeServer, taskValues } from './helpers';

test('reads run; writes, PRAGMA and multi-statements are refused before they change anything', async () => {
  const server = makeServer();
  const { client, db } = await makeClient(server, {
    clientId: 'guard-client',
  });
  try {
    client.mutate([
      { table: 'tasks', op: 'upsert', values: taskValues('t1', 'p1') },
    ]);
    expect(
      client.query('SELECT id FROM tasks ORDER BY id').map((r) => r.id),
    ).toEqual(['t1']);
    expect(
      client.query("SELECT name FROM pragma_table_info('tasks') LIMIT 1"),
    ).toEqual([{ name: 'id' }]);

    for (const sql of [
      "UPDATE tasks SET title = 'bypass'",
      "UPDATE tasks SET title = 'bypass' RETURNING id",
      'DELETE FROM tasks RETURNING id',
      'WITH x$select AS (SELECT 1) DELETE FROM tasks',
      'PRAGMA query_only = ON',
      'EXPLAIN PRAGMA query_only = ON',
      'SELECT id FROM tasks; DELETE FROM tasks',
    ]) {
      expect(() => client.query(sql)).toThrow(RawSqlError);
      expect(() => client.querySnapshot({ sql })).toThrow(RawSqlError);
      expect(() =>
        client.snapshotRead({
          statements: [{ sql: 'SELECT 1 AS one' }, { sql }],
        }),
      ).toThrow(RawSqlError);
    }

    expect(client.query("SELECT title FROM tasks WHERE id = 't1'")).toEqual([
      { title: 'task' },
    ]);
    expect(db.query('PRAGMA query_only')).toEqual([{ query_only: 0 }]);
  } finally {
    await client.close();
  }
});

test('a text proven read-only skips query_only; a refused text never joins; the set stays bounded', () => {
  const pragmas: string[] = [];
  const proven = new Set<string>();
  const readOnlyError = new Error('SQLITE_READONLY');
  const run = (sql: string, write = false) =>
    runReadOnly(
      proven,
      sql,
      (pragma) => pragmas.push(pragma),
      (error) => error === readOnlyError,
      () => {
        if (write) throw readOnlyError;
        return sql;
      },
    );
  expect(run('SELECT 1')).toBe('SELECT 1');
  expect(run('SELECT 1')).toBe('SELECT 1');
  expect(pragmas).toEqual([
    'PRAGMA query_only = ON',
    'PRAGMA query_only = OFF',
  ]);
  // A proven text would surface the raw error; a refused one is refused again.
  expect(() => run('DELETE FROM t', true)).toThrow(RawSqlError);
  expect(() => run('DELETE FROM t', true)).toThrow(RawSqlError);
  for (let index = 0; index < 1_000; index += 1) run(`SELECT ${index}`);
  expect(proven.size).toBeLessThanOrEqual(512);
});

test('bun:sqlite toggles query_only on the first run of a text only', () => {
  const db = new BunClientDatabase();
  const pragmas: string[] = [];
  const run = db.db.run.bind(db.db);
  db.db.run = (sql, ...bindings) => {
    if (sql.includes('query_only')) pragmas.push(sql);
    return run(sql, ...bindings);
  };
  expect(db.queryReadOnly('SELECT 1 AS one')).toEqual([{ one: 1 }]);
  expect(db.queryReadOnly('SELECT 1 AS one')).toEqual([{ one: 1 }]);
  expect(pragmas).toEqual([
    'PRAGMA query_only = ON',
    'PRAGMA query_only = OFF',
  ]);
  db.close();
});
