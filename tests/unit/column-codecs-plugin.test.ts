import { afterEach, describe, expect, it } from 'bun:test';
import { codecs, createColumnCodecsPlugin } from '@syncular/core';
import { createBunSqliteDialect } from '@syncular/dialect-bun-sqlite';
import { Kysely } from 'kysely';

interface TasksRow {
  id: string;
  enabled: number | boolean;
  metadata: string | { tags: string[] };
}

interface FlagsRow {
  id: string;
  enabled: number | boolean;
}

interface TestDb {
  tasks: TasksRow;
  flags: FlagsRow;
}

describe('ColumnCodecsPlugin', () => {
  const db = new Kysely<TestDb>({
    dialect: createBunSqliteDialect({ path: ':memory:' }),
  });
  const dbWithCodecs = db.withPlugin(
    createColumnCodecsPlugin({
      dialect: 'sqlite',
      codecs: (col) => {
        if (col.column === 'enabled') {
          if (col.table === 'tasks' || col.table === 'flags') {
            return codecs.numberBoolean();
          }
          return undefined;
        }
        if (col.table === 'tasks' && col.column === 'metadata') {
          return codecs.stringJson<{ tags: string[] }>();
        }
        return undefined;
      },
    })
  );

  afterEach(async () => {
    await db.schema.dropTable('tasks').ifExists().execute();
    await db.schema.dropTable('flags').ifExists().execute();
  });

  it('applies toDb on insert/update and fromDb on select', async () => {
    await db.schema
      .createTable('tasks')
      .addColumn('id', 'text', (column) => column.primaryKey())
      .addColumn('enabled', 'integer', (column) => column.notNull())
      .addColumn('metadata', 'text', (column) => column.notNull())
      .execute();

    await dbWithCodecs
      .insertInto('tasks')
      .values([
        {
          id: 't1',
          enabled: true,
          metadata: { tags: ['alpha'] },
        },
        {
          id: 't2',
          enabled: false,
          metadata: { tags: ['alpha', 'beta'] },
        },
      ])
      .execute();

    const stored = await db
      .selectFrom('tasks')
      .selectAll()
      .where('id', '=', 't1')
      .executeTakeFirstOrThrow();
    expect(stored.enabled).toBe(1);
    expect(stored.metadata).toBe('{"tags":["alpha"]}');

    const storedFalse = await db
      .selectFrom('tasks')
      .selectAll()
      .where('id', '=', 't2')
      .executeTakeFirstOrThrow();
    expect(storedFalse.enabled).toBe(0);
    expect(storedFalse.metadata).toBe('{"tags":["alpha","beta"]}');

    const selected = await dbWithCodecs
      .selectFrom('tasks')
      .selectAll()
      .where('id', '=', 't1')
      .executeTakeFirstOrThrow();
    expect(selected.enabled).toBe(true);
    expect(selected.metadata).toEqual({ tags: ['alpha'] });

    await dbWithCodecs
      .updateTable('tasks')
      .set({
        enabled: false,
        metadata: { tags: ['beta'] },
      })
      .where('id', '=', 't1')
      .execute();

    const updatedStored = await db
      .selectFrom('tasks')
      .selectAll()
      .where('id', '=', 't1')
      .executeTakeFirstOrThrow();
    expect(updatedStored.enabled).toBe(0);
    expect(updatedStored.metadata).toBe('{"tags":["beta"]}');
  });

  it('applies fromDb for aliased selections and returning clauses', async () => {
    await db.schema
      .createTable('tasks')
      .addColumn('id', 'text', (column) => column.primaryKey())
      .addColumn('enabled', 'integer', (column) => column.notNull())
      .addColumn('metadata', 'text', (column) => column.notNull())
      .execute();

    await db
      .insertInto('tasks')
      .values({
        id: 't2',
        enabled: 1,
        metadata: '{"tags":["gamma"]}',
      })
      .execute();

    const aliased = await dbWithCodecs
      .selectFrom('tasks as t')
      .select(['t.enabled as isEnabled', 't.metadata as meta'])
      .where('t.id', '=', 't2')
      .executeTakeFirstOrThrow();
    expect(aliased.isEnabled).toBe(true);
    expect(aliased.meta).toEqual({ tags: ['gamma'] });

    const returned = await dbWithCodecs
      .updateTable('tasks')
      .set({
        enabled: false,
        metadata: { tags: ['delta'] },
      })
      .where('id', '=', 't2')
      .returning(['enabled', 'metadata'])
      .executeTakeFirstOrThrow();
    expect(returned.enabled).toBe(false);
    expect(returned.metadata).toEqual({ tags: ['delta'] });
  });

  it('applies fromDb on insert returning and delete returning', async () => {
    await db.schema
      .createTable('tasks')
      .addColumn('id', 'text', (column) => column.primaryKey())
      .addColumn('enabled', 'integer', (column) => column.notNull())
      .addColumn('metadata', 'text', (column) => column.notNull())
      .execute();

    const inserted = await dbWithCodecs
      .insertInto('tasks')
      .values({
        id: 't3',
        enabled: true,
        metadata: { tags: ['inserted'] },
      })
      .returning(['enabled as insertedEnabled', 'metadata as insertedMeta'])
      .executeTakeFirstOrThrow();
    expect(inserted.insertedEnabled).toBe(true);
    expect(inserted.insertedMeta).toEqual({ tags: ['inserted'] });

    const deleted = await dbWithCodecs
      .deleteFrom('tasks')
      .where('id', '=', 't3')
      .returning(['enabled as removedEnabled', 'metadata as removedMeta'])
      .executeTakeFirstOrThrow();
    expect(deleted.removedEnabled).toBe(true);
    expect(deleted.removedMeta).toEqual({ tags: ['inserted'] });
  });

  it('keeps ambiguous selectAll columns raw and transforms explicit aliases', async () => {
    await db.schema
      .createTable('tasks')
      .addColumn('id', 'text', (column) => column.primaryKey())
      .addColumn('enabled', 'integer', (column) => column.notNull())
      .addColumn('metadata', 'text', (column) => column.notNull())
      .execute();
    await db.schema
      .createTable('flags')
      .addColumn('id', 'text', (column) => column.primaryKey())
      .addColumn('enabled', 'integer', (column) => column.notNull())
      .execute();

    await db
      .insertInto('tasks')
      .values({
        id: 't4',
        enabled: 1,
        metadata: '{"tags":["joined"]}',
      })
      .execute();
    await db
      .insertInto('flags')
      .values({
        id: 't4',
        enabled: 0,
      })
      .execute();

    const joined = await dbWithCodecs
      .selectFrom('tasks')
      .innerJoin('flags', 'flags.id', 'tasks.id')
      .selectAll()
      .select([
        'tasks.enabled as taskEnabled',
        'flags.enabled as flagEnabled',
        'tasks.metadata as taskMeta',
      ])
      .where('tasks.id', '=', 't4')
      .executeTakeFirstOrThrow();

    expect(typeof joined.enabled).toBe('number');
    expect(joined.taskEnabled).toBe(true);
    expect(joined.flagEnabled).toBe(false);
    expect(joined.taskMeta).toEqual({ tags: ['joined'] });
  });

  it('uses dialect-specific codec overrides for query/result transforms', async () => {
    await db.schema
      .createTable('tasks')
      .addColumn('id', 'text', (column) => column.primaryKey())
      .addColumn('enabled', 'integer', (column) => column.notNull())
      .addColumn('metadata', 'text', (column) => column.notNull())
      .execute();

    const dbWithDialectOverride = db.withPlugin(
      createColumnCodecsPlugin({
        dialect: 'postgres',
        codecs: (col) => {
          if (col.table !== 'tasks' || col.column !== 'metadata') {
            return undefined;
          }
          return {
            ts: 'string',
            toDb: (value: string) => `sqlite:${value}`,
            fromDb: (value: string) => value.replace(/^sqlite:/, ''),
            dialects: {
              postgres: {
                toDb: (value: string) => `pg:${value}`,
                fromDb: (value: string) => value.replace(/^pg:/, ''),
              },
            },
          };
        },
      })
    );

    await dbWithDialectOverride
      .insertInto('tasks')
      .values({
        id: 'dialect-1',
        enabled: 1,
        metadata: 'hello',
      })
      .execute();

    const stored = await db
      .selectFrom('tasks')
      .select(['metadata'])
      .where('id', '=', 'dialect-1')
      .executeTakeFirstOrThrow();
    expect(stored.metadata).toBe('pg:hello');

    const selected = await dbWithDialectOverride
      .selectFrom('tasks')
      .select(['metadata'])
      .where('id', '=', 'dialect-1')
      .executeTakeFirstOrThrow();
    expect(selected.metadata).toBe('hello');
  });

  it('leaves rows unchanged when resolver returns no codecs', async () => {
    await db.schema
      .createTable('tasks')
      .addColumn('id', 'text', (column) => column.primaryKey())
      .addColumn('enabled', 'integer', (column) => column.notNull())
      .addColumn('metadata', 'text', (column) => column.notNull())
      .execute();

    await db
      .insertInto('tasks')
      .values({
        id: 'raw-1',
        enabled: 1,
        metadata: '{"tags":["raw"]}',
      })
      .execute();

    const dbWithoutCodecs = db.withPlugin(
      createColumnCodecsPlugin({
        codecs: () => undefined,
      })
    );

    const row = await dbWithoutCodecs
      .selectFrom('tasks')
      .selectAll()
      .where('id', '=', 'raw-1')
      .executeTakeFirstOrThrow();
    expect(row.enabled).toBe(1);
    expect(row.metadata).toBe('{"tags":["raw"]}');
  });
});
