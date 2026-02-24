import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import type { Kysely } from 'kysely';
import type {
  BatchQueryCommand,
  BatchQueryResult,
  FileLoadResult,
  QueryResult as NitroQueryResult,
  NitroSQLiteConnection,
  SQLiteValue,
  Transaction,
} from 'react-native-nitro-sqlite';
import { createNitroSqliteDialect } from './index';

interface TestDb {
  tasks: {
    id: string;
    title: string;
  };
}

function createNitroResult<Row extends Record<string, SQLiteValue>>(
  rows: Row[],
  rowsAffected: number,
  insertId?: number
): NitroQueryResult<Row> {
  return {
    name: 'FakeNitroResult',
    toString: () => 'FakeNitroResult',
    equals: () => false,
    dispose: () => {},
    rowsAffected,
    insertId,
    results: rows,
  };
}

class FakeNitroDatabase implements NitroSQLiteConnection {
  readonly executedSql: string[] = [];
  closed = false;

  close(): void {
    this.closed = true;
  }

  delete(): void {}

  attach(_dbNameToAttach: string, _alias: string, _location?: string): void {}

  detach(_alias: string): void {}

  async transaction<Result>(
    transactionCallback: (tx: Transaction) => Promise<Result>
  ): Promise<Result> {
    const transaction: Transaction = {
      commit: () => createNitroResult<Record<string, SQLiteValue>>([], 0),
      rollback: () => createNitroResult<Record<string, SQLiteValue>>([], 0),
      execute: (query, params) => this.execute(query, params),
      executeAsync: async (query, params) => this.execute(query, params),
    };
    return transactionCallback(transaction);
  }

  execute<
    Row extends Record<string, SQLiteValue> = Record<string, SQLiteValue>,
  >(query: string, _params?: SQLiteValue[]): NitroQueryResult<Row> {
    this.executedSql.push(query);
    if (/\breturning\b/i.test(query)) {
      return createNitroResult([{ id: 'task-1', title: 'after' } as Row], 1, 1);
    }
    return createNitroResult([], 1, 1);
  }

  async executeAsync<
    Row extends Record<string, SQLiteValue> = Record<string, SQLiteValue>,
  >(query: string, params?: SQLiteValue[]): Promise<NitroQueryResult<Row>> {
    return this.execute<Row>(query, params);
  }

  executeBatch(_commands: BatchQueryCommand[]): BatchQueryResult {
    return { rowsAffected: 0 };
  }

  async executeBatchAsync(
    _commands: BatchQueryCommand[]
  ): Promise<BatchQueryResult> {
    return { rowsAffected: 0 };
  }

  loadFile(_location: string): FileLoadResult {
    return {};
  }

  async loadFileAsync(_location: string): Promise<FileLoadResult> {
    return {};
  }
}

describe('nitro sqlite dialect RETURNING behavior', () => {
  let fakeDb: FakeNitroDatabase;
  let db: Kysely<TestDb>;

  beforeEach(() => {
    fakeDb = new FakeNitroDatabase();
    db = createDatabase<TestDb>({ dialect: createNitroSqliteDialect({ database: fakeDb }), family: 'sqlite' });
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
    expect(fakeDb.executedSql).toHaveLength(1);
  });
});
