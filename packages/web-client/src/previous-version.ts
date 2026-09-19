/**
 * RFC 0005 previous-version context.
 *
 * A schema bump wipes the local replica (§7.4.3), so the rows the app could
 * see a moment ago are gone before the server can re-bootstrap them. This
 * module captures a bounded, typed, read-only copy of the pre-reset rows
 * inside the reset transaction so the app can answer "what did this look like
 * before the upgrade" while the replacement bootstrap is in flight.
 *
 * Three rules shape the implementation and are load-bearing:
 *
 * - The capture is typed by the OLD schema's {@link LocalSchemaDescriptor},
 *   persisted in `_syncular_meta` beside the schema-version marker. SQLite
 *   column affinity cannot recover a semantic type (`boolean` and `integer`
 *   are both `INTEGER`; `string`, `json` and `blob_ref` are all `TEXT`), so a
 *   descriptor-free capture would be undecodable. It is NEVER inferred.
 * - Every budget is measured before any row is materialized. An over-budget
 *   capture stores nothing.
 * - The container is advisory local data: it never contributes to query
 *   coverage, and it is destroyed by every lifetime trigger (coverage
 *   completion, lease end, scope revocation, TTL, purge, explicit discard).
 */
import type { RowColumn, RowValue } from '@syncular/core';
import type { ClientDatabase, SqlRow, SqlValue } from './database';
import { ClientSyncError } from './errors';
import { PREVIOUS_VERSION_CONTAINER, previousVersionContainerExists } from './query-guard';
import {
  type CompiledClientSchema,
  fromSqlValue,
  type JsonRowValue,
  jsonToRowValue,
  localColumnType,
  quoteIdent,
  rowValueToJson,
} from './schema';
import { getMeta, setMeta } from './state';

/** `_syncular_meta` key holding the persisted {@link LocalSchemaDescriptor}. */
export const LOCAL_SCHEMA_DESCRIPTOR_KEY = 'localSchemaDescriptor';

/** `_syncular_meta` key holding the capture record or its refusal. */
export const PREVIOUS_VERSION_CONTEXT_KEY = 'previousVersionContext';

/** `_syncular_meta` key holding the pre-reset compatibility audit (D6). */
export const PREVIOUS_VERSION_AUDIT_KEY = 'previousVersionAudit';

/** §7.4.3 step 7: the container must not collide with the running schema. */
export { PREVIOUS_VERSION_CONTAINER };

const DESCRIPTOR_VERSION = 1;
const CONTEXT_VERSION = 1;
const AUDIT_VERSION = 1;

/** Rows copied per `INSERT` batch (A4 step 5). */
const COPY_BATCH_ROWS = 500;

/** Incompatible commits recorded at most (D6); the rest flag `truncated`. */
const MAX_AUDIT_INCOMPATIBLE = 200;

/** Read spec `limit` ceiling (D7). */
export const PREVIOUS_VERSION_MAX_LIMIT = 200;

export type PreviousVersionReason =
  | 'not-configured'
  | 'no-previous-descriptor'
  | 'capture-exceeded-budget'
  | 'namespace-collision'
  | 'coverage-complete'
  | 'expired'
  | 'lease-inactive'
  | 'scope-revoked'
  | 'security-inactive'
  | 'purged';

export interface LocalSchemaDescriptorColumn {
  readonly name: string;
  readonly type: RowColumn['type'];
}

export interface LocalSchemaDescriptorTable {
  readonly name: string;
  readonly primaryKey: string;
  readonly columns: readonly LocalSchemaDescriptorColumn[];
}

export interface LocalSchemaDescriptor {
  readonly v: 1;
  readonly version: number;
  readonly tables: readonly LocalSchemaDescriptorTable[];
}

/** Successful capture record written under {@link PREVIOUS_VERSION_CONTEXT_KEY}. */
export interface PreviousVersionContextRecord {
  readonly v: 1;
  readonly previousVersion: number;
  readonly currentVersion: number;
  readonly tables: readonly LocalSchemaDescriptorTable[];
  readonly rows: number;
  readonly bytes: number;
  readonly createdAtMs: number;
}

/**
 * Capture refusal written under the same key. D1/D2 require the read surface
 * to name WHY nothing was captured, and the persisted context record is the
 * only durable place for it.
 */
export interface PreviousVersionRefusalRecord {
  readonly v: 1;
  readonly reason:
    | 'no-previous-descriptor'
    | 'capture-exceeded-budget'
    | 'namespace-collision';
  readonly tables?: number;
  readonly rows?: number;
  readonly bytes?: number;
}

