/**
 * RFC 0005 D4/A3: the previous-version container is engine-private local data.
 * The public raw-read tier (`query()` / `querySnapshot()`) refuses any statement
 * that reads it, using SQLite's own `EXPLAIN` plan and `sqlite_master` root
 * pages, never a regex over table names.
 */
import { describe, expect, test } from 'bun:test';
import { RawSqlError } from '@syncular/client';
import { BunClientDatabase } from '@syncular/client/bun';
import type { SqlRow, SqlValue } from '@syncular/client';
import { makeClient, makeServer, taskValues } from './helpers';

const CONTAINER = 'syncular_prev_context';

/** Create the exact D3 container (its PRIMARY KEY creates an autoindex). */
function createContainer(db: BunClientDatabase): void {
  db.exec(`CREATE TABLE ${CONTAINER} (
    tbl TEXT NOT NULL,
    row_id TEXT NOT NULL,
    payload TEXT NOT NULL,
    PRIMARY KEY (tbl, row_id))`);
  db.exec(`INSERT INTO ${CONTAINER}(tbl, row_id, payload) VALUES ('tasks','t1','{}')`);
}

function containerPresent(db: BunClientDatabase): boolean {
  return (
    db.query("SELECT 1 AS present FROM sqlite_master WHERE name = ?", [
      CONTAINER,
    ]).length > 0
  );
}

