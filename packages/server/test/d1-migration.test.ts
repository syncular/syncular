import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import { decodeRow, encodeRow } from '@syncular/core';
import {
  compileSchema,
  D1ServerStorage,
  type CompiledSchema,
  type ServerSchema,
} from '@syncular/server';
import { D1DatabaseDouble } from './d1-double';

const schema: ServerSchema = {
  version: 1,
  tables: [
    {
      name: 'tasks',
      primaryKey: 'id',
      scopes: ['row:{id}'],
      columns: [
        { name: 'id', type: 'string', nullable: false },
        { name: 'title', type: 'string', nullable: false },
      ],
    },
  ],
};
const next = compileSchema({
  version: 2,
  tables: [
    {
      ...schema.tables[0]!,
      columns: [
        ...schema.tables[0]!.columns,
        { name: 'completed', type: 'boolean', nullable: true },
      ],
    },
  ],
});

async function fixture(rows = 70) {
  const raw = new Database(':memory:');
  const db = new D1DatabaseDouble(raw);
  const storage = new D1ServerStorage(db);
  await storage.ensureSchema(compileSchema(schema));
  for (let i = 0; i < rows; i++) {
    const id = `t${String(i).padStart(4, '0')}`;
    const tx = await storage.begin('p1');
    await tx.upsertRow('tasks', {
      rowId: id,
      serverVersion: 1,
      scopes: { id },
      payload: encodeRow(schema.tables[0]!.columns, [id, 'original']),
    });
    await tx.commit();
  }
  return { raw, db, storage };
}

// Each iteration represents a new Worker invocation with a fresh storage instance.
async function finish(
  db: D1DatabaseDouble,
  target: CompiledSchema,
  budget = 50,
) {
  for (let invocation = 0; invocation < 1000; invocation++) {
    db.statementsExecuted = 0;
    db.statementLimit = budget;
    const storage = new D1ServerStorage(db);
    const result = await storage.migrateSchema(target, {
      maxStatements: budget,
    });
    expect(result.statementsExecuted).toBe(db.statementsExecuted);
    expect(db.statementsExecuted).toBeLessThanOrEqual(budget);
    db.statementLimit = Infinity;
    if (result.complete) return storage;
  }
  throw new Error('migration made no progress');
}