export type PreviousVersionContextStored =
  | PreviousVersionContextRecord
  | PreviousVersionRefusalRecord;

export interface PreviousVersionCaptureConfig {
  readonly maxBytes: number;
  readonly maxRows: number;
  readonly maxTables: number;
  readonly maxRowBytes: number;
}

export interface PreviousVersionCaptureMeasurement {
  readonly tables: number;
  readonly rows: number;
  readonly bytes: number;
}

export type PreviousVersionCaptureOutcome =
  | {
      readonly ok: true;
      readonly measurement: PreviousVersionCaptureMeasurement;
    }
  | {
      readonly ok: false;
      readonly reason: 'capture-exceeded-budget' | 'namespace-collision';
      readonly measurement: PreviousVersionCaptureMeasurement;
    };

export interface PreviousVersionAuditEntry {
  readonly commitId: string;
  readonly table: string;
  readonly reason: 'unknown-table' | 'unknown-column';
  /** The offending column; present for every reason except `unknown-table`. */
  readonly column?: string;
}

export interface PreviousVersionAudit {
  readonly v: 1;
  readonly atMs: number;
  readonly fromVersion: number;
  readonly toVersion: number;
  readonly pending: number;
  readonly encodable: number;
  readonly truncated: boolean;
  readonly incompatible: readonly PreviousVersionAuditEntry[];
}

export interface PreviousVersionReadSpec {
  readonly table: string;
  readonly rowIds?: readonly string[];
  readonly limit?: number;
}

export interface PreviousVersionSnapshot {
  readonly state: 'previousVersion';
  readonly available: boolean;
  readonly previousVersion?: number;
  readonly currentVersion: number;
  readonly reason?: PreviousVersionReason;
  readonly rows: readonly SqlRow[];
  readonly truncated: boolean;
}

// ---------------------------------------------------------------------------
// Descriptor (D1)
// ---------------------------------------------------------------------------

/**
 * D1: the semantic local types of every table in the running generated schema,
 * built from {@link localColumnType} — never from SQLite affinity.
 */
export function buildLocalSchemaDescriptor(
  schema: CompiledClientSchema,
): LocalSchemaDescriptor {
  return {
    v: DESCRIPTOR_VERSION,
    version: schema.version,
    tables: [...schema.tables.values()].map((table) => ({
      name: table.name,
      primaryKey: table.primaryKey,
      columns: table.columns.map((column) => ({
        name: column.name,
        type: localColumnType(column),
      })),
    })),
  };
}

const COLUMN_TYPES = new Set<RowColumn['type']>([
  'string',
  'integer',
  'float',
  'boolean',
  'bytes',
  'json',
  'blob_ref',
  'crdt',
]);

function descriptorCorrupt(): never {
  throw new ClientSyncError(
    'sync.local_corrupt',
    'persisted local schema descriptor is invalid',
  );
}

function decodeDescriptorColumns(value: unknown): LocalSchemaDescriptorColumn[] {
  if (!Array.isArray(value)) return descriptorCorrupt();
  return value.map((entry) => {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      return descriptorCorrupt();
    }
    const column = entry as Record<string, unknown>;
    const keys = Object.keys(column).sort();
    if (
      keys.length !== 2 ||
      keys[0] !== 'name' ||
      keys[1] !== 'type' ||
      typeof column.name !== 'string' ||
      typeof column.type !== 'string' ||
      !COLUMN_TYPES.has(column.type as RowColumn['type'])
    ) {
      return descriptorCorrupt();
    }
    return { name: column.name, type: column.type as RowColumn['type'] };
  });
}

function decodeDescriptorTable(value: unknown): LocalSchemaDescriptorTable {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return descriptorCorrupt();
  }
  const table = value as Record<string, unknown>;
  const keys = Object.keys(table).sort();
  if (
    keys.length !== 3 ||
    keys[0] !== 'columns' ||
    keys[1] !== 'name' ||
    keys[2] !== 'primaryKey' ||
    typeof table.name !== 'string' ||
    typeof table.primaryKey !== 'string'
  ) {
    return descriptorCorrupt();
  }
  return {
    name: table.name,
    primaryKey: table.primaryKey,
    columns: decodeDescriptorColumns(table.columns),
  };
}

