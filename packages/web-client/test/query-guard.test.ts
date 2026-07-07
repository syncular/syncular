/**
 * I3 (DESIGN-queries.md): the public `client.query()` is a guarded
 * read-only, single-statement surface. Writes must go through `mutate`
 * (outbox, SPEC §7.1); multi-statement strings must never reach
 * sqlite-wasm's run-them-all `exec`.
 */
import { describe, expect, test } from 'bun:test';
import { assertReadOnlyQuery, RawSqlError } from '@syncular/client';
import { makeClient, makeServer, taskValues } from './helpers';

describe('assertReadOnlyQuery', () => {
  test('allows the read-only verbs', () => {
    for (const sql of [
      'SELECT 1',
      '  select * from tasks',
      'WITH x AS (SELECT 1) SELECT * FROM x',
      'WITH x AS (SELECT 1), y AS (SELECT 2) SELECT * FROM x, y',
      'WITH RECURSIVE c(n) AS (VALUES (1)) SELECT n FROM c',
      'EXPLAIN QUERY PLAN SELECT 1',
      'PRAGMA table_info(tasks)',
      'VALUES (1), (2)',
      '-- leading comment\nSELECT 1',
      '/* block */ SELECT 1',
    ]) {
      expect(() => assertReadOnlyQuery(sql)).not.toThrow();
    }
  });

  test('rejects writes, DDL, transactions, and vacuum', () => {
    for (const sql of [
      "INSERT INTO tasks (id) VALUES ('t1')",
      "UPDATE tasks SET title = 'x'",
      'DELETE FROM tasks',
      'DROP TABLE tasks',
      'CREATE TABLE evil (id)',
      'ALTER TABLE tasks ADD COLUMN evil TEXT',
      'BEGIN',
      'VACUUM',
      "REPLACE INTO tasks (id) VALUES ('t1')",
    ]) {
      expect(() => assertReadOnlyQuery(sql)).toThrow(RawSqlError);
    }
  });

  test('a WITH clause cannot smuggle a write (SQLite allows WITH … DELETE)', () => {
    for (const sql of [
      'WITH t AS (SELECT 1) DELETE FROM tasks',
      "WITH t AS (SELECT 1) INSERT INTO tasks (id) SELECT 'x'",
      "WITH t AS (SELECT 1) UPDATE tasks SET title = 'x'",
      "WITH t AS (SELECT 1), u AS (SELECT 2) REPLACE INTO tasks (id) VALUES ('t1')",
    ]) {
      expect(() => assertReadOnlyQuery(sql)).toThrow(RawSqlError);
    }
  });

  test('rejects multi-statement strings (the sqlite-wasm exec hazard)', () => {
    expect(() => assertReadOnlyQuery('SELECT 1; DROP TABLE tasks')).toThrow(
      RawSqlError,
    );
    expect(() => assertReadOnlyQuery('SELECT 1; SELECT 2')).toThrow(
      RawSqlError,
    );
  });

  test('a semicolon inside literals/identifiers/comments is not a boundary', () => {
    for (const sql of [
      "SELECT ';' AS s",
      "SELECT 'it''s; fine'",
      'SELECT "a;b" FROM tasks',
      'SELECT 1 -- trailing; comment',
      'SELECT /* ; */ 1',
      'SELECT [a;b] FROM tasks',
    ]) {
      expect(() => assertReadOnlyQuery(sql)).not.toThrow();
    }
  });

  test('a trailing semicolon (with or without trailing comment) is fine', () => {
    expect(() => assertReadOnlyQuery('SELECT 1;')).not.toThrow();
    expect(() => assertReadOnlyQuery('SELECT 1;  -- done')).not.toThrow();
  });

  test('empty input is rejected', () => {
    for (const sql of ['', '   ', '-- only a comment', ';']) {
      expect(() => assertReadOnlyQuery(sql)).toThrow(RawSqlError);
    }
  });
});

describe('client.query guard (end to end)', () => {
  test('reads work; writes and multi-statements are rejected before the db', async () => {
    const server = makeServer();
    const { client } = await makeClient(server, { clientId: 'guard-client' });
    try {
      client.mutate([
        { table: 'tasks', op: 'upsert', values: taskValues('t1', 'p1') },
      ]);

      const rows = client.query('SELECT id FROM tasks ORDER BY id');
      expect(rows.map((r) => r.id)).toEqual(['t1']);

      expect(() => client.query("UPDATE tasks SET title = 'bypass'")).toThrow(
        RawSqlError,
      );
      expect(() =>
        client.query('SELECT id FROM tasks; DELETE FROM tasks'),
      ).toThrow(RawSqlError);

      // Nothing reached the database: the row is unchanged.
      const [after] = client.query("SELECT title FROM tasks WHERE id = 't1'");
      expect(after?.title).not.toBe('bypass');
    } finally {
      client.close();
    }
  });
});
