import { ClientSyncError } from './errors';
import type { ClientDatabase } from './database';
import type {
  CompiledClientSchema,
  CompiledClientTable,
  JsonRowValue,
} from './schema';
import {
  mapRowValues,
  fromSqlValue,
  jsonToRowValue,
  quoteIdent,
  rowValueToJson,
  SYNC_VERSION_COLUMN,
  toSqlValue,
} from './schema';
import type { RowValue } from '@syncular/core';
import type { RetainedCommitRow } from './outcomes';
import type {
  OutboxCommit,
  OutboxBeforeImage,
  OutboxOperation,
} from './outbox';
import { deleteLocalRow, upsertLocalRow } from './apply';

/** Protected failure state. The server base advances independently of intent. */
export function ensureFailedOverlaySchema(db: ClientDatabase): void {
  db.exec(
    'CREATE TABLE IF NOT EXISTS _syncular_failed_rows(commit_id TEXT NOT NULL,idx INTEGER NOT NULL,tbl TEXT NOT NULL,id TEXT NOT NULL,at INTEGER NOT NULL,op TEXT NOT NULL,intent TEXT,base TEXT,version INTEGER,unique_conflicts TEXT,PRIMARY KEY(commit_id,idx))',
  );
  if (
    !db
      .query('PRAGMA table_info(_syncular_failed_rows)')
      .some((row) => row.name === 'unique_conflicts')
  )
    db.exec(
      'ALTER TABLE _syncular_failed_rows ADD COLUMN unique_conflicts TEXT',
    );
}

export function retainedBaseWrite(
  db: ClientDatabase,
  table: CompiledClientTable,
  rowId: string,
  values?: Readonly<Record<string, JsonRowValue>>,
  version?: number,
): void {
  db.exec(
    'UPDATE _syncular_failed_rows SET base=?,version=? WHERE tbl=? AND id=?',
    [
      values === undefined ? null : JSON.stringify(values),
      version ?? null,
      table.name,
      rowId,
    ],
  );
  if (!table.indexes.some((index) => index.unique)) return;
  for (const retained of db.query(
    'SELECT commit_id,idx,intent,unique_conflicts FROM _syncular_failed_rows WHERE tbl=?',
    [table.name],
  )) {
    const prior: readonly (Omit<
      NonNullable<RetainedCommitRow['uniqueConflicts']>[number],
      'serverRow'
    > & { serverRow: Readonly<Record<string, JsonRowValue>> })[] =
      retained.unique_conflicts === null
        ? []
        : JSON.parse(String(retained.unique_conflicts));
    const conflicts = prior.filter((conflict) => conflict.rowId !== rowId);
    if (values !== undefined && retained.intent !== null) {
      const intent: Record<string, JsonRowValue> = JSON.parse(
        String(retained.intent),
      );
      conflicts.push(
        ...uniqueConflicts(db, table, mapRowValues(intent, jsonToRowValue))
          .filter((conflict) => conflict.rowId === rowId)
          .map((conflict) => ({
            ...conflict,
            serverRow: mapRowValues(conflict.serverRow, rowValueToJson),
          })),
      );
    }
    db.exec(
      'UPDATE _syncular_failed_rows SET unique_conflicts=? WHERE commit_id=? AND idx=?',
      [
        conflicts.length
          ? JSON.stringify(
              conflicts.sort(
                (a, b) =>
                  table.indexes.findIndex((index) => index.name === a.index) -
                  table.indexes.findIndex((index) => index.name === b.index),
              ),
            )
          : null,
        String(retained.commit_id),
        Number(retained.idx),
      ],
    );
  }
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
      'INSERT INTO _syncular_failed_rows(commit_id,idx,tbl,id,at,op,intent,base,version)VALUES(?,?,?,?,?,?,?,?,?)',
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

/** Match declared keys through SQLite, preserving index affinity and NULL semantics. */
export function uniqueConflicts(
  db: ClientDatabase,
  table: CompiledClientTable,
  values: Readonly<Record<string, RowValue>>,
): NonNullable<RetainedCommitRow['uniqueConflicts']> {
  return table.indexes
    .filter((index) => index.unique)
    .flatMap((index) =>
      db
        .query(
          `SELECT * FROM ${quoteIdent(table.name)} WHERE ${quoteIdent(table.primaryKey)} !=? AND ${index.columns.map((column) => `${quoteIdent(column)} = ?`).join(' AND ')}`,
          [
            toSqlValue(values[table.primaryKey] ?? null),
            ...index.columns.map((column) =>
              toSqlValue(values[column] ?? null),
            ),
          ],
        )
        .map((row) => ({
          index: index.name,
          columns: index.columns,
          rowId: String(row[table.primaryKey]),
          serverRow: Object.fromEntries(
            table.columns.map((column) => [
              column.name,
              fromSqlValue(column, row[column.name] ?? null),
            ]),
          ),
          serverVersion: Number(row[SYNC_VERSION_COLUMN]),
        })),
    );
}

export function restoreFailedBases(
  db: ClientDatabase,
  schema: CompiledClientSchema,
  absentIntent = false,
): void {
  const seen = new Set<string>();
  for (const row of db.query(
    'SELECT * FROM _syncular_failed_rows ORDER BY at,commit_id,idx',
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
    if (absentIntent && row.intent !== null) {
      const values: Record<string, JsonRowValue> = JSON.parse(
        String(row.intent),
      );
      const conflicts = uniqueConflicts(
        db,
        table,
        mapRowValues(values, jsonToRowValue),
      );
      // Hydrate a pre-0.30.11 failure after its winner was already imported.
      // Pending and retained overlays cannot supply authoritative row evidence.
      if (row.unique_conflicts === null) {
        const authorized = conflicts.filter(
          (conflict) =>
            conflict.serverVersion >= 0 &&
            !db.query(
              "SELECT 1 FROM _syncular_failed_rows WHERE tbl=? AND id=? UNION ALL SELECT 1 FROM _syncular_outbox,json_each(operations)WHERE json_extract(json_each.value,'$.table')=? AND json_extract(json_each.value,'$.rowId')=? LIMIT 1",
              [table.name, conflict.rowId, table.name, conflict.rowId],
            ).length,
        );
        if (authorized.length)
          db.exec(
            'UPDATE _syncular_failed_rows SET unique_conflicts=? WHERE commit_id=? AND idx=?',
            [
              JSON.stringify(
                authorized.map((conflict) => ({
                  ...conflict,
                  serverRow: mapRowValues(conflict.serverRow, rowValueToJson),
                })),
              ),
              String(row.commit_id),
              Number(row.idx),
            ],
          );
      }
      if (conflicts.length) continue;
    }
    if (
      absentIntent &&
      (json === null ||
        db.query(
          `SELECT 1 FROM ${quoteIdent(table.name)} WHERE ${quoteIdent(table.primaryKey)}=?`,
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
    'SELECT * FROM _syncular_failed_rows ORDER BY at,commit_id,idx',
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
  for (const id of ids) {
    db.exec('DELETE FROM _syncular_failed_rows WHERE commit_id=?', [id]);
    db.exec(
      "UPDATE _syncular_commit_outcomes SET operations=NULL,results='[]' WHERE client_commit_id=?",
      [id],
    );
  }
  return dropped;
}