/** Strict decode: an unknown shape is corruption, never a best guess. */
export function decodeLocalSchemaDescriptor(
  value: string,
): LocalSchemaDescriptor {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return descriptorCorrupt();
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return descriptorCorrupt();
  }
  const record = parsed as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (
    keys.length !== 3 ||
    keys[0] !== 'tables' ||
    keys[1] !== 'v' ||
    keys[2] !== 'version' ||
    record.v !== DESCRIPTOR_VERSION ||
    !isCount(record.version) ||
    !Array.isArray(record.tables)
  ) {
    return descriptorCorrupt();
  }
  return {
    v: 1,
    version: record.version,
    tables: record.tables.map(decodeDescriptorTable),
  };
}

/**
 * D1: persist the descriptor. Callers MUST write this in the same transaction
 * as {@link LOCAL_SCHEMA_VERSION_KEY}; a descriptor without a matching marker
 * is treated as absent at reset time.
 */
export function setLocalSchemaDescriptor(
  db: ClientDatabase,
  schema: CompiledClientSchema,
): void {
  setMeta(
    db,
    LOCAL_SCHEMA_DESCRIPTOR_KEY,
    JSON.stringify(buildLocalSchemaDescriptor(schema)),
  );
}

/** Load and strictly decode the stored descriptor; `undefined` when absent or corrupt. */
export function loadLocalSchemaDescriptor(
  db: ClientDatabase,
): LocalSchemaDescriptor | undefined {
  const raw = getMeta(db, LOCAL_SCHEMA_DESCRIPTOR_KEY);
  if (raw === undefined) return undefined;
  try {
    return decodeLocalSchemaDescriptor(raw);
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Context record (D5 step 5 / refusal)
// ---------------------------------------------------------------------------

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

export function encodePreviousVersionContext(
  stored: PreviousVersionContextStored,
): string {
  return JSON.stringify(stored);
}

export function decodePreviousVersionContext(
  value: string,
): PreviousVersionContextStored {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return contextCorrupt();
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return contextCorrupt();
  }
  const record = parsed as Record<string, unknown>;
  if (record.v !== CONTEXT_VERSION) return contextCorrupt();
  if (typeof record.reason === 'string') {
    if (
      record.reason !== 'no-previous-descriptor' &&
      record.reason !== 'capture-exceeded-budget' &&
      record.reason !== 'namespace-collision'
    ) {
      return contextCorrupt();
    }
    return {
      v: 1,
      reason: record.reason,
      ...(isCount(record.tables) ? { tables: record.tables } : {}),
      ...(isCount(record.rows) ? { rows: record.rows } : {}),
      ...(isCount(record.bytes) ? { bytes: record.bytes } : {}),
    };
  }
  const keys = Object.keys(record).sort();
  if (
    keys.length !== 7 ||
    keys[0] !== 'bytes' ||
    keys[1] !== 'createdAtMs' ||
    keys[2] !== 'currentVersion' ||
    keys[3] !== 'previousVersion' ||
    keys[4] !== 'rows' ||
    keys[5] !== 'tables' ||
    keys[6] !== 'v' ||
    !isCount(record.bytes) ||
    !isCount(record.createdAtMs) ||
    !isCount(record.currentVersion) ||
    !isCount(record.previousVersion) ||
    !isCount(record.rows) ||
    !Array.isArray(record.tables)
  ) {
    return contextCorrupt();
  }
  return {
    v: 1,
    previousVersion: record.previousVersion,
    currentVersion: record.currentVersion,
    tables: record.tables.map(decodeDescriptorTable),
    rows: record.rows,
    bytes: record.bytes,
    createdAtMs: record.createdAtMs,
  };
}

function contextCorrupt(): never {
  throw new ClientSyncError(
    'sync.local_corrupt',
    'persisted previous-version context is invalid',
  );
}

function storedContext(
  db: ClientDatabase,
): PreviousVersionContextStored | undefined {
  const raw = getMeta(db, PREVIOUS_VERSION_CONTEXT_KEY);
  if (raw === undefined) return undefined;
  try {
    return decodePreviousVersionContext(raw);
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Container lifecycle (D3)
// ---------------------------------------------------------------------------

/** D5 step 1 / `#runLogEpochReset`: unconditional orphan sweep. */
export function dropPreviousVersionContainer(db: ClientDatabase): void {
  db.exec(`DROP TABLE IF EXISTS ${quoteIdent(PREVIOUS_VERSION_CONTAINER)}`);
}

/**
 * Drop the container and BOTH metadata records in one transaction. Every
 * discard trigger routes through here, including the explicit downgrade
 * procedure, so the post-discard database holds no trace (A2 step 3).
 */
export function discardPreviousVersion(db: ClientDatabase): void {
  db.transaction(() => {
    dropPreviousVersionContainer(db);
    db.exec('DELETE FROM _syncular_meta WHERE key = ?', [
      PREVIOUS_VERSION_CONTEXT_KEY,
    ]);
    db.exec('DELETE FROM _syncular_meta WHERE key = ?', [
      PREVIOUS_VERSION_AUDIT_KEY,
    ]);
  });
}

// ---------------------------------------------------------------------------
// Bounded capture (D2 / A4)
// ---------------------------------------------------------------------------

function budgetMeasurement(
  tables: number,
  rows: number,
  bytes: number,
): PreviousVersionCaptureMeasurement {
  return { tables, rows, bytes };
}

function sumBytesExpression(columns: readonly string[]): string {
  return columns
    .map((name) => `COALESCE(LENGTH(CAST(${quoteIdent(name)} AS BLOB)), 0)`)
    .join(' + ');
}

/**
 * D2/A4: measure the capture inside the reset transaction BEFORE materializing
 * anything. Ordered probes, aborting on the first violation:
 *
 * 1. table count from `sqlite_master`;
 * 2. per-table row count with a `LIMIT maxRows + 1` early-abort probe;
 * 3. a single-row probe for rows larger than `maxRowBytes`;
 * 4. a bounded `SUM` over a `LIMIT`ed subquery;
 * 5. the copy itself, in {@link COPY_BATCH_ROWS} batches.
 */
export function capturePreviousVersion(
  db: ClientDatabase,
  oldDescriptor: LocalSchemaDescriptor,
  newSchema: CompiledClientSchema,
  config: PreviousVersionCaptureConfig,
  nowMs: number,
): PreviousVersionCaptureOutcome {
  if (newSchema.tables.has(PREVIOUS_VERSION_CONTAINER)) {
    return {
      ok: false,
      reason: 'namespace-collision',
      measurement: budgetMeasurement(0, 0, 0),
    };
  }
  const discovered = new Set(
    db
      .query(
        `SELECT name FROM sqlite_master WHERE type = 'table'
           AND name NOT LIKE '_syncular_%'
           AND name NOT LIKE 'sqlite_%'
           AND name != ?`,
        [PREVIOUS_VERSION_CONTAINER],
      )
      .map((row) => String(row.name)),
  );
  // Only descriptor-known tables carry semantic types; those are the tables the
  // copy would hold, and the count the table budget bounds.
  const tables = oldDescriptor.tables.filter((table) =>
    discovered.has(table.name),
  );
  if (tables.length > config.maxTables) {
    return {
      ok: false,
      reason: 'capture-exceeded-budget',
      measurement: budgetMeasurement(tables.length, 0, 0),
    };
  }

  let measuredRows = 0;
  const perTableRows: number[] = [];
  for (const table of tables) {
    const probeRows = Number(
      db.query(
        `SELECT COUNT(*) AS count FROM (SELECT 1 FROM ${quoteIdent(table.name)} LIMIT ?)`,
        [config.maxRows + 1],
      )[0]?.count ?? 0,
    );
    measuredRows += probeRows;
    perTableRows.push(probeRows);
    if (measuredRows > config.maxRows) {
      return {
        ok: false,
        reason: 'capture-exceeded-budget',
        measurement: budgetMeasurement(tables.length, measuredRows, 0),
      };
    }
  }

  let measuredBytes = 0;
  for (let index = 0; index < tables.length; index++) {
    const table = tables[index] as LocalSchemaDescriptorTable;
    const columns = table.columns.map((column) => column.name);
    const byteSum = sumBytesExpression(columns);
    if (columns.length > 0) {
      const oversized = db.query(
        `SELECT 1 AS hit FROM ${quoteIdent(table.name)}
           WHERE (${byteSum}) > ? LIMIT 1`,
        [config.maxRowBytes],
      );
      if (oversized.length > 0) {
        return {
          ok: false,
          reason: 'capture-exceeded-budget',
          measurement: budgetMeasurement(tables.length, measuredRows, measuredBytes),
        };
      }
      const boundedRows = perTableRows[index] ?? 0;
      const total = db.query(
        `SELECT COALESCE(SUM(bytes), 0) AS total FROM (
           SELECT (${byteSum}) AS bytes FROM ${quoteIdent(table.name)} LIMIT ?
         )`,
        [boundedRows],
      )[0]?.total;
      measuredBytes += Number(total ?? 0);
      if (measuredBytes > config.maxBytes) {
        return {
          ok: false,
          reason: 'capture-exceeded-budget',
          measurement: budgetMeasurement(tables.length, measuredRows, measuredBytes),
        };
      }
    }
  }

  if (tables.length === 0) {
    writeContextRecord(db, {
      v: 1,
      previousVersion: oldDescriptor.version,
      currentVersion: newSchema.version,
      tables: [],
      rows: 0,
      bytes: 0,
      createdAtMs: nowMs,
    });
    return { ok: true, measurement: budgetMeasurement(0, 0, 0) };
  }

  db.exec(
    `CREATE TABLE ${quoteIdent(PREVIOUS_VERSION_CONTAINER)} (
       tbl TEXT NOT NULL,
       row_id TEXT NOT NULL,
       payload TEXT NOT NULL,
       PRIMARY KEY (tbl, row_id))`,
  );
  let copiedRows = 0;
  for (const table of tables) {
    const columns = table.columns;
    const selectColumns = columns
      .map((column) => quoteIdent(column.name))
      .join(', ');
    let lastRowId = -1;
    for (;;) {
      const rows = db.query(
        `SELECT rowid AS _rid, ${selectColumns} FROM ${quoteIdent(table.name)}
           WHERE rowid > ? ORDER BY rowid ASC LIMIT ?`,
        [lastRowId, COPY_BATCH_ROWS],
      );
      if (rows.length === 0) break;
      for (const row of rows) {
        const payload: Record<string, JsonRowValue> = {};
        for (const column of columns) {
          const value: RowValue = fromSqlValue(
            { name: column.name, type: column.type, nullable: true },
            (row[column.name] ?? null) as SqlValue,
          );
          payload[column.name] = rowValueToJson(value);
        }
        db.exec(
          `INSERT INTO ${quoteIdent(PREVIOUS_VERSION_CONTAINER)}(tbl, row_id, payload)
             VALUES (?, ?, ?)`,
          [table.name, rowIdText(table, row), JSON.stringify(payload)],
        );
      }
      lastRowId = Number(rows[rows.length - 1]?._rid ?? lastRowId);
      copiedRows += rows.length;
    }
  }

  writeContextRecord(db, {
    v: 1,
    previousVersion: oldDescriptor.version,
    currentVersion: newSchema.version,
    tables: tables.map((table) => ({
      name: table.name,
      primaryKey: table.primaryKey,
      columns: table.columns,
    })),
    rows: copiedRows,
    bytes: measuredBytes,
    createdAtMs: nowMs,
  });
  return { ok: true, measurement: budgetMeasurement(tables.length, copiedRows, measuredBytes) };
}

function rowIdText(
  table: LocalSchemaDescriptorTable,
  row: SqlRow,
): string {
  const value = row[table.primaryKey] ?? null;
  if (value === null) return '';
  if (value instanceof Uint8Array) {
    return [...value].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  }
  return String(value);
}

/** Persist a refusal so the read surface can name the missing capture. */
export function writePreviousVersionRefusal(
  db: ClientDatabase,
  reason: PreviousVersionRefusalRecord['reason'],
  measurement: PreviousVersionCaptureMeasurement,
): void {
  writeContextRecord(db, {
    v: 1,
    reason,
    tables: measurement.tables,
    rows: measurement.rows,
    bytes: measurement.bytes,
  });
}

function writeContextRecord(
  db: ClientDatabase,
  stored: PreviousVersionContextStored,
): void {
  setMeta(db, PREVIOUS_VERSION_CONTEXT_KEY, encodePreviousVersionContext(stored));
}

// ---------------------------------------------------------------------------
// Compatibility audit (D6)
// ---------------------------------------------------------------------------

interface PendingCommitLike {
  readonly clientCommitId: string;
  readonly operations: readonly {
    readonly table: string;
    readonly values?: Readonly<Record<string, JsonRowValue>>;
  }[];
}

/**
 * D6: classify pending outbox commits against the NEW compiled schema, before
 * the wipe. It records the commit id, table, typed reason and offending column
 * ONLY — never an operation, row value or envelope field. The envelope stays in
 * the outbox (and, on a terminal drop, in the §7.2.1 journal).
 */
export function buildPreviousVersionAudit(
  schema: CompiledClientSchema,
  pending: readonly PendingCommitLike[],
  fromVersion: number,
  toVersion: number,
  atMs: number,
): PreviousVersionAudit {
  const incompatible: PreviousVersionAuditEntry[] = [];
  let incompatibleTotal = 0;
  let encodable = 0;
  for (const commit of pending) {
    const entry = firstIncompatibility(schema, commit);
    if (entry === undefined) {
      encodable += 1;
      continue;
    }
    incompatibleTotal += 1;
    if (incompatible.length < MAX_AUDIT_INCOMPATIBLE) incompatible.push(entry);
  }
  return {
    v: AUDIT_VERSION,
    atMs,
    fromVersion,
    toVersion,
    pending: pending.length,
    encodable,
    truncated: incompatibleTotal > MAX_AUDIT_INCOMPATIBLE,
    incompatible,
  };
}

function firstIncompatibility(
  schema: CompiledClientSchema,
  commit: PendingCommitLike,
): PreviousVersionAuditEntry | undefined {
  for (const operation of commit.operations) {
    const table = schema.tables.get(operation.table);
    if (table === undefined) {
      return {
        commitId: commit.clientCommitId,
        table: operation.table,
        reason: 'unknown-table',
      };
    }
    if (operation.values === undefined) continue;
    for (const key of Object.keys(operation.values)) {
      if (!table.columnIndex.has(key)) {
        return {
          commitId: commit.clientCommitId,
          table: operation.table,
          reason: 'unknown-column',
          column: key,
        };
      }
    }
  }
  return undefined;
}

export function encodePreviousVersionAudit(audit: PreviousVersionAudit): string {
  return JSON.stringify(audit);
}

export function decodePreviousVersionAudit(
  value: string,
): PreviousVersionAudit | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return undefined;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return undefined;
  }
  const record = parsed as Record<string, unknown>;
  if (
    record.v !== AUDIT_VERSION ||
    !isCount(record.atMs) ||
    !isCount(record.fromVersion) ||
    !isCount(record.toVersion) ||
    !isCount(record.pending) ||
    !isCount(record.encodable) ||
    typeof record.truncated !== 'boolean' ||
    !Array.isArray(record.incompatible)
  ) {
    return undefined;
  }
  const incompatible: PreviousVersionAuditEntry[] = [];
  for (const entry of record.incompatible) {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      return undefined;
    }
    const item = entry as Record<string, unknown>;
    if (
      typeof item.commitId !== 'string' ||
      typeof item.table !== 'string' ||
      (item.reason !== 'unknown-table' && item.reason !== 'unknown-column') ||
      (item.column !== undefined && typeof item.column !== 'string')
    ) {
      return undefined;
    }
    incompatible.push({
      commitId: item.commitId,
      table: item.table,
      reason: item.reason,
      ...(typeof item.column === 'string' ? { column: item.column } : {}),
    });
  }
  return {
    v: 1,
    atMs: record.atMs,
    fromVersion: record.fromVersion,
    toVersion: record.toVersion,
    pending: record.pending,
    encodable: record.encodable,
    truncated: record.truncated,
    incompatible,
  };
}