describe('RFC 0005 container access denial', () => {
  test('bare, quoted and schema-qualified name forms are all refused', async () => {
    const server = makeServer();
    const { client, db } = await makeClient(server, { clientId: 'guard-forms' });
    try {
      createContainer(db);
      const statements = [
        `SELECT * FROM ${CONTAINER}`,
        `SELECT * FROM "${CONTAINER}"`,
        `SELECT * FROM [${CONTAINER}]`,
        `SELECT * FROM \`${CONTAINER}\``,
        `SELECT * FROM main.${CONTAINER}`,
        `SELECT * FROM "main"."${CONTAINER}"`,
      ];
      for (const sql of statements) {
        expect(() => client.query(sql)).toThrow(RawSqlError);
      }
    } finally {
      client.close();
    }
  });

  test('CTE, subquery, join and view forms are all refused', async () => {
    const server = makeServer();
    const { client, db } = await makeClient(server, { clientId: 'guard-forms2' });
    try {
      createContainer(db);
      db.exec('CREATE VIEW prev_view AS SELECT * FROM syncular_prev_context');
      const statements = [
        `WITH c AS (SELECT * FROM ${CONTAINER}) SELECT * FROM c`,
        // A CTE NAMED to shadow the table but whose body launders the real one.
        `WITH ${CONTAINER} AS (SELECT * FROM main.${CONTAINER}) SELECT * FROM ${CONTAINER}`,
        `SELECT (SELECT row_id FROM ${CONTAINER} LIMIT 1) AS row_id`,
        `SELECT * FROM tasks JOIN ${CONTAINER} ON ${CONTAINER}.tbl = tasks.id`,
        `SELECT * FROM tasks INNER JOIN ${CONTAINER} ON 1 = 1`,
        `SELECT * FROM tasks LEFT JOIN ${CONTAINER} ON 1 = 1`,
        `SELECT * FROM tasks CROSS JOIN ${CONTAINER}`,
        `SELECT * FROM tasks, ${CONTAINER}`,
        'SELECT * FROM prev_view',
        'SELECT * FROM main.prev_view',
      ];
      for (const sql of statements) {
        expect(() => client.query(sql)).toThrow(RawSqlError);
      }
    } finally {
      client.close();
    }
  });

  test('a covering-index-only plan is refused (index root page, not the table)', async () => {
    const server = makeServer();
    const { client, db } = await makeClient(server, { clientId: 'guard-index' });
    try {
      createContainer(db);
      const rootPages = new Map(
        db
          .query('SELECT name, rootpage FROM sqlite_master WHERE tbl_name = ?', [
            CONTAINER,
          ])
          .map((row) => [String(row.name), Number(row.rootpage)]),
      );
      const indexName = `sqlite_autoindex_${CONTAINER}_1`;
      const tableRoot = Number(rootPages.get(CONTAINER));
      const indexRoot = Number(rootPages.get(indexName));
      expect(Number.isFinite(tableRoot)).toBe(true);
      expect(Number.isFinite(indexRoot)).toBe(true);
      expect(indexRoot).not.toBe(tableRoot);

      // The covering-index plan opens the INDEX root page only.
      const plan = db.query(
        `EXPLAIN QUERY PLAN SELECT tbl, row_id FROM ${CONTAINER}`,
      );
      expect(
        plan.some((row) => String(row.detail).includes('COVERING INDEX')),
      ).toBe(true);
      const opened = db
        .query(`EXPLAIN SELECT tbl, row_id FROM ${CONTAINER}`)
        .filter((row) => row.opcode === 'OpenRead' || row.opcode === 'OpenWrite')
        .map((row) => Number(row.p2));
      expect(opened).toContain(indexRoot);
      expect(opened).not.toContain(tableRoot);

      expect(() =>
        client.query(`SELECT tbl, row_id FROM ${CONTAINER}`),
      ).toThrow(RawSqlError);
    } finally {
      client.close();
    }
  });

  test('attached and temp objects are refused while the container exists', async () => {
    const server = makeServer();
    const { client, db } = await makeClient(server, { clientId: 'guard-attach' });
    try {
      createContainer(db);
      db.exec("ATTACH ':memory:' AS aux");
      db.exec('CREATE TABLE aux.plain (id TEXT)');
      db.exec('CREATE TEMP TABLE temp_plain (id TEXT)');
      expect(() => client.query('SELECT * FROM aux.plain')).toThrow(RawSqlError);
      expect(() => client.query('SELECT * FROM temp_plain')).toThrow(RawSqlError);
      expect(() => client.query(`SELECT * FROM temp.${CONTAINER}`)).toThrow(
        RawSqlError,
      );
      db.exec('DETACH DATABASE aux');
    } finally {
      client.close();
    }
  });

  test('the protected set is re-read per statement, never cached', async () => {
    const server = makeServer();
    const { client, db } = await makeClient(server, { clientId: 'guard-toctou' });
    try {
      createContainer(db);
      expect(() => client.query(`SELECT * FROM ${CONTAINER}`)).toThrow(RawSqlError);
      // Drop and recreate: a new root page. A cache would go stale here.
      db.exec(`DROP TABLE ${CONTAINER}`);
      expect(containerPresent(db)).toBe(false);
      expect(client.query('SELECT 1 AS ok')).toEqual([{ ok: 1 }]);
      createContainer(db);
      expect(containerPresent(db)).toBe(true);
      expect(() => client.query(`SELECT * FROM ${CONTAINER}`)).toThrow(RawSqlError);
    } finally {
      client.close();
    }
  });

  test('querySnapshot and ordinary app reads share the guard', async () => {
    const server = makeServer();
    const { client, db } = await makeClient(server, { clientId: 'guard-snapshot' });
    try {
      client.mutate([
        { table: 'tasks', op: 'upsert', values: taskValues('t1', 'p1') },
      ]);
      createContainer(db);
      expect(() =>
        client.querySnapshot({ sql: `SELECT * FROM ${CONTAINER}` }),
      ).toThrow(RawSqlError);
      // A normal app query is unaffected.
      const rows = client.query('SELECT id FROM tasks ORDER BY id');
      expect(rows.map((row) => row.id)).toEqual(['t1']);
      const snapshot = client.querySnapshot<{ id: string }>({
        sql: 'SELECT id FROM tasks',
      });
      expect(snapshot.rows.map((row) => row.id)).toEqual(['t1']);
    } finally {
      client.close();
    }
  });

  test('a pure CTE that shadows the name without reading the table is allowed (engine truth, no name regex)', async () => {
    const server = makeServer();
    const { client, db } = await makeClient(server, { clientId: 'guard-shadow' });
    try {
      createContainer(db);
      const rows = client.query(
        `WITH ${CONTAINER} AS (SELECT 1 AS x) SELECT x FROM ${CONTAINER}`,
      );
      expect(rows).toEqual([{ x: 1 }]);
    } finally {
      client.close();
    }
  });

  test('EXPLAIN unavailable fails closed while the container exists', async () => {
    class NoExplainDatabase extends BunClientDatabase {
      override query(
        sql: string,
        params: readonly SqlValue[] = [],
      ): SqlRow[] {
        if (sql.trimStart().toUpperCase().startsWith('EXPLAIN')) {
          throw new Error('EXPLAIN unavailable');
        }
        return super.query(sql, params);
      }
    }
    const server = makeServer();
    const database = new NoExplainDatabase();
    const { client } = await makeClient(server, {
      clientId: 'guard-no-explain',
      database,
    });
    try {
      createContainer(database);
      expect(() => client.query('SELECT id FROM tasks')).toThrow(RawSqlError);
    } finally {
      client.close();
    }
  });
});