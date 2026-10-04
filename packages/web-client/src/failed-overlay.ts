import { hasUniqueIndex } from './schema';
import { OUTCOMES_TABLE } from './outcomes';
import { OUTBOX_TABLE } from './outbox';
export const RETAINED_ROWS = '_syncular_failed_rows';
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
    `CREATE TABLE IF NOT EXISTS ${RETAINED_ROWS}(commit_id TEXT NOT NULL,idx INTEGER NOT NULL,tbl TEXT NOT NULL,id TEXT NOT NULL,at INTEGER NOT NULL,op TEXT NOT NULL,intent TEXT,base TEXT,version INTEGER,unique_conflicts TEXT,commit_seq INTEGER,PRIMARY KEY(commit_id,idx))`,
  );
  const columns = db.query(`PRAGMA table_info(${RETAINED_ROWS})`);
  for (const column of ['unique_conflicts TEXT', 'commit_seq INTEGER'])
    if (!columns.some((row) => row.name === column.split(' ')[0]))
      db.exec(`ALTER TABLE ${RETAINED_ROWS} ADD COLUMN ${column}`);
}

export function retainedBaseWrite(
  db: ClientDatabase,
  table: CompiledClientTable,
  rowId: string,
  values?: Readonly<Record<string, JsonRowValue>>,
  version?: number,
): void {
  db.exec(`UPDATE ${RETAINED_ROWS} SET base=?,version=? WHERE tbl=? AND id=?`, [
    values === undefined ? null : JSON.stringify(values),
    version ?? null,
    table.name,
    rowId,
  ]);
  if (!hasUniqueIndex(table)) return;
  for (const retained of db.query(
    `SELECT commit_id,idx,intent,unique_conflicts FROM ${RETAINED_ROWS} WHERE tbl=? AND commit_seq IS NULL`,
    [table.name],
  )) {
    const prior: readonly (Omit<
      NonNullable<RetainedCommitRow['uniqueConflicts']>[number],
      'serverRow'
    > & { serverRow: Readonly<Record<string, JsonRowValue>> })[] =
      retained.unique_conflicts === null
        ? []
        : JSON.parse(retained.unique_conflicts as string);
    const conflicts = prior.filter((conflict) => conflict.rowId !== rowId);
    if (values !== undefined && retained.intent !== null) {
      const intent: Record<string, JsonRowValue> = JSON.parse(
        retained.intent as string,
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
      `UPDATE ${RETAINED_ROWS} SET unique_conflicts=? WHERE commit_id=? AND idx=?`,
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
        retained.commit_id as string,
        Number(retained.idx),
      ],
    );
  }
}