/** Decode the stored audit; `undefined` when absent or corrupt. */
export function storedPreviousVersionAudit(
  db: ClientDatabase,
): PreviousVersionAudit | undefined {
  const raw = getMeta(db, PREVIOUS_VERSION_AUDIT_KEY);
  if (raw === undefined) return undefined;
  return decodePreviousVersionAudit(raw);
}

export function writePreviousVersionAudit(
  db: ClientDatabase,
  audit: PreviousVersionAudit,
): void {
  setMeta(db, PREVIOUS_VERSION_AUDIT_KEY, encodePreviousVersionAudit(audit));
}

// ---------------------------------------------------------------------------
// Read surface (D7)
// ---------------------------------------------------------------------------

export function decodePreviousVersionPayload(
  table: LocalSchemaDescriptorTable,
  payload: string,
): SqlRow {
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    return contextCorrupt();
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return contextCorrupt();
  }
  const record = parsed as Record<string, JsonRowValue>;
  const row: SqlRow = {};
  for (const column of table.columns) {
    row[column.name] = jsonToRowValue(record[column.name] ?? null) as SqlValue;
  }
  return row;
}

export function previousVersionStatus(
  db: ClientDatabase,
): { present: boolean; createdAtMs?: number } {
  const stored = storedContext(db);
  if (stored !== undefined && 'currentVersion' in stored) {
    return { present: true, createdAtMs: stored.createdAtMs };
  }
  return { present: previousVersionContainerExists(db) };
}

export function storedPreviousVersionContext(
  db: ClientDatabase,
): PreviousVersionContextStored | undefined {
  return storedContext(db);
}