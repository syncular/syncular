import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { codecs, createDatabase } from '@syncular/core';
import type { Kysely } from 'kysely';
import { createBunSqliteDialect } from '../../dialect-bun-sqlite/src';
import { createQueryContext, FingerprintCollector } from './query-public';
import type { SyncClientDb } from './schema';

interface TasksTable {
  id: string;
  enabled: number | boolean;
  metadata: string | { tags: string[] };
}

interface FlagsTable {
  id: string;
  enabled: number | boolean;
  metadata: string | { tags: string[] };
}

interface TestDb extends SyncClientDb {
  tasks: TasksTable;
  flags: FlagsTable;
}

const engine = {
  getMutationTimestamp(): number {
    return 0;
  },
};

function createCodecs() {
  return (column: { table: string; column: string }) => {
    if (column.column === 'enabled') {
      return codecs.numberBoolean();
    }
    if (column.column === 'metadata') {
      return codecs.stringJson<{ tags: string[] }>();
    }
    return undefined;
  };
}

describe('createQueryContext codec decoding', () => {
  let db: Kysely<TestDb>;

  beforeEach(async () => {
    db = createDatabase<TestDb>({
      dialect: createBunSqliteDialect({ path: ':memory:' }),
      family: 'sqlite',
    });

    await db.schema
      .createTable('tasks')
      .addColumn('id', 'text', (col) => col.primaryKey())
      .addColumn('enabled', 'integer', (col) => col.notNull())
      .addColumn('metadata', 'text', (col) => col.notNull())
      .execute();

    await db.schema
      .createTable('flags')
      .addColumn('id', 'text', (col) => col.primaryKey())
      .addColumn('enabled', 'integer', (col) => col.notNull())
      .addColumn('metadata', 'text', (col) => col.notNull())
      .execute();

    await db
      .insertInto('tasks')
      .values({
        id: 'task-1',
        enabled: 1,
        metadata: JSON.stringify({ tags: ['task'] }),
      })
      .execute();

    await db
      .insertInto('flags')
      .values({
        id: 'task-1',
        enabled: 0,
        metadata: JSON.stringify({ tags: ['flag'] }),
      })
      .execute();
  });

  afterEach(async () => {
    await db.destroy();
  });

  it('decodes non-aliased columns from the primary table', async () => {
    const ctx = createQueryContext(
      db,
      new Set(),
      new FingerprintCollector(),
      engine,
      'id',
      'value',
      createCodecs(),
      'sqlite'
    );

    const row = await ctx
      .selectFrom('tasks')
      .selectAll()
      .where('id', '=', 'task-1')
      .executeTakeFirstOrThrow();

    expect(row).toEqual({
      id: 'task-1',
      enabled: true,
      metadata: { tags: ['task'] },
    });
  });

  it('decodes aliased columns selected from the primary table', async () => {
    const ctx = createQueryContext(
      db,
      new Set(),
      new FingerprintCollector(),
      engine,
      'id',
      'value',
      createCodecs(),
      'sqlite'
    );

    const row = await ctx
      .selectFrom('tasks as t')
      .select(['t.enabled as isEnabled', 't.metadata as meta'])
      .where('t.id', '=', 'task-1')
      .executeTakeFirstOrThrow();

    expect(row).toEqual({
      isEnabled: true,
      meta: { tags: ['task'] },
    });
  });

  it('decodes aliased columns selected from joined tables', async () => {
    const ctx = createQueryContext(
      db,
      new Set(),
      new FingerprintCollector(),
      engine,
      'id',
      'value',
      createCodecs(),
      'sqlite'
    );

    const row = await ctx
      .selectFrom('tasks')
      .innerJoin('flags', 'flags.id', 'tasks.id')
      .select(['flags.enabled as flagEnabled', 'flags.metadata as flagMeta'])
      .where('tasks.id', '=', 'task-1')
      .executeTakeFirstOrThrow();

    expect(row).toEqual({
      flagEnabled: false,
      flagMeta: { tags: ['flag'] },
    });
  });
});
