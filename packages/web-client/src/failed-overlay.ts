import { ClientSyncError } from './errors';
import type { ClientDatabase } from './database';
import type { CompiledClientSchema, JsonRowValue } from './schema';
import { jsonToRowValue, quoteIdent } from './schema';
import type {
  OutboxCommit,
  OutboxBeforeImage,
  OutboxOperation,
} from './outbox';
import { deleteLocalRow, upsertLocalRow } from './apply';

/** Protected failure state. The server base advances independently of intent. */
export function ensureFailedOverlaySchema(db: ClientDatabase): void {
  db.exec(`CREATE TABLE IF NOT EXISTS _syncular_failed_rows(
    client_commit_id TEXT NOT NULL, op_index INTEGER NOT NULL,
    table_name TEXT NOT NULL, row_id TEXT NOT NULL, created_at_ms INTEGER NOT NULL,
    operation_json TEXT NOT NULL, initial_json TEXT, base_json TEXT, base_version INTEGER,
    PRIMARY KEY(client_commit_id, op_index))`);
}

export function retainedBaseWrite(
  db: ClientDatabase,
  table: string,
  rowId: string,
  values?: Readonly<Record<string, JsonRowValue>>,
  version?: number,
): void {
  db.exec(
    'UPDATE _syncular_failed_rows SET base_json = ?, base_version = ? WHERE table_name = ? AND row_id = ?',
    [
      values === undefined ? null : JSON.stringify(values),
      version ?? null,
      table,
      rowId,
    ],
  );
}

export function retainFailedRows(
  db: ClientDatabase,
  schema: CompiledClientSchema,
  commit: OutboxCommit,
  images: readonly OutboxBeforeImage[],
): void {
  for (const [index, operation] of commit.operations.entries()) {
    const table = schema.tables.get(operation.table);
    if (!table)
      throw new ClientSyncError(
        'sync.unknown_table',
        'retained intent references an unknown table',
      );
    const image = images.find((image) => image.opIndex === index);
    const initial =
      operation.op === 'upsert'
        ? { ...image?.values, ...operation.values }
        : undefined;
    if (!image)
      throw new ClientSyncError(
        'sync.local_corrupt',
        'retained intent has no before-image',
      );
    db.exec(
      `INSERT INTO _syncular_failed_rows(client_commit_id, op_index, table_name, row_id, created_at_ms, operation_json, initial_json, base_json, base_version)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        commit.clientCommitId,
        index,
        table.name,
        operation.rowId,
        commit.createdAtMs,
        JSON.stringify(operation),
        initial ? JSON.stringify(initial) : null,
        image.values ? JSON.stringify(image.values) : null,
        image.syncVersion ?? null,
      ],
    );
  }
}

export function restoreFailedBases(
  db: ClientDatabase,
  schema: CompiledClientSchema,
): void {
  const seen = new Set<string>();
  for (const row of db.query(
    'SELECT * FROM _syncular_failed_rows ORDER BY created_at_ms, client_commit_id, op_index',
  )) {
    const key = JSON.stringify([row.table_name, row.row_id]);
    if (seen.has(key)) continue;
    seen.add(key);
    const table = schema.tables.get(String(row.table_name));
    if (!table)
      throw new ClientSyncError(
        'sync.unknown_table',
        'retained intent references an unknown table',
      );
    if (row.base_json === null)
      deleteLocalRow(db, table, String(row.row_id), false);
    else {
      const values: Record<string, JsonRowValue> = JSON.parse(
        String(row.base_json),
      );
      upsertLocalRow(
        db,
        table,
        table.columns.map((column) =>
          jsonToRowValue(values[column.name] ?? null),
        ),
        Number(row.base_version),
        false,
      );
    }
  }
}

export function failedOverlayCommits(db: ClientDatabase): OutboxCommit[] {
  const commits = new Map<string, OutboxCommit>();
  for (const row of db.query(
    'SELECT * FROM _syncular_failed_rows ORDER BY created_at_ms, client_commit_id, op_index',
  )) {
    const id = String(row.client_commit_id);
    const operation: OutboxOperation = JSON.parse(String(row.operation_json));
    const prior = commits.get(id);
    commits.set(id, {
      seq: 0,
      clientCommitId: id,
      createdAtMs: Number(row.created_at_ms),
      operations: [...(prior?.operations ?? []), operation],
    });
  }
  return [...commits.values()];
}

export function restoreAbsentFailedRows(
  db: ClientDatabase,
  schema: CompiledClientSchema,
): void {
  for (const row of db.query(
    'SELECT * FROM _syncular_failed_rows ORDER BY created_at_ms, client_commit_id, op_index',
  )) {
    const table = schema.tables.get(String(row.table_name));
    if (!table)
      throw new ClientSyncError(
        'sync.unknown_table',
        'retained intent references an unknown table',
      );
    if (
      row.initial_json === null ||
      db.query(
        `SELECT 1 FROM ${quoteIdent(table.name)} WHERE ${quoteIdent(table.primaryKey)} = ?`,
        [String(row.row_id)],
      ).length
    )
      continue;
    const values: Record<string, JsonRowValue> = JSON.parse(
      String(row.initial_json),
    );
    upsertLocalRow(
      db,
      table,
      table.columns.map((column) =>
        jsonToRowValue(values[column.name] ?? null),
      ),
      Number(row.base_version ?? -1),
      false,
    );
  }
}

export function dropFailedRows(
  db: ClientDatabase,
  matches: (
    table: string,
    values: Readonly<Record<string, JsonRowValue>>,
  ) => boolean,
): OutboxCommit[] {
  const ids = new Set<string>();
  for (const row of db.query('SELECT * FROM _syncular_failed_rows')) {
    const json = row.initial_json ?? row.base_json;
    if (json === null) continue;
    const values: Record<string, JsonRowValue> = JSON.parse(String(json));
    if (matches(String(row.table_name), values))
      ids.add(String(row.client_commit_id));
  }
  const dropped = failedOverlayCommits(db).filter((commit) =>
    ids.has(commit.clientCommitId),
  );
  for (const id of ids)
    db.exec('DELETE FROM _syncular_failed_rows WHERE client_commit_id = ?', [
      id,
    ]);
  return dropped;
}
