import type { SQLiteDBCore } from '@subframe7536/sqlite-wasm';
import { changes, close, lastInsertRowId } from '@subframe7536/sqlite-wasm';
import { SQLITE_ROW } from '@subframe7536/sqlite-wasm/constant';
import type { QueryResult } from 'kysely';
import { parseBigInt } from 'kysely-generic-sqlite';
import { createWebOnMessageCallback } from 'kysely-generic-sqlite/worker-helper-web';

type InitData = {
  fileName: string;
  url?: string;
  useOPFS?: boolean;
};

async function defaultCreateDatabaseFn({
  fileName,
  url,
  useOPFS,
}: InitData): Promise<SQLiteDBCore> {
  const sqlite = await import('@subframe7536/sqlite-wasm');
  const storage = useOPFS
    ? (await import('@subframe7536/sqlite-wasm/opfs')).useOpfsStorage
    : (await import('@subframe7536/sqlite-wasm/idb')).useIdbStorage;
  return sqlite.initSQLiteCore(storage(fileName, { url }));
}

function createRowMapper(
  sqlite: SQLiteDBCore['sqlite'],
  stmt: Parameters<SQLiteDBCore['sqlite']['column_names']>[0]
) {
  const cols = sqlite.column_names(stmt);
  return (row: unknown[]) =>
    Object.fromEntries(cols.map((key, i) => [key, row[i]]));
}

async function queryData(
  core: SQLiteDBCore,
  sql: string,
  parameters?: readonly unknown[]
): Promise<QueryResult<Record<string, unknown>>> {
  const iterator = core.sqlite
    .statements(core.pointer, sql)
    [Symbol.asyncIterator]();
  const first = await iterator.next();
  if (first.done || !first.value) {
    throw new Error('Failed to prepare statement');
  }

  const stmt = first.value;
  try {
    if (parameters?.length) {
      core.sqlite.bind_collection(stmt, Array.from(parameters));
    }

    const size = core.sqlite.column_count(stmt);
    if (size === 0) {
      await core.sqlite.step(stmt);
      return {
        rows: [] as Record<string, unknown>[],
        insertId: parseBigInt(lastInsertRowId(core)),
        numAffectedRows: parseBigInt(changes(core)),
      };
    }

    const mapRow = createRowMapper(core.sqlite, stmt);
    const result: Record<string, unknown>[] = [];
    let idx = 0;
    while ((await core.sqlite.step(stmt)) === SQLITE_ROW) {
      result[idx++] = mapRow(core.sqlite.row(stmt));
    }
    return { rows: result };
  } finally {
    await iterator.return?.();
  }
}

createWebOnMessageCallback(async (initData: InitData) => {
  const core = await defaultCreateDatabaseFn(initData);
  return {
    db: core,
    query: async (
      _isSelect: boolean,
      sql: string,
      parameters?: readonly unknown[]
    ) => await queryData(core, sql, parameters),
    close: async () => await close(core),
    iterator: () => {
      throw new Error('Streaming is not supported by wa-sqlite worker dialect');
    },
  };
});
