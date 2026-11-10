/**
 * RFC 0005 previous-version context.
 *
 * A schema bump wipes the local replica (§7.4.3), so the rows the app could
 * see a moment ago are gone before the server can re-bootstrap them. This
 * module captures a bounded, typed, read-only copy of the pre-reset rows so
 * the app can answer "what did this look like before the upgrade" while the
 * replacement bootstrap is in flight.
 *
 * Storage (controller storage move, 2026-09-19): the captured rows live in a
 * SECOND database file in the replica's own pool directory, opened through
 * `ClientDatabase.openSibling`, never in the replica database. The guarantee
 * this buys is stated narrowly: an older client's ordinary query connection
 * does not attach this file, so no SQL it runs can reach the container. It is
 * NOT protection against arbitrary same-origin access and NOT protection
 * against native filesystem access. The filename is a code constant derived at
 * runtime and is not persisted in the replica database. That is data
 * minimisation hygiene, NOT a control: same-origin storage access and native
 * filesystem access can enumerate names regardless, so nothing is claimed on
 * its strength.
 *
 * Two further rules shape the implementation:
 *
 * - The capture is typed by the OLD schema's {@link LocalSchemaDescriptor},
 *   persisted in `_syncular_meta` beside the schema-version marker. SQLite
 *   column affinity cannot recover a semantic type (`boolean` and `integer`
 *   are both `INTEGER`; `string`, `json` and `blob_ref` are all `TEXT`), so a
 *   descriptor-free capture would be undecodable. It is NEVER inferred.
 * - Every budget is measured before any row is materialized. An over-budget
 *   capture stores nothing.
 */
import type { RowColumn, RowValue } from '@syncular/core';
import type { ClientDatabase, SqlRow, SqlValue } from './database';
import { ClientSyncError } from './errors';
import { INVALID_HOST_RESPONSE_CODE } from './local-rebootstrap';
import {
  type CompiledClientSchema,
  fromSqlValue,
  type JsonRowValue,
  jsonToRowValue,
  localColumnType,
  quoteIdent,
  rowValueToJson,
} from './schema';
import { getMeta, setMeta, META_TABLE } from './state';

/** `_syncular_meta` key holding the persisted {@link LocalSchemaDescriptor}. */
const LOCAL_SCHEMA_DESCRIPTOR_KEY = 'localSchemaDescriptor';

/**
 * `_syncular_meta` key holding only a capture REFUSAL. The successful record
 * lives inside the container file, so this key is absent whenever a container
 * is present. It stays in the replica because it is small, typed, and useful
 * even when nothing was captured.
 */
const PREVIOUS_VERSION_CONTEXT_KEY = 'previousVersionContext';

/** `_syncular_meta` key holding the pre-reset compatibility audit (D6). */
const PREVIOUS_VERSION_AUDIT_KEY = 'previousVersionAudit';

/**
 * RFC 0005: the code-derived sibling database filename. Kept out of the replica
 * as data minimisation, not as a security control.
 */
export const PREVIOUS_VERSION_CONTAINER_NAME = 'prev-context';

/** The one non-reserved row table INSIDE the container file (D3). */
const CONTAINER_TABLE = 'syncular_prev_context';

/** Container-local metadata table holding {@link PreviousVersionRecord}. */
const CONTAINER_META_TABLE = '_syncular_prev_context_meta';

const DESCRIPTOR_VERSION = 1;
const AUDIT_VERSION = 1;

/** Rows copied per `INSERT` batch (A4 step 5). */
const COPY_BATCH_ROWS = 500;

/** Incompatible commits recorded at most (D6); the rest flag `truncated`. */
const MAX_AUDIT_INCOMPATIBLE = 200;

/** Read spec `limit` ceiling (D7). */
export const PREVIOUS_VERSION_MAX_LIMIT = 200;

/**
 * Every reason the read surface can name. `security-inactive` is absent because
 * `#requireActive()` throws before a read; `purged` and post-TTL are absent
 * because a discard removes the records, so no durable state can name them;
 * `namespace-collision` is absent because the container is a separate file and
 * cannot collide with a replica table.
 */
export type PreviousVersionReason =
  | 'not-configured'
  | 'no-previous-descriptor'
  | 'capture-exceeded-budget'
  | 'coverage-complete'
  | 'expired'
  | 'lease-inactive'
  | 'scope-revoked';

