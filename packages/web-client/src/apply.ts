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
  type SegmentRow,
} from '@syncular/core';
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
 * §4.8 window eviction: delete rows matching a departing unit's effective
 * scopes (same local-scope-column rule and fail-closed clause as
 * {@link deleteScopedRows}) EXCEPT rows whose primary key is in
 * `pinnedRowIds` (E1 — pinned by a still-pending outbox commit). Returns
 * `true` iff any pinned row was left behind, so the caller knows to defer
 * the rest of the eviction until the outbox drains. Also removes the
 * evicted rows' `server_version` with them (E2 — no residual version
 * cache), which is automatic since the version column is per-row.
 */
export function evictScopedRows(
  db: ClientDatabase,
  table: CompiledClientTable,
  effective: ScopeMap,
  pinnedRowIds: ReadonlySet<string>,
): boolean {
  const entries = Object.entries(effective);
  if (entries.length === 0) return false;
  const clauses: string[] = [];
  const params: string[] = [];
  for (const [variable, values] of entries) {
    const column = table.scopeColumnByVariable.get(variable);
    if (column === undefined) {
      throw new ClientSyncError(
        'sync.scope_revoked',
        `table ${JSON.stringify(table.name)} has no local scope-column mapping for ${JSON.stringify(variable)} (§4.8/§3.3 fail-closed)`,
      );
    }
    if (values.length === 0) return false;
    clauses.push(
      `${quoteIdent(column)} IN (${values.map(() => '?').join(', ')})`,
    );
    params.push(...values);
  }
  const pk = quoteIdent(table.primaryKey);
  let pinnedClause = '';
  if (pinnedRowIds.size > 0) {
    const ids = [...pinnedRowIds];
    pinnedClause = ` AND ${pk} NOT IN (${ids.map(() => '?').join(', ')})`;
    params.push(...ids);
  }
  db.exec(
    `DELETE FROM ${quoteIdent(table.name)} WHERE ${clauses.join(' AND ')}${pinnedClause}`,
    params,
  );
  if (pinnedRowIds.size === 0) return false;
  // A pin still matters only if a pinned row actually falls inside this
  // unit's effective scopes; check by re-selecting the survivors.
  const survivors = db.query(
    `SELECT ${pk} AS pk FROM ${quoteIdent(table.name)} WHERE ${clauses.join(' AND ')}`,
    params.slice(0, params.length - pinnedRowIds.size),
  );
  for (const row of survivors) {
    if (pinnedRowIds.has(String(row.pk))) return true;
  }
  return false;
}

/** Descriptor fields a sqlite image is validated against (§5.3). */
export interface SqliteSegmentDescriptor {
  readonly table: string;
  readonly rowCount: number;
  readonly asOfCommitSeq: number;
  readonly scopeDigest: string;
}

const IMAGE_ALIAS = 'syncular_image';

function imageInvalid(detail: string): never {
  throw new ClientSyncError(
    'sync.invalid_request',
    `sqlite segment rejected: ${detail} (§5.3)`,
  );
}

/**
 * Apply a §5.3 sqlite-image segment in ONE local transaction: validate
 * the in-file metadata against the descriptor, validate the data table's
 * column names/order against the generated schema, run the §5.6
 * first-page clear when fresh, then copy every row with a single
 * `INSERT OR REPLACE … SELECT` — `_syncular_version` lands in
 * `_sync_version` exactly like a rows segment's per-row `serverVersion`.
 */
