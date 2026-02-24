import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { Kysely, type Kysely as KyselyType } from 'kysely';
import { createSqlite3Dialect, createSqlite3Dialect } from './index';

interface TestDb {
  tasks: {
    id: string;
    title: string;
  };
}

describe('sqlite3 dialect RETURNING behavior', () => {
  let db: KyselyType<TestDb>;

  beforeEach(async () => {
    db = createDatabase<TestDb>({ dialect: createSqlite3Dialect({ path: ':memory:' }), family: 'sqlite' });
    await db.schema
      .createTable('tasks')
      .addColumn('id', 'text', (col) => col.primaryKey())
      .addColumn('title', 'text', (col) => col.notNull())
      .execute();
    await db
      .insertInto('tasks')
      .values({ id: 'task-1', title: 'before' })
      .execute();
  });

  afterEach(async () => {
    await db.destroy();
  });

  it('returns rows for non-select UPDATE ... RETURNING queries', async () => {
    const updated = await db
      .updateTable('tasks')
      .set({ title: 'after' })
      .where('id', '=', 'task-1')
      .returning(['id', 'title'])
      .executeTakeFirstOrThrow();

    expect(updated).toEqual({ id: 'task-1', title: 'after' });
  });

  it('supports direct dialect construction via createSqlite3Dialect', async () => {
    const directDb = new Kysely<TestDb>({
      dialect: createSqlite3Dialect({ path: ':memory:' }),
    });

    try {
      await directDb.schema
        .createTable('tasks')
        .addColumn('id', 'text', (col) => col.primaryKey())
        .addColumn('title', 'text', (col) => col.notNull())
        .execute();

      const inserted = await directDb
        .insertInto('tasks')
        .values({ id: 'task-2', title: 'before' })
        .returning(['id', 'title'])
        .executeTakeFirstOrThrow();

      expect(inserted).toEqual({ id: 'task-2', title: 'before' });
    } finally {
      await directDb.destroy();
    }
  });
});