/** Refusals that ARE durable, because no container is written for them. */
type PreviousVersionRefusalReason =
  | 'no-previous-descriptor'
  | 'capture-exceeded-budget';

interface LocalSchemaDescriptorColumn {
  readonly name: string;
  readonly type: RowColumn['type'];
}

interface LocalSchemaDescriptorTable {
  readonly name: string;
  readonly primaryKey: string;
  readonly columns: readonly LocalSchemaDescriptorColumn[];
}

interface LocalSchemaDescriptor {
  readonly v: 1;
  readonly version: number;
  readonly tables: readonly LocalSchemaDescriptorTable[];
}

/** Successful capture record, stored INSIDE the container file. */
export interface PreviousVersionRecord {
  readonly v: 1;
  readonly previousVersion: number;
  readonly currentVersion: number;
  readonly tables: readonly LocalSchemaDescriptorTable[];
  readonly rows: number;
  readonly bytes: number;
  readonly createdAtMs: number;
}

/** Durable refusal stored in `_syncular_meta` when no container is written. */
interface PreviousVersionRefusal {
  readonly v: 1;
  readonly reason: PreviousVersionRefusalReason;
  readonly tables?: number;
  readonly rows?: number;
  readonly bytes?: number;
}

export interface PreviousVersionCaptureConfig {
  readonly maxBytes: number;
  readonly maxRows: number;
  readonly maxTables: number;
  readonly maxRowBytes: number;
}

interface PreviousVersionCaptureMeasurement {
  readonly tables: number;
  readonly rows: number;
  readonly bytes: number;
}

type PreviousVersionCaptureOutcome =
  | {
      readonly ok: true;
      readonly measurement: PreviousVersionCaptureMeasurement;
    }
  | {
      readonly ok: false;
      readonly reason: 'capture-exceeded-budget';
      readonly measurement: PreviousVersionCaptureMeasurement;
    };