export function retainFailedRows(
  db: ClientDatabase,
  commit: OutboxCommit,
  images: readonly OutboxBeforeImage[],
  commitSeq?: number,
): void {
  for (const [index, operation] of commit.operations.entries()) {
    const image = images.find((image) => image.opIndex === index);
    if (commitSeq !== undefined && (image?.deliverySeq ?? -1) >= commitSeq)
      continue;
    const initial =
      operation.op === 'upsert'
        ? { ...image?.values, ...operation.values }
        : undefined;
    if (!image)
      throw new ClientSyncError(
        'sync.local_corrupt',
        'missing intent before-image',
      );
    db.exec(
      `INSERT INTO ${RETAINED_ROWS}(commit_id,idx,tbl,id,at,op,intent,base,version,commit_seq)VALUES(?,?,?,?,?,?,?,?,?,?)`,
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
        commitSeq ?? null,
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

/** Exact row keys are JSON [table,id]; table scopes include unique-key peers. */
export type OverlayScope = readonly string[];

export function overlayScopePredicate(table: string, id: string): string {
  return `?1 IS NULL OR json_array(${table},${id}) IN(SELECT value FROM json_each(?1)) OR json_array(${table}) IN(SELECT value FROM json_each(?1))`;
}

function retainedRows(
  db: ClientDatabase,
  scope?: OverlayScope,
  acknowledged?: boolean,
) {
  return db.query(
    `SELECT * FROM ${RETAINED_ROWS} WHERE (${overlayScopePredicate('tbl', 'id')})${acknowledged === undefined ? '' : ` AND commit_seq IS${acknowledged ? ' NOT' : ''} NULL`} ORDER BY commit_seq,at,commit_id,idx`,
    [scope ? JSON.stringify(scope) : null],
  );
}

function retainedTable(
  schema: CompiledClientSchema,
  name: string,
): CompiledClientTable {
  const table = schema.tables.get(name);
  if (!table)
    throw new ClientSyncError(
      'sync.unknown_table',
      'retained table is unknown',
    );
  return table;
}

export function restoreFailedBases(
  db: ClientDatabase,
  schema: CompiledClientSchema,
  scope?: OverlayScope,
): boolean {
  const seen = new Set<string>();
  for (const row of retainedRows(db, scope)) {
    const key = JSON.stringify([row.tbl, row.id]);
    if (seen.has(key)) continue;
    seen.add(key);
    const table = retainedTable(schema, row.tbl as string);
    if (row.base === null) deleteLocalRow(db, table, row.id as string, false);
    else {
      const values: Record<string, JsonRowValue> = JSON.parse(String(row.base));
      upsertLocalRow(
        db,
        table,
        table.columns.map((column) =>
          jsonToRowValue(values[column.name] ?? null),
        ),
        (row.version ?? -1) as number,
        false,
      );
    }
  }
  return seen.size > 0;
}

export function failedOverlayCommits(
  db: ClientDatabase,
  acknowledged = false,
  scope?: OverlayScope,
  schema?: CompiledClientSchema,
): OutboxCommit[] {
  const commits = new Map<
    string,
    {
      seq: number;
      clientCommitId: string;
      createdAtMs: number;
      operations: OutboxOperation[];
    }
  >();
  for (const row of retainedRows(db, scope, acknowledged)) {
    const id = row.commit_id as string;
    let operation: OutboxOperation = JSON.parse(row.op as string);
    if (schema && operation.op === 'upsert') {
      const table = retainedTable(schema, operation.table);
      if (acknowledged) {
        if (
          !db.query(
            `SELECT 1 FROM ${quoteIdent(table.name)} WHERE ${quoteIdent(table.primaryKey)}=?`,
            [operation.rowId],
          ).length
        )
          operation = {
            ...operation,
            values: JSON.parse(row.intent as string),
          };
      } else if (row.unique_conflicts === null && row.intent !== null) {
        // Hydrate legacy failure evidence from authoritative unique-key peers.
        const values: Record<string, JsonRowValue> = JSON.parse(
          row.intent as string,
        );
        const authorized = uniqueConflicts(
          db,
          table,
          mapRowValues(values, jsonToRowValue),
        ).filter(
          (conflict) =>
            conflict.serverVersion >= 0 &&
            !db.query(
              `SELECT 1 FROM ${RETAINED_ROWS} WHERE tbl=? AND id=? UNION ALL SELECT 1 FROM ${OUTBOX_TABLE},json_each(operations)WHERE json_extract(json_each.value,'$.table')=? AND json_extract(json_each.value,'$.rowId')=? LIMIT 1`,
              [table.name, conflict.rowId, table.name, conflict.rowId],
            ).length,
        );
        if (authorized.length)
          db.exec(
            `UPDATE ${RETAINED_ROWS} SET unique_conflicts=? WHERE commit_id=? AND idx=?`,
            [
              JSON.stringify(
                authorized.map((conflict) => ({
                  ...conflict,
                  serverRow: mapRowValues(conflict.serverRow, rowValueToJson),
                })),
              ),
              row.commit_id as string,
              row.idx as number,
            ],
          );
      }
    }
    const prior = commits.get(id);
    if (prior) prior.operations.push(operation);
    else
      commits.set(id, {
        seq: 0,
        clientCommitId: id,
        createdAtMs: row.at as number,
        operations: [operation],
      });
  }
  return [...commits.values()];
}

export function dropFailedRows(
  db: ClientDatabase,
  schema: CompiledClientSchema,
  matches: (
    table: string,
    values: Readonly<Record<string, JsonRowValue>>,
  ) => boolean,
): OutboxCommit[] {
  const ids = new Set<string>();
  for (const row of retainedRows(db)) {
    for (const json of [row.intent, row.base]) {
      if (json === null) continue;
      const values: Record<string, JsonRowValue> = JSON.parse(String(json));
      if (matches(row.tbl as string, values)) ids.add(row.commit_id as string);
    }
  }
  const dropped = [
    ...failedOverlayCommits(db),
    ...failedOverlayCommits(db, true),
  ].filter((commit) => ids.has(commit.clientCommitId));
  restoreFailedBases(
    db,
    schema,
    dropped.flatMap((commit) =>
      commit.operations.map((op) => JSON.stringify([op.table, op.rowId])),
    ),
  );
  for (const id of ids) {
    db.exec(`DELETE FROM ${RETAINED_ROWS} WHERE commit_id=?`, [id]);
    db.exec(
      `UPDATE ${OUTCOMES_TABLE} SET operations=NULL,results='[]' WHERE client_commit_id=?`,
      [id],
    );
  }
  return dropped;
}