export function applySqliteSegment(
  db: ClientDatabase,
  schema: CompiledClientSchema,
  table: CompiledClientTable,
  bytes: Uint8Array,
  descriptor: SqliteSegmentDescriptor,
  options: { readonly clearFirst: boolean; readonly effective: ScopeMap },
): number {
  const withImage = db.withSqliteImage?.bind(db);
  if (withImage === undefined) {
    throw new ClientSyncError(
      'sync.invalid_request',
      'received a sqlite segment but the database backend cannot import images (§4.2: do not advertise accept bit 2)',
    );
  }
  if (descriptor.table !== table.name) {
    imageInvalid(`descriptor table ${JSON.stringify(descriptor.table)}`);
  }
  return withImage(bytes, IMAGE_ALIAS, () => {
    // 1. Metadata vs descriptor (§5.3 rule 2). A file that is not a
    //    SQLite database or lacks the metadata table fails right here.
    let meta: ReturnType<ClientDatabase['query']>;
    try {
      meta = db.query(
        `SELECT format, "table" AS tbl, "schemaVersion" AS sv,
                "asOfCommitSeq" AS pin, "scopeDigest" AS sd,
                "rowCount" AS rc
         FROM ${IMAGE_ALIAS}."_syncular_segment"`,
      );
    } catch {
      imageInvalid('bytes are not a SQLite image with _syncular_segment');
    }
    const record = meta[0];
    if (meta.length !== 1 || record === undefined) {
      imageInvalid('_syncular_segment must contain exactly one row');
    }
    if (record.format !== 1) imageInvalid(`format ${String(record.format)}`);
    if (record.tbl !== table.name) {
      imageInvalid(`image table ${String(record.tbl)}`);
    }
    if (Number(record.sv) !== schema.version) {
      imageInvalid(`schemaVersion ${String(record.sv)}`);
    }
    if (Number(record.pin) !== descriptor.asOfCommitSeq) {
      imageInvalid(`asOfCommitSeq ${String(record.pin)}`);
    }
    if (record.sd !== descriptor.scopeDigest) {
      imageInvalid('scopeDigest mismatch');
    }
    if (Number(record.rc) !== descriptor.rowCount) {
      imageInvalid(`rowCount ${String(record.rc)}`);
    }

    // 2. Column names and order vs the generated schema (§5.3 rule 3 —
    //    sync.schema_mismatch, the §5.2 rule specialized).
    const info = db.query(
      `PRAGMA ${IMAGE_ALIAS}.table_info(${quoteIdent(table.name)})`,
    );
    const expected = [
      ...table.columns.map((column) => column.name),
      '_syncular_version',
    ];
    const actual = info.map((row) => String(row.name));
    if (
      actual.length !== expected.length ||
      expected.some((name, index) => actual[index] !== name)
    ) {
      throw new ClientSyncError(
        'sync.schema_mismatch',
        `sqlite segment for ${JSON.stringify(table.name)} does not match the generated schema: columns [${actual.join(', ')}] (§5.3)`,
      );
    }

    // 3. One transaction: fresh-bootstrap clear, then replace-or-upsert.
    const names = table.columns.map((column) => quoteIdent(column.name));
    return db.transaction(() => {
      if (options.clearFirst) {
        deleteScopedRows(db, table, options.effective);
      }
      db.exec(
        `INSERT OR REPLACE INTO ${quoteIdent(table.name)}
           (${[...names, quoteIdent(SYNC_VERSION_COLUMN)].join(', ')})
         SELECT ${[...names, quoteIdent('_syncular_version')].join(', ')}
         FROM ${IMAGE_ALIAS}.${quoteIdent(table.name)}`,
      );
      const counted = db.query(
        `SELECT count(*) AS n FROM ${IMAGE_ALIAS}.${quoteIdent(table.name)}`,
      )[0];
      const applied = Number(counted?.n ?? 0);
      if (applied !== descriptor.rowCount) {
        imageInvalid(
          `image holds ${applied} rows, descriptor says ${descriptor.rowCount}`,
        );
      }
      return applied;
    });
  });
}

/**
 * Apply a decoded rows segment: each block in one local transaction
 * (§5.2/§1.4); `clearFirst` implements the §5.6 fresh-bootstrap first-page
 * delete inside the first block's transaction. Each row record carries its
 * `serverVersion` (§5.2), which lands in `_sync_version` exactly like a
 * `COMMIT` change's `rowVersion` (§5.6) — bootstrapped rows seed §6.2
 * `baseVersion` conflict detection immediately.
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
  const blocks: readonly (readonly SegmentRow[])[] =
    segment.blocks.length > 0 ? segment.blocks : [[]];
  for (const block of blocks) {
    db.transaction(() => {
      if (first && options.clearFirst) {
        deleteScopedRows(db, table, options.effective);
      }
      first = false;
      for (const row of block) {
        upsertLocalRow(db, table, row.values, row.serverVersion);
        applied += 1;
      }
    });
  }
  return applied;
}
