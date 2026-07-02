/**
 * Local application of server data: `COMMIT` frames (§4.5), rows segments
 * (§5.2, §5.6), and the scope-matched delete shared by the §3.3 purge
 * contract and the §5.6 first-page rule.
 */
import {
  type CommitFrame,
  decodeRow,
  type RowsSegment,
  type RowValue,
  type ScopeMap,
} from '@syncular-v2/core';
import type { ClientDatabase } from './database';
import { ClientSyncError } from './errors';
import {
  type CompiledClientSchema,
  type CompiledClientTable,
  quoteIdent,
  SYNC_VERSION_COLUMN,
  toSqlValue,
} from './schema';

function upsertSql(table: CompiledClientTable): string {
  const names = [
    ...table.columns.map((column) => quoteIdent(column.name)),
    quoteIdent(SYNC_VERSION_COLUMN),
  ];
  const placeholders = names.map(() => '?').join(', ');
  return `INSERT OR REPLACE INTO ${quoteIdent(table.name)} (${names.join(', ')}) VALUES (${placeholders})`;
}

export function upsertLocalRow(
  db: ClientDatabase,
  table: CompiledClientTable,
  values: readonly RowValue[],
  syncVersion: number,
): void {
  db.exec(upsertSql(table), [...values.map(toSqlValue), syncVersion]);
}

export function deleteLocalRow(
  db: ClientDatabase,
  table: CompiledClientTable,
  rowId: string,
): void {
  db.exec(
    `DELETE FROM ${quoteIdent(table.name)} WHERE ${quoteIdent(table.primaryKey)} = ?`,
    [rowId],
  );
}

/**
 * Apply one `COMMIT` frame in one local transaction (§1.4 rule 4).
 * Upserts land with `_sync_version = rowVersion`; deletes remove the row.
 * Re-application is idempotent (§1.4 rule 5).
 */
export function applyCommitFrame(
  db: ClientDatabase,
  schema: CompiledClientSchema,
  frame: CommitFrame,
): void {
  db.transaction(() => {
    for (const change of frame.changes) {
      const tableName = frame.tables[change.tableIndex];
      if (tableName === undefined) {
        throw new ClientSyncError(
          'sync.invalid_request',
          `COMMIT change tableIndex ${change.tableIndex} out of range`,
        );
      }
      const table = schema.tables.get(tableName);
      if (table === undefined) {
        throw new ClientSyncError(
          'sync.schema_mismatch',
          `COMMIT delivers unknown local table ${JSON.stringify(tableName)}`,
        );
      }
      if (change.op === 'delete') {
        deleteLocalRow(db, table, change.rowId);
        continue;
      }
      if (change.row === undefined || change.rowVersion === undefined) {
        throw new ClientSyncError(
          'sync.invalid_request',
          'upsert change without row payload',
        );
      }
      const values = decodeRow(table.columns, change.row);
      upsertLocalRow(db, table, values, change.rowVersion);
    }
  });
}

/**
 * §5.2: the segment's column table must match the generated schema for
 * (table, schemaVersion) — order, names, types, nullability. A mismatch is
 * fatal (`sync.schema_mismatch`): the descriptor validates, never infers.
 */
export function validateSegmentColumns(
  schema: CompiledClientSchema,
  table: CompiledClientTable,
  segment: RowsSegment,
): void {
  const mismatch = (detail: string): never => {
    throw new ClientSyncError(
      'sync.schema_mismatch',
      `rows segment for ${JSON.stringify(segment.table)} does not match the generated schema: ${detail}`,
    );
  };
  if (segment.table !== table.name) {
    mismatch(`segment table ${JSON.stringify(segment.table)}`);
  }
  if (segment.schemaVersion !== schema.version) {
    mismatch(`segment schemaVersion ${segment.schemaVersion}`);
  }
  if (segment.columns.length !== table.columns.length) {
    mismatch(`column count ${segment.columns.length}`);
  }
  for (let i = 0; i < table.columns.length; i++) {
    const expected = table.columns[i];
    const actual = segment.columns[i];
    if (expected === undefined || actual === undefined) continue;
    if (
      expected.name !== actual.name ||
      expected.type !== actual.type ||
      expected.nullable !== actual.nullable
    ) {
      mismatch(`column ${i} (${actual.name})`);
    }
  }
}

/**
 * Scope-matched local delete (§3.3 purge / §5.6 first-page rule): delete
 * rows whose generated local scope columns match `effective` — every key's
 * column value must be in the key's value list. Fails closed
 * (`sync.scope_revoked`) when the table has no local mapping for a key:
 * precision or nothing, never clear-the-table.
 */
export function deleteScopedRows(
  db: ClientDatabase,
  table: CompiledClientTable,
  effective: ScopeMap,
): void {
  const entries = Object.entries(effective);
  if (entries.length === 0) return;
  const clauses: string[] = [];
  const params: string[] = [];
  for (const [variable, values] of entries) {
    const column = table.scopeColumnByVariable.get(variable);
    if (column === undefined) {
      throw new ClientSyncError(
        'sync.scope_revoked',
        `table ${JSON.stringify(table.name)} has no local scope-column mapping for ${JSON.stringify(variable)} (§3.3 fail-closed)`,
      );
    }
    if (values.length === 0) return;
    clauses.push(
      `${quoteIdent(column)} IN (${values.map(() => '?').join(', ')})`,
    );
    params.push(...values);
  }
  db.exec(
    `DELETE FROM ${quoteIdent(table.name)} WHERE ${clauses.join(' AND ')}`,
    params,
  );
}

/**
 * Apply a decoded rows segment: each block in one local transaction
 * (§5.2/§1.4); `clearFirst` implements the §5.6 fresh-bootstrap first-page
 * delete inside the first block's transaction. Segment rows carry no
 * server versions (SSG2 has none), so `_sync_version` lands as 0 until an
 * incremental commit refreshes it.
 */
export function applyRowsSegment(
  db: ClientDatabase,
  schema: CompiledClientSchema,
  table: CompiledClientTable,
  segment: RowsSegment,
  options: { readonly clearFirst: boolean; readonly effective: ScopeMap },
): number {
  validateSegmentColumns(schema, table, segment);
  let applied = 0;
  let first = true;
  const blocks: readonly (readonly (readonly RowValue[])[])[] =
    segment.blocks.length > 0 ? segment.blocks : [[]];
  for (const block of blocks) {
    db.transaction(() => {
      if (first && options.clearFirst) {
        deleteScopedRows(db, table, options.effective);
      }
      first = false;
      for (const row of block) {
        upsertLocalRow(db, table, row, 0);
        applied += 1;
      }
    });
  }
  return applied;
}
