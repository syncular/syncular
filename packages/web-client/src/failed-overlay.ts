import { hasUniqueIndex } from './schema';
import { OUTCOMES_TABLE } from './outcomes';
import { OUTBOX_IMAGES, OUTBOX_TABLE } from './outbox';
export const RETAINED_ROWS = '_syncular_failed_rows';
import { localStateCorrupt } from './errors';
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
  pkSqlValue,
  quoteIdent,
  rowValueToJson,
  SYNC_VERSION_COLUMN,
  toSqlValue,
} from './schema';
import type { RowValue } from '@syncular/core';
import type { SealedRow } from './encryption';
import type { RetainedCommitRow } from './outcomes';
import {
  listOutboxBeforeImages,
  type OutboxCommit,
  type OutboxOperation,
} from './outbox';
import { deleteLocalRow, upsertLocalRow } from './apply';

/** Protected failure state. The server base advances independently of intent. */
const SET_UNIQUE_CONFLICTS = `UPDATE ${RETAINED_ROWS} SET unique_conflicts=? WHERE rowid=?`;

export function ensureFailedOverlaySchema(db: ClientDatabase): void {
  db.exec(
    `CREATE TABLE IF NOT EXISTS ${RETAINED_ROWS}(commit_id TEXT NOT NULL,idx INTEGER NOT NULL,tbl TEXT NOT NULL,id TEXT NOT NULL,at INTEGER NOT NULL,op TEXT NOT NULL,intent TEXT,base TEXT,version INTEGER,unique_conflicts TEXT,commit_seq INTEGER,sealed TEXT,PRIMARY KEY(commit_id,idx))`,
  );
  const columns = db.query(`PRAGMA table_info(${RETAINED_ROWS})`);
  for (const column of [
    'unique_conflicts TEXT',
    'commit_seq INTEGER',
    'sealed TEXT',
  ])
    if (!columns.some((row) => row.name === column.split(' ')[0]))
      db.exec(`ALTER TABLE ${RETAINED_ROWS} ADD COLUMN ${column}`);
  db.exec(
    `CREATE INDEX IF NOT EXISTS ${RETAINED_ROWS}_row ON ${RETAINED_ROWS}(tbl,id)`,
  );
}

/**
 * Server writes, after they are stored: each `written` row replaces the base
 * and the §5.11 sealed state of its key's retained rows (`undefined`:
 * deleted), and the table's retained
 * intents re-read their unique conflicts with the written keys. A written row
 * without a retained row costs no statement.
 */
export function retainedBaseWrite(
  db: ClientDatabase,
  table: CompiledClientTable,
  written: ReadonlyMap<
    string,
    readonly [readonly RowValue[], number, (SealedRow | undefined)?] | undefined
  >,
): void {
  if (!written.size) return;
  for (const retained of db.query(
    `SELECT rowid AS r,* FROM ${RETAINED_ROWS} WHERE tbl=?`,
    [table.name],
  )) {
    const base = written.get(retained.id as string);
    if (written.has(retained.id as string))
      db.exec(
        `UPDATE ${RETAINED_ROWS} SET base=?,version=?,sealed=? WHERE rowid=?`,
        [
          base
            ? JSON.stringify(
                Object.fromEntries(
                  table.columns.map((column, index) => [
                    column.name,
                    rowValueToJson(base[0][index] ?? null),
                  ]),
                ),
              )
            : null,
          base?.[1] ?? null,
          base?.[2] ? JSON.stringify(base[2]) : null,
          retained.r as number,
        ],
      );
    if (!hasUniqueIndex(table) || retained.commit_seq !== null) continue;
    const prior: readonly (Omit<
      NonNullable<RetainedCommitRow['uniqueConflicts']>[number],
      'serverRow'
    > & { serverRow: Readonly<Record<string, JsonRowValue>> })[] =
      retained.unique_conflicts === null
        ? []
        : JSON.parse(retained.unique_conflicts as string);
    const conflicts = prior.filter((conflict) => !written.has(conflict.rowId));
    if (retained.intent !== null) {
      const intent: Record<string, JsonRowValue> = JSON.parse(
        retained.intent as string,
      );
      conflicts.push(
        ...uniqueConflicts(db, table, mapRowValues(intent, jsonToRowValue))
          .filter((conflict) => written.has(conflict.rowId))
          .map((conflict) => ({
            ...conflict,
            serverRow: mapRowValues(conflict.serverRow, rowValueToJson),
          })),
      );
    }
    db.exec(SET_UNIQUE_CONFLICTS, [
      conflicts.length
        ? JSON.stringify(
            conflicts.sort(
              (a, b) =>
                table.indexes.findIndex((index) => index.name === a.index) -
                table.indexes.findIndex((index) => index.name === b.index),
            ),
          )
        : null,
      retained.r as number,
    ]);
  }
}

export function retainFailedRows(
  db: ClientDatabase,
  commit: OutboxCommit,
  commitSeq?: number,
): boolean {
  const images = listOutboxBeforeImages(db, commit.clientCommitId);
  let delivered = false;
  for (const [index, operation] of commit.operations.entries()) {
    const image = images.get(index);
    if (commitSeq !== undefined && (image?.deliverySeq ?? -1) >= commitSeq) {
      delivered = true;
      continue;
    }
    const initial =
      operation.op === 'upsert'
        ? { ...image?.values, ...operation.values }
        : undefined;
    if (!image) throw localStateCorrupt('missing intent before-image');
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
  return delivered;
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

function retainedRows(
  db: ClientDatabase,
  scope?: OverlayScope,
  acknowledged?: boolean,
  pending = false,
) {
  // A scope joins through the (tbl, id) index; a scan per applied commit
  // would make a drained batch quadratic. `pending` appends the before-images
  // of pending rows in the scope's tables, in outbox order, with `r` NULL;
  // the columns line up with the table's fixed order, pinned by
  // unique-pull.test.ts "retained-row columns keep the order".
  return db.query(
    `SELECT rowid AS r,* FROM ${RETAINED_ROWS} WHERE (?1 IS NULL OR rowid IN(SELECT r.rowid FROM json_each(?1) k JOIN ${RETAINED_ROWS} r ON r.tbl=k.value->>0 AND r.id=k.value->>1 UNION SELECT r.rowid FROM json_each(?1) k JOIN ${RETAINED_ROWS} r ON json_array_length(k.value)=1 AND r.tbl=k.value->>0))${acknowledged === undefined ? '' : ` AND commit_seq IS${acknowledged ? ' NOT' : ''} NULL`}${pending ? ` UNION ALL SELECT NULL,NULL,op_index,tbl,row_id,seq,NULL,NULL,values_json,sync_version,NULL,9e18,NULL FROM ${OUTBOX_IMAGES} JOIN ${OUTBOX_TABLE} USING(client_commit_id)WHERE tbl IN(SELECT value->>0 FROM json_each(?1) WHERE json_array_length(value)=1)` : ''} ORDER BY commit_seq,at,commit_id,idx`,
    [scope ? JSON.stringify(scope) : null],
  );
}

export function restoreFailedBases(
  db: ClientDatabase,
  schema: CompiledClientSchema,
  scope?: OverlayScope,
): void {
  // §7.2: an accepted row can take the unique key of a pending row, so every
  // pending row of a table in scope leaves the visible table first and returns
  // at its earliest before-image after the retained bases; the replay then
  // re-admits it or keeps it invisible while its key is taken.
  const rows = retainedRows(db, scope, undefined, true);
  for (const row of rows) {
    const table = schema.tables.get(row.tbl as string);
    if (table && row.r === null)
      deleteLocalRow(db, table, row.id as string, false);
  }
  const seen = new Set<string>();
  for (const row of rows) {
    const key = JSON.stringify([row.tbl, row.id]);
    if (seen.has(key)) continue;
    seen.add(key);
    // §7.4.4: a retained row whose table the current schema removed has no
    // mirror to project; its persisted intent and outcome stay available, only
    // this projection is skipped.
    const table = schema.tables.get(row.tbl as string);
    if (table === undefined) continue;
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
        row.sealed ? JSON.parse(String(row.sealed)) : undefined,
      );
    }
  }
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
      // §7.4.4: the table this retained row belongs to is gone; the persisted
      // outcome and intent stay available, only the removed-table projection is
      // skipped.
      const table = schema.tables.get(operation.table);
      if (table === undefined) continue;
      if (acknowledged) {
        if (
          !db.query(
            `SELECT 1 FROM ${quoteIdent(table.name)} WHERE ${quoteIdent(table.primaryKey)}=?`,
            [pkSqlValue(table, operation.rowId)],
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
              `SELECT 1 FROM ${RETAINED_ROWS} WHERE tbl=? AND id=? UNION ALL SELECT 1 FROM ${OUTBOX_IMAGES} WHERE tbl=? AND row_id=? LIMIT 1`,
              [table.name, conflict.rowId, table.name, conflict.rowId],
            ).length,
        );
        if (authorized.length)
          db.exec(SET_UNIQUE_CONFLICTS, [
            JSON.stringify(
              authorized.map((conflict) => ({
                ...conflict,
                serverRow: mapRowValues(conflict.serverRow, rowValueToJson),
              })),
            ),
            row.r as number,
          ]);
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
