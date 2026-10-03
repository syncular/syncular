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
    commit_id TEXT NOT NULL, idx INTEGER NOT NULL,
    tbl TEXT NOT NULL, id TEXT NOT NULL, at INTEGER NOT NULL,
    op TEXT NOT NULL, intent TEXT, base TEXT, version INTEGER,
    PRIMARY KEY(commit_id, idx))`);
}

export function retainedBaseWrite(
  db: ClientDatabase,
  table: string,
  rowId: string,
  values?: Readonly<Record<string, JsonRowValue>>,
  version?: number,
): void {
  db.exec(
    'UPDATE _syncular_failed_rows SET base = ?, version = ? WHERE tbl = ? AND id = ?',
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
  commit: OutboxCommit,
  images: readonly OutboxBeforeImage[],
): void {
  for (const [index, operation] of commit.operations.entries()) {
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
      `INSERT INTO _syncular_failed_rows(commit_id, idx, tbl, id, at, op, intent, base, version)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        commit.clientCommitId,
        index,
        operation.table,
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
  absentIntent = false,
): void {
  const seen = new Set<string>();
  for (const row of db.query(
    'SELECT * FROM _syncular_failed_rows ORDER BY at, commit_id, idx',
  )) {
    const key = JSON.stringify([row.tbl, row.id]);
    if (!absentIntent && seen.has(key)) continue;
    seen.add(key);
    const table = schema.tables.get(String(row.tbl));
    if (!table)
      throw new ClientSyncError(
        'sync.unknown_table',
        'retained intent references an unknown table',
      );
    const json = absentIntent ? row.intent : row.base;
    if (
      absentIntent &&
      (json === null ||
        db.query(
          `SELECT 1 FROM ${quoteIdent(table.name)} WHERE ${quoteIdent(table.primaryKey)} = ?`,
          [String(row.id)],
        ).length)
    )
      continue;
    if (json === null) deleteLocalRow(db, table, String(row.id), false);
    else {
      const values: Record<string, JsonRowValue> = JSON.parse(String(json));
      if (absentIntent) {
        const operation: OutboxOperation = JSON.parse(String(row.op));
        if (
          !table.columns.every((column) =>
            Object.hasOwn(operation.values ?? {}, column.name),
          )
        )
          continue;
      }
      upsertLocalRow(
        db,
        table,
        table.columns.map((column) =>
          jsonToRowValue(values[column.name] ?? null),
        ),
        Number(row.version ?? -1),
        false,
      );
    }
  }
}

export function failedOverlayCommits(db: ClientDatabase): OutboxCommit[] {
  const commits = new Map<
    string,
    {
      seq: number;
      clientCommitId: string;
      createdAtMs: number;
      operations: OutboxOperation[];
    }
  >();
  for (const row of db.query(
    'SELECT * FROM _syncular_failed_rows ORDER BY at, commit_id, idx',
  )) {
    const id = String(row.commit_id);
    const operation: OutboxOperation = JSON.parse(String(row.op));
    const prior = commits.get(id);
    if (prior) prior.operations.push(operation);
    else
      commits.set(id, {
        seq: 0,
        clientCommitId: id,
        createdAtMs: Number(row.at),
        operations: [operation],
      });
  }
  return [...commits.values()];
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
    const json = row.intent ?? row.base;
    if (json === null) continue;
    const values: Record<string, JsonRowValue> = JSON.parse(String(json));
    if (matches(String(row.tbl), values)) ids.add(String(row.commit_id));
  }
  const dropped = failedOverlayCommits(db).filter((commit) =>
    ids.has(commit.clientCommitId),
  );
  for (const id of ids)
    db.exec('DELETE FROM _syncular_failed_rows WHERE commit_id = ?', [id]);
  return dropped;
}