interface PreviousVersionAuditEntry {
  readonly commitId: string;
  readonly table: string;
  readonly reason:
    | 'unknown-table'
    | 'unknown-column'
    | 'missing-required-column';
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function invalidHostResponse(method: string): never {
  throw new ClientSyncError(
    INVALID_HOST_RESPONSE_CODE,
    `${method} returned an invalid host response`,
  );
}

function isSqlValue(value: unknown): value is SqlValue {
  return (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean' ||
    typeof value === 'bigint' ||
    (typeof value === 'number' && Number.isFinite(value)) ||
    value instanceof Uint8Array
  );
}

function isSqlRow(value: unknown): value is SqlRow {
  return isRecord(value) && Object.values(value).every(isSqlValue);
}

const PREVIOUS_VERSION_REASONS: readonly PreviousVersionReason[] = [
  'not-configured',
  'no-previous-descriptor',
  'capture-exceeded-budget',
  'coverage-complete',
  'expired',
  'lease-inactive',
  'scope-revoked',
];

const SNAPSHOT_REQUIRED_KEYS = [
  'available',
  'currentVersion',
  'rows',
  'state',
  'truncated',
] as const;
const SNAPSHOT_OPTIONAL_KEYS = ['previousVersion', 'reason'] as const;
const DISCARD_KEYS = ['discarded', 'present'] as const;
const AUDIT_KEYS = [
  'atMs',
  'encodable',
  'fromVersion',
  'incompatible',
  'pending',
  'toVersion',
  'truncated',
  'v',
] as const;
const AUDIT_ENTRY_KEYS = ['column', 'commitId', 'reason', 'table'] as const;

/** Parse a persisted JSON object; anything else is `undefined`, never a guess. */
function parseJsonObject(raw: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(raw);
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function hasExactKeys(
  record: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  return (
    Object.keys(record).length === expected.length &&
    expected.every((key) => Object.hasOwn(record, key))
  );
}

function localCorrupt(what: string): never {
  throw new ClientSyncError(
    'sync.local_corrupt',
    `persisted ${what} is invalid`,
  );
}

// ---------------------------------------------------------------------------
// Descriptor (D1)
// ---------------------------------------------------------------------------

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

function decodeColumns(value: unknown): LocalSchemaDescriptorColumn[] {
  if (!Array.isArray(value)) return localCorrupt('schema descriptor');
  return value.map((entry) => {
    if (!isRecord(entry)) {
      return localCorrupt('schema descriptor');
    }
    if (
      !hasExactKeys(entry, ['name', 'type']) ||
      typeof entry.name !== 'string' ||
      typeof entry.type !== 'string' ||
      !COLUMN_TYPES.has(entry.type as RowColumn['type'])
    ) {
      return localCorrupt('schema descriptor');
    }
    return { name: entry.name, type: entry.type as RowColumn['type'] };
  });
}

function decodeTable(value: unknown): LocalSchemaDescriptorTable {
  if (!isRecord(value)) {
    return localCorrupt('schema descriptor');
  }
  if (
    !hasExactKeys(value, ['columns', 'name', 'primaryKey']) ||
    typeof value.name !== 'string' ||
    typeof value.primaryKey !== 'string'
  ) {
    return localCorrupt('schema descriptor');
  }
  return {
    name: value.name,
    primaryKey: value.primaryKey,
    columns: decodeColumns(value.columns),
  };
}

/**
 * D1: the semantic local types of every table in the running generated schema,
 * built from {@link localColumnType} — never from SQLite affinity.
 */
function buildLocalSchemaDescriptor(
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

/** Strict decode: an unknown shape is corruption, never a best guess. */
function decodeLocalSchemaDescriptor(value: string): LocalSchemaDescriptor {
  const record = parseJsonObject(value);
  if (record === undefined) return localCorrupt('schema descriptor');
  if (
    !hasExactKeys(record, ['tables', 'v', 'version']) ||
    record.v !== DESCRIPTOR_VERSION ||
    !isCount(record.version) ||
    !Array.isArray(record.tables)
  ) {
    return localCorrupt('schema descriptor');
  }
  return {
    v: 1,
    version: record.version,
    tables: record.tables.map(decodeTable),
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
// Container file (D3, moved off the replica connection)
// ---------------------------------------------------------------------------

/** Drop both container tables. Also the unconditional orphan sweep (D5). */
export function dropPreviousVersionContainer(db: ClientDatabase): void {
  db.exec(`DROP TABLE IF EXISTS ${quoteIdent(CONTAINER_TABLE)}`);
  db.exec(`DROP TABLE IF EXISTS ${quoteIdent(CONTAINER_META_TABLE)}`);
}

/**
 * Run `fn` against the container file for exactly one open window, closing the
 * handle afterwards. The container is only opened where `siblingExists` already
 * reports it — probing never creates the file. `removeFile` deletes the file
 * once the handle is closed (a sweep or a discard must leave none). Returns
 * `undefined` when the file or the host's sibling capability is absent.
 */
export function withPreviousVersionContainer<T>(
  db: ClientDatabase,
  fn: (container: ClientDatabase) => T,
  removeFile = false,
): T | undefined {
  if (db.siblingExists?.(PREVIOUS_VERSION_CONTAINER_NAME) !== true) {
    return undefined;
  }
  const handle = db.openSibling?.(PREVIOUS_VERSION_CONTAINER_NAME);
  if (handle === undefined) return undefined;
  try {
    return fn(handle.database);
  } finally {
    handle.close();
    if (removeFile) handle.removeFile();
  }
}

/** Read the container's own metadata record; `undefined` when absent/corrupt. */
export function readPreviousVersionContainer(
  db: ClientDatabase,
): PreviousVersionRecord | undefined {
  const meta = db.query(
    "SELECT 1 AS present FROM sqlite_master WHERE type='table' AND name=?",
    [CONTAINER_META_TABLE],
  );
  if (meta.length === 0) return undefined;
  const raw = db.query(
    `SELECT record FROM ${quoteIdent(CONTAINER_META_TABLE)} WHERE id=1`,
  )[0]?.record;
  if (raw === undefined) return undefined;
  try {
    return decodeRecord(String(raw));
  } catch {
    return undefined;
  }
}

function decodeRecord(value: string): PreviousVersionRecord {
  const record = parseJsonObject(value);
  if (record === undefined) return localCorrupt('previous-version context');
  if (
    !hasExactKeys(record, [
      'bytes',
      'createdAtMs',
      'currentVersion',
      'previousVersion',
      'rows',
      'tables',
      'v',
    ]) ||
    record.v !== 1 ||
    !isCount(record.bytes) ||
    !isCount(record.createdAtMs) ||
    !isCount(record.currentVersion) ||
    !isCount(record.previousVersion) ||
    !isCount(record.rows) ||
    !Array.isArray(record.tables)
  ) {
    return localCorrupt('previous-version context');
  }
  return {
    v: 1,
    previousVersion: record.previousVersion,
    currentVersion: record.currentVersion,
    tables: record.tables.map(decodeTable),
    rows: record.rows,
    bytes: record.bytes,
    createdAtMs: record.createdAtMs,
  };
}

function writeRecord(db: ClientDatabase, record: PreviousVersionRecord): void {
  db.exec(
    `CREATE TABLE IF NOT EXISTS ${quoteIdent(CONTAINER_META_TABLE)}(id INTEGER PRIMARY KEY CHECK(id=1),record TEXT NOT NULL)`,
  );
  db.exec(`DELETE FROM ${quoteIdent(CONTAINER_META_TABLE)}`);
  db.exec(
    `INSERT INTO ${quoteIdent(CONTAINER_META_TABLE)}(id,record)VALUES(1,?)`,
    [JSON.stringify(record)],
  );
}

// ---------------------------------------------------------------------------
// Bounded capture (D2 / A4)
// ---------------------------------------------------------------------------

/**
 * D2/A4: measure the capture BEFORE materializing anything. Ordered probes,
 * aborting on the first violation:
 *
 * 1. table count from `sqlite_master`;
 * 2. per-table row count with a `LIMIT maxRows + 1` early-abort probe;
 * 3. a single-row probe for rows larger than `maxRowBytes`;
 * 4. a bounded `SUM` over a `LIMIT`ed subquery;
 * 5. the copy itself into the CONTAINER file, in {@link COPY_BATCH_ROWS}
 *    batches and one container transaction.
 */
export function capturePreviousVersion(
  replica: ClientDatabase,
  container: ClientDatabase,
  oldDescriptor: LocalSchemaDescriptor,
  newSchema: CompiledClientSchema,
  config: PreviousVersionCaptureConfig,
  nowMs: number,
): PreviousVersionCaptureOutcome {
  const discovered = new Set(
    replica
      .query(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE '_syncular_%' AND name NOT LIKE 'sqlite_%'",
      )
      .map((row) => String(row.name)),
  );
  // Only descriptor-known tables carry semantic types; those are the tables the
  // copy would hold, and the count the table budget bounds.
  const tables = oldDescriptor.tables.filter((table) =>
    discovered.has(table.name),
  );
  const over = (
    rows: number,
    bytes: number,
  ): PreviousVersionCaptureOutcome => ({
    ok: false,
    reason: 'capture-exceeded-budget',
    measurement: { tables: tables.length, rows, bytes },
  });
  if (tables.length > config.maxTables) return over(0, 0);

  let measuredRows = 0;
  const perTableRows: number[] = [];
  for (const table of tables) {
    const probeRows = Number(
      replica.query(
        `SELECT COUNT(*)AS count FROM(SELECT 1 FROM ${quoteIdent(table.name)} LIMIT ?)`,
        [config.maxRows + 1],
      )[0]?.count ?? 0,
    );
    measuredRows += probeRows;
    perTableRows.push(probeRows);
    if (measuredRows > config.maxRows) return over(measuredRows, 0);
  }

  let measuredBytes = 0;
  for (let index = 0; index < tables.length; index++) {
    const table = tables[index] as LocalSchemaDescriptorTable;
    const byteSum = table.columns
      .map((c) => `COALESCE(LENGTH(CAST(${quoteIdent(c.name)} AS BLOB)), 0)`)
      .join(' + ');
    if (table.columns.length === 0) continue;
    const oversized = replica.query(
      `SELECT 1 AS hit FROM ${quoteIdent(table.name)} WHERE(${byteSum})>? LIMIT 1`,
      [config.maxRowBytes],
    );
    if (oversized.length > 0) return over(measuredRows, measuredBytes);
    const total = replica.query(
      `SELECT COALESCE(SUM(bytes),0)AS total FROM(SELECT(${byteSum})AS bytes FROM ${quoteIdent(table.name)} LIMIT ?)`,
      [perTableRows[index] ?? 0],
    )[0]?.total;
    measuredBytes += Number(total ?? 0);
    if (measuredBytes > config.maxBytes)
      return over(measuredRows, measuredBytes);
  }

  let copiedRows = 0;
  container.transaction(() => {
    dropPreviousVersionContainer(container);
    container.exec(
      `CREATE TABLE ${quoteIdent(CONTAINER_TABLE)}(tbl TEXT NOT NULL,row_id TEXT NOT NULL,payload TEXT NOT NULL,PRIMARY KEY(tbl,row_id))`,
    );
    for (const table of tables) {
      const selectColumns = table.columns
        .map((column) => quoteIdent(column.name))
        .join(', ');
      let lastRowId = -(2 ** 63);
      for (;;) {
        const rows = replica.query(
          `SELECT rowid AS _rid,${selectColumns} FROM ${quoteIdent(table.name)} WHERE rowid>? ORDER BY rowid ASC LIMIT ?`,
          [lastRowId, COPY_BATCH_ROWS],
        );
        if (rows.length === 0) break;
        for (const row of rows) {
          const payload: Record<string, JsonRowValue> = {};
          for (const column of table.columns) {
            const value: RowValue = fromSqlValue(
              { name: column.name, type: column.type, nullable: true },
              (row[column.name] ?? null) as SqlValue,
            );
            payload[column.name] = rowValueToJson(value);
          }
          container.exec(
            `INSERT INTO ${quoteIdent(CONTAINER_TABLE)}(tbl,row_id,payload)VALUES(?,?,?)`,
            [table.name, rowIdText(table, row), JSON.stringify(payload)],
          );
        }
        lastRowId = Number(rows[rows.length - 1]?._rid ?? lastRowId);
        copiedRows += rows.length;
      }
    }
    writeRecord(container, {
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
  });
  return {
    ok: true,
    measurement: {
      tables: tables.length,
      rows: copiedRows,
      bytes: measuredBytes,
    },
  };
}

function rowIdText(table: LocalSchemaDescriptorTable, row: SqlRow): string {
  const value = row[table.primaryKey] ?? null;
  if (value === null) return '';
  if (value instanceof Uint8Array) {
    return [...value]
      .map((byte) => byte.toString(16).padStart(2, '0'))
      .join('');
  }
  return String(value);
}

function decodePreviousVersionPayload(
  table: LocalSchemaDescriptorTable,
  payload: string,
): SqlRow {
  const record = parseJsonObject(payload);
  if (record === undefined) return localCorrupt('previous-version payload');
  const row: SqlRow = {};
  for (const column of table.columns) {
    row[column.name] = jsonToRowValue(
      (record[column.name] ?? null) as JsonRowValue,
    ) as SqlValue;
  }
  return row;
}

/** D7: read one previous table from the container, `limit + 1` rows for truncation. */
export function readPreviousVersionRows(
  db: ClientDatabase,
  table: LocalSchemaDescriptorTable,
  rowIds: readonly string[],
  limit: number,
): { rows: SqlRow[]; truncated: boolean } {
  const where =
    rowIds.length === 0
      ? ''
      : ` AND row_id IN (${rowIds.map(() => '?').join(', ')})`;
  const rows = db.query(
    `SELECT row_id,payload FROM ${quoteIdent(CONTAINER_TABLE)} WHERE tbl=?${where} ORDER BY row_id ASC LIMIT ?`,
    [table.name, ...rowIds, limit + 1],
  );
  const truncated = rows.length > limit;
  const visible = truncated ? rows.slice(0, limit) : rows;
  return {
    rows: visible.map((row) =>
      decodePreviousVersionPayload(table, String(row.payload)),
    ),
    truncated,
  };
}

// ---------------------------------------------------------------------------
// Durable refusal (read surface for a capture that stored nothing)
// ---------------------------------------------------------------------------

export function writePreviousVersionRefusal(
  db: ClientDatabase,
  reason: PreviousVersionRefusalReason,
  measurement: PreviousVersionCaptureMeasurement,
): void {
  const refusal: PreviousVersionRefusal = {
    v: 1,
    reason,
    tables: measurement.tables,
    rows: measurement.rows,
    bytes: measurement.bytes,
  };
  setMeta(db, PREVIOUS_VERSION_CONTEXT_KEY, JSON.stringify(refusal));
}

/** Delete the durable refusal. Part of the orphan sweep and of a successful capture. */
export function clearPreviousVersionRefusal(db: ClientDatabase): void {
  db.exec(`DELETE FROM ${META_TABLE} WHERE key=?`, [
    PREVIOUS_VERSION_CONTEXT_KEY,
  ]);
}

/** Decode the durable refusal; `undefined` when absent or corrupt. */
export function storedPreviousVersionRefusal(
  db: ClientDatabase,
): PreviousVersionRefusal | undefined {
  const raw = getMeta(db, PREVIOUS_VERSION_CONTEXT_KEY);
  if (raw === undefined) return undefined;
  const record = parseJsonObject(raw);
  if (record === undefined) return undefined;
  if (
    record.v !== 1 ||
    (record.reason !== 'no-previous-descriptor' &&
      record.reason !== 'capture-exceeded-budget')
  ) {
    return undefined;
  }
  return {
    v: 1,
    reason: record.reason,
    ...(isCount(record.tables) ? { tables: record.tables } : {}),
    ...(isCount(record.rows) ? { rows: record.rows } : {}),
    ...(isCount(record.bytes) ? { bytes: record.bytes } : {}),
  };
}

// ---------------------------------------------------------------------------
// Compatibility audit (D6)
// ---------------------------------------------------------------------------

interface PendingCommitLike {
  readonly clientCommitId: string;
  readonly operations: readonly {
    readonly table: string;
    readonly op: 'upsert' | 'delete';
    readonly values?: Readonly<Record<string, JsonRowValue>>;
    readonly insert?: true;
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
    // §7.4.4: a value-free delete stays encodable and takes ordinary server
    // validation, even against a removed table.
    if (operation.op === 'delete') continue;
    const table = schema.tables.get(operation.table);
    if (table === undefined) {
      return {
        commitId: commit.clientCommitId,
        table: operation.table,
        reason: 'unknown-table',
      };
    }
    for (const key of Object.keys(operation.values ?? {})) {
      if (!table.columnIndex.has(key)) {
        return {
          commitId: commit.clientCommitId,
          table: operation.table,
          reason: 'unknown-column',
          column: key,
        };
      }
    }
    // §7.1: an insert-intent operation presents every current column, so a
    // non-nullable column it lacks leaves the commit unencodable.
    if (operation.insert === true) {
      const missing = table.columns.find(
        (column) =>
          !column.nullable && operation.values?.[column.name] === undefined,
      );
      if (missing !== undefined) {
        return {
          commitId: commit.clientCommitId,
          table: operation.table,
          reason: 'missing-required-column',
          column: missing.name,
        };
      }
    }
  }
  return undefined;
}

/** Strict decode; `undefined` when absent or malformed. */
export function storedPreviousVersionAudit(
  db: ClientDatabase,
): PreviousVersionAudit | undefined {
  const raw = getMeta(db, PREVIOUS_VERSION_AUDIT_KEY);
  if (raw === undefined) return undefined;
  const record = parseJsonObject(raw);
  if (record === undefined) return undefined;
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
    if (!isRecord(entry)) {
      return undefined;
    }
    if (
      typeof entry.commitId !== 'string' ||
      typeof entry.table !== 'string' ||
      (entry.reason !== 'unknown-table' &&
        entry.reason !== 'unknown-column' &&
        entry.reason !== 'missing-required-column') ||
      (entry.column !== undefined && typeof entry.column !== 'string')
    ) {
      return undefined;
    }
    incompatible.push({
      commitId: entry.commitId,
      table: entry.table,
      reason: entry.reason,
      ...(typeof entry.column === 'string' ? { column: entry.column } : {}),
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

export function writePreviousVersionAudit(
  db: ClientDatabase,
  audit: PreviousVersionAudit,
): void {
  setMeta(db, PREVIOUS_VERSION_AUDIT_KEY, JSON.stringify(audit));
}

/** Delete the advisory audit. Part of a discard, never of a normal bump. */
export function clearPreviousVersionAudit(db: ClientDatabase): void {
  db.exec(`DELETE FROM ${META_TABLE} WHERE key=?`, [
    PREVIOUS_VERSION_AUDIT_KEY,
  ]);
}

// ---------------------------------------------------------------------------
// Strict bridge decoders (RFC 0005 D10)
//
// Compile-time host types are not runtime proof. A version-drifted Worker or
// native bridge could answer a read command with a forged `available: true`
// and a peer's protected rows, so every reply is validated against the closed
// public shape before an application can observe it.
// ---------------------------------------------------------------------------

/** Strictly decode a Worker/native `previousVersionSnapshot` reply. */
export function decodePreviousVersionSnapshot(
  value: unknown,
): PreviousVersionSnapshot {
  const method = 'previousVersionSnapshot';
  if (!isRecord(value)) {
    return invalidHostResponse(method);
  }
  const allowed = new Set<string>([
    ...SNAPSHOT_REQUIRED_KEYS,
    ...SNAPSHOT_OPTIONAL_KEYS,
  ]);
  const keys = Object.keys(value);
  if (
    !keys.every((key) => allowed.has(key)) ||
    SNAPSHOT_REQUIRED_KEYS.some((key) => !(key in value)) ||
    value.state !== 'previousVersion' ||
    typeof value.available !== 'boolean' ||
    !isCount(value.currentVersion) ||
    typeof value.truncated !== 'boolean' ||
    !Array.isArray(value.rows) ||
    !value.rows.every(isSqlRow)
  ) {
    return invalidHostResponse(method);
  }
  const reason = value.reason;
  const previousVersion = value.previousVersion;
  const rows = value.rows as SqlRow[];
  if (value.available) {
    // An available read names the previous version and never a refusal.
    if (!isCount(previousVersion) || reason !== undefined) {
      return invalidHostResponse(method);
    }
    return {
      state: 'previousVersion',
      available: true,
      previousVersion,
      currentVersion: value.currentVersion,
      rows,
      truncated: value.truncated,
    };
  }
  if (
    previousVersion !== undefined ||
    reason === undefined ||
    !PREVIOUS_VERSION_REASONS.includes(reason as PreviousVersionReason)
  ) {
    return invalidHostResponse(method);
  }
  return {
    state: 'previousVersion',
    available: false,
    currentVersion: value.currentVersion,
    reason: reason as PreviousVersionReason,
    rows,
    truncated: value.truncated,
  };
}

/**
 * Strictly decode a Worker/native `previousVersionAudit` reply. `undefined` is
 * the legitimate "no audit recorded" answer; anything else malformed throws.
 */
export function decodePreviousVersionAuditResult(
  value: unknown,
): PreviousVersionAudit | undefined {
  const method = 'previousVersionAudit';
  if (value === undefined) return undefined;
  if (!isRecord(value)) {
    return invalidHostResponse(method);
  }
  const keys = Object.keys(value).sort();
  if (keys.length !== AUDIT_KEYS.length) return invalidHostResponse(method);
  if (keys.some((key, index) => key !== AUDIT_KEYS[index])) {
    return invalidHostResponse(method);
  }
  if (
    value.v !== AUDIT_VERSION ||
    !isCount(value.atMs) ||
    !isCount(value.fromVersion) ||
    !isCount(value.toVersion) ||
    !isCount(value.pending) ||
    !isCount(value.encodable) ||
    typeof value.truncated !== 'boolean' ||
    !Array.isArray(value.incompatible) ||
    value.incompatible.length > MAX_AUDIT_INCOMPATIBLE
  ) {
    return invalidHostResponse(method);
  }
  const incompatible: PreviousVersionAuditEntry[] = [];
  for (const entry of value.incompatible) {
    if (!isRecord(entry)) {
      return invalidHostResponse(method);
    }
    if (
      !Object.keys(entry).every((key) =>
        (AUDIT_ENTRY_KEYS as readonly string[]).includes(key),
      ) ||
      typeof entry.commitId !== 'string' ||
      typeof entry.table !== 'string' ||
      (entry.reason !== 'unknown-table' &&
        entry.reason !== 'unknown-column' &&
        entry.reason !== 'missing-required-column') ||
      (entry.column !== undefined && typeof entry.column !== 'string')
    ) {
      return invalidHostResponse(method);
    }
    incompatible.push({
      commitId: entry.commitId,
      table: entry.table,
      reason: entry.reason,
      ...(typeof entry.column === 'string' ? { column: entry.column } : {}),
    });
  }
  return {
    v: 1,
    atMs: value.atMs,
    fromVersion: value.fromVersion,
    toVersion: value.toVersion,
    pending: value.pending,
    encodable: value.encodable,
    truncated: value.truncated,
    incompatible,
  };
}

/** Strictly decode a Worker/native `previousVersionDiscard` reply. */
export function decodePreviousVersionDiscardResult(value: unknown): {
  readonly present: boolean;
  readonly discarded: boolean;
} {
  const method = 'previousVersionDiscard';
  if (!isRecord(value)) {
    return invalidHostResponse(method);
  }
  const keys = Object.keys(value).sort();
  if (
    keys.length !== DISCARD_KEYS.length ||
    keys.some((key, index) => key !== DISCARD_KEYS[index]) ||
    typeof value.present !== 'boolean' ||
    typeof value.discarded !== 'boolean'
  ) {
    return invalidHostResponse(method);
  }
  return { present: value.present, discarded: value.discarded };
}