describe('D1 migration invocations', () => {
  test('ensureSchema stops before the Free query limit and reports unfinished work', async () => {
    const { db, storage, raw } = await fixture();
    db.statementsExecuted = 0;
    db.statementLimit = 50;
    await expect(storage.ensureSchema(next)).rejects.toMatchObject({
      code: 'sync.storage.schema_migration_pending',
    });
    expect(db.statementsExecuted).toBeLessThanOrEqual(50);
    db.statementLimit = Infinity;
    const ready = await finish(db, next);
    const row = await ready.getRow('p1', 'tasks', 't0069');
    expect(decodeRow(next.tables.get('tasks')!.columns, row!.payload)).toEqual([
      't0069',
      'original',
      null,
    ]);
    raw.close();
  });

  for (const budget of [10, 20, 50, 1000]) {
    test(`resumes fresh storage instances within a ${budget}-statement budget`, async () => {
      const { db, raw } = await fixture();
      await finish(db, next, budget);
      expect(
        raw.query('SELECT schema_version FROM sync_schema_meta').get(),
      ).toEqual({ schema_version: 2 });
      expect(raw.query('SELECT * FROM sync_schema_migration').all()).toEqual(
        [],
      );
      for (const row of raw
        .query<{ _sync_payload: Uint8Array }, []>(
          'SELECT _sync_payload FROM tasks',
        )
        .all()) {
        expect(
          decodeRow(next.tables.get('tasks')!.columns, row._sync_payload).at(
            -1,
          ),
        ).toBeNull();
      }
      raw.close();
    });
  }

  test('a large rewrite stops before the Paid query limit', async () => {
    const { db, raw } = await fixture(1100);
    db.statementsExecuted = 0;
    db.statementLimit = 1000;
    const result = await new D1ServerStorage(db).migrateSchema(next, {
      maxStatements: 1000,
    });
    expect(result.complete).toBe(false);
    expect(result.statementsExecuted).toBe(db.statementsExecuted);
    expect(db.statementsExecuted).toBeLessThanOrEqual(1000);
    const ready = await finish(db, next, 1000);
    const row = await ready.getRow('p1', 'tasks', 't1099');
    expect(decodeRow(next.tables.get('tasks')!.columns, row!.payload)).toEqual([
      't1099',
      'original',
      null,
    ]);
    raw.close();
  });

  test('materialization backfill resumes across tables and partitions', async () => {
    const raw = new Database(':memory:');
    const db = new D1DatabaseDouble(raw);
    const source = {
      version: 1,
      tables: ['tasks', 'notes'].map((name) => ({
        ...schema.tables[0]!,
        name,
        materialize: false,
      })),
    };
    const initial = await finish(db, compileSchema(source), 10);
    for (const partition of ['p1', 'p2']) {
      for (const table of source.tables) {
        for (const rowId of ['a', 'b', 'c']) {
          const tx = await initial.begin(partition);
          await tx.upsertRow(table.name, {
            rowId,
            serverVersion: 1,
            scopes: { id: rowId },
            payload: encodeRow(table.columns, [rowId, partition]),
          });
          await tx.commit();
        }
      }
    }
    const target = compileSchema({
      version: 2,
      tables: source.tables.map((table) => ({ ...table, materialize: true })),
    });
    const ready = await finish(db, target, 10);
    for (const table of source.tables) {
      expect(
        raw
          .query(
            `SELECT id, title FROM "${table.name}" ORDER BY _sync_partition, id`,
          )
          .all(),
      ).toEqual(
        ['p1', 'p2'].flatMap((title) =>
          ['a', 'b', 'c'].map((id) => ({ id, title })),
        ),
      );
      for (const partition of ['p1', 'p2']) {
        expect(
          (await ready.getRow(partition, table.name, 'c'))?.payload,
        ).toEqual(encodeRow(table.columns, ['c', partition]));
      }
    }
    raw.close();
  });

  test('a failed row batch leaves its checkpoint unchanged and can resume', async () => {
    const { db, raw } = await fixture();
    let updates = 0;
    let checkpoint: string | undefined;
    db.beforeBatchStatement = (sql) => {
      if (sql.startsWith('UPDATE "tasks"') && ++updates === 40) {
        checkpoint = raw
          .query<{ state: string }, []>(
            'SELECT state FROM sync_schema_migration',
          )
          .get()?.state;
        throw new Error('injected batch failure');
      }
    };
    await expect(finish(db, next)).rejects.toThrow('injected batch failure');
    expect(updates).toBe(40);
    expect(
      raw.query('SELECT schema_version FROM sync_schema_meta').get(),
    ).toEqual({ schema_version: 1 });
    const saved = raw
      .query<{ state: string }, []>('SELECT state FROM sync_schema_migration')
      .get();
    expect(checkpoint).toBeDefined();
    expect(saved?.state).toBe(checkpoint);
    db.beforeBatchStatement = undefined;
    await finish(db, next);
    for (const row of raw
      .query<{ _sync_payload: Uint8Array }, []>(
        'SELECT _sync_payload FROM tasks',
      )
      .all()) {
      expect(
        decodeRow(next.tables.get('tasks')!.columns, row._sync_payload),
      ).toHaveLength(3);
    }
    raw.close();
  });

  test('a lost reply after a committed rewrite resumes from its saved position', async () => {
    const { db, raw } = await fixture();
    let committedRows = false;
    let lost = false;
    db.beforeBatchStatement = (sql) => {
      if (sql.startsWith('UPDATE "tasks"')) committedRows = true;
    };
    db.afterBatch = () => {
      if (committedRows && !lost) {
        lost = true;
        throw new Error('lost reply');
      }
    };
    await finish(db, next);
    expect(lost).toBe(true);
    expect(
      raw.query('SELECT schema_version FROM sync_schema_meta').get(),
    ).toEqual({ schema_version: 2 });
    raw.close();
  });

  test('a migration fences cached readers and transactions opened under the old schema', async () => {
    const { db, storage, raw } = await fixture(1);
    const tx = await storage.begin('p1');
    await tx.upsertRow('tasks', {
      rowId: 'late',
      serverVersion: 1,
      scopes: { id: 'late' },
      payload: encodeRow(schema.tables[0]!.columns, ['late', 'stale']),
    });
    expect(
      (await new D1ServerStorage(db).migrateSchema(next, { maxStatements: 10 }))
        .complete,
    ).toBe(false);
    await expect(
      storage.ensureSchema(compileSchema(schema)),
    ).rejects.toMatchObject({ code: 'sync.storage.schema_migration_pending' });
    await expect(storage.getRow('p1', 'tasks', 't0000')).rejects.toMatchObject({
      code: 'sync.storage.schema_migration_pending',
    });
    await expect(tx.commit()).rejects.toMatchObject({
      code: 'sync.storage.schema_migration_pending',
    });
    const ready = await finish(db, next);
    await expect(storage.getRow('p1', 'tasks', 't0000')).rejects.toMatchObject({
      code: 'sync.storage.schema_changed',
    });
    await expect(tx.commit()).rejects.toMatchObject({
      code: 'sync.storage.schema_changed',
    });
    expect(await ready.getRow('p1', 'tasks', 'late')).toBeUndefined();
    await tx.rollback();
    raw.close();
  });

  test('competing migration steps converge without rewriting a page twice', async () => {
    const { db, raw } = await fixture();
    raw.exec(`CREATE TABLE rewrites (row_id TEXT);
      CREATE TRIGGER count_rewrites AFTER UPDATE ON tasks BEGIN
        INSERT INTO rewrites VALUES (NEW._sync_row_id);
      END`);
    let complete = false;
    for (let i = 0; i < 100 && !complete; i++) {
      const results = await Promise.all([
        new D1ServerStorage(db).migrateSchema(next),
        new D1ServerStorage(db).migrateSchema(next),
      ]);
      complete = results.some((result) => result.complete);
    }
    expect(complete).toBe(true);
    expect(
      raw
        .query(
          'SELECT COUNT(*) AS count, COUNT(DISTINCT row_id) AS distinct_count FROM rewrites',
        )
        .get(),
    ).toEqual({ count: 70, distinct_count: 70 });
    for (const row of raw
      .query<{ _sync_payload: Uint8Array }, []>(
        'SELECT _sync_payload FROM tasks',
      )
      .all()) {
      expect(
        decodeRow(next.tables.get('tasks')!.columns, row._sync_payload),
      ).toHaveLength(3);
    }
    raw.close();
  });

  test('a delayed claim cannot restart a migration that another request completed', async () => {
    const { db, raw } = await fixture(0);
    const captured = Promise.withResolvers<void>();
    const resume = Promise.withResolvers<void>();
    const prepare = db.prepare.bind(db);
    let held = false;
    db.prepare = (sql) => {
      const statement = prepare(sql);
      if (
        sql ===
        'SELECT schema_version, layouts FROM sync_schema_meta WHERE id=1'
      ) {
        const first = statement.first.bind(statement);
        statement.first = async <T>() => {
          const value = await first<T>();
          if (!held) {
            held = true;
            captured.resolve();
            await resume.promise;
          }
          return value;
        };
      }
      return statement;
    };
    const delayed = new D1ServerStorage(db).migrateSchema(next);
    await captured.promise;
    await finish(db, next);
    resume.resolve();
    expect((await delayed).complete).toBe(false);
    expect(raw.query('SELECT * FROM sync_schema_migration').all()).toEqual([]);
    expect((await new D1ServerStorage(db).migrateSchema(next)).complete).toBe(
      true,
    );
    raw.close();
  });

  test('a delayed row read cannot decode rows another request already migrated', async () => {
    const { db, raw } = await fixture();
    await new D1ServerStorage(db).migrateSchema(next);
    const captured = Promise.withResolvers<void>();
    const resume = Promise.withResolvers<void>();
    const prepare = db.prepare.bind(db);
    let held = false;
    db.prepare = (sql) => {
      const statement = prepare(sql);
      if (sql.includes('AS partition')) {
        const all = statement.all.bind(statement);
        statement.all = async <T>() => {
          if (!held) {
            held = true;
            captured.resolve();
            await resume.promise;
          }
          return all<T>();
        };
      }
      return statement;
    };
    const delayed = new D1ServerStorage(db).migrateSchema(next);
    await captured.promise;
    await finish(db, next);
    resume.resolve();
    expect((await delayed).complete).toBe(false);
    expect(
      raw.query('SELECT schema_version FROM sync_schema_meta').get(),
    ).toEqual({ schema_version: 2 });
    raw.close();
  });

  test('a different migration target cannot take over an unfinished rewrite', async () => {
    const { db, raw } = await fixture(0);
    await new D1ServerStorage(db).migrateSchema(next, { maxStatements: 10 });
    const other = compileSchema({ ...schema, version: 3 });
    await expect(
      new D1ServerStorage(db).migrateSchema(other),
    ).rejects.toMatchObject({ code: 'sync.storage.schema_migration_conflict' });
    await finish(db, next);
    raw.close();
  });

  test('setup and retirement of many tables also respect the invocation budget', async () => {
    const raw = new Database(':memory:');
    const db = new D1DatabaseDouble(raw);
    const many = compileSchema({
      version: 1,
      tables: Array.from({ length: 20 }, (_, i) => ({
        ...schema.tables[0]!,
        name: `table_${i}`,
        indexes: [{ name: `title_${i}`, columns: ['title'] }],
      })),
    });
    await finish(db, many, 10);
    await finish(db, next, 10);
    expect(
      raw
        .query(
          "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'table_%'",
        )
        .all(),
    ).toEqual([]);
    raw.close();
  });

  test('an invalid schema fails before claiming the database', async () => {
    const { db, storage, raw } = await fixture(1);
    const invalid = compileSchema({
      version: 2,
      tables: [
        { ...schema.tables[0]!, columns: [schema.tables[0]!.columns[0]!] },
      ],
    });
    await expect(
      new D1ServerStorage(db).migrateSchema(invalid),
    ).rejects.toThrow('removed columns');
    expect(raw.query('SELECT * FROM sync_schema_migration').all()).toEqual([]);
    expect(await storage.getRow('p1', 'tasks', 't0000')).toBeDefined();
    await finish(db, next);
    raw.close();
  });

  test('invalid budgets fail before issuing a query', async () => {
    const db = new D1DatabaseDouble();
    for (const maxStatements of [0, 9, 1001, 10.5, Number.NaN, Infinity]) {
      await expect(
        new D1ServerStorage(db).migrateSchema(next, { maxStatements }),
      ).rejects.toMatchObject({
        code: 'sync.storage.invalid_migration_budget',
      });
    }
    expect(db.statementsExecuted).toBe(0);
  });
});
