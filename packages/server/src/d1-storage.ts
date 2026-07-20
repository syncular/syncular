/**
 * Cloudflare D1 server storage (TODO §4.2 — the Workers deployment rung).
 *
 * D1 *is* SQLite exposed over an async, statement-at-a-time API
 * (`prepare(sql).bind(...).all()` / `.first()` / `.run()`, plus `batch([…])`
 * for atomic multi-statement writes). So this storage shares the schema and
 * value codecs with `SqliteServerStorage` via `sqlite-dialect.ts` — same
 * DDL, same `?` placeholders, same JSON-scope / base64-push-result
 * serialization — and differs only in the execution shape (async, no
 * interactive transaction).
 *
 * ## Transaction model (the one real divergence)
 *
 * D1 has **no interactive transaction**: you cannot `BEGIN`, run
 * conditional reads and writes on a pinned connection, then `COMMIT`. The
 * only atomic primitive is `db.batch([stmt, …])` — a set of statements
 * applied in one implicit transaction, all-or-nothing.
 *
 * The push handler (§6) reads first (conflict detection via `getRow`) and
 * only then writes (`upsertRow`/`deleteRow`/`appendCommit`/
 * `putPushResult`). `D1Transaction` exploits exactly that ordering:
 *
 *   - reads (`getRow`) execute immediately against D1 (autocommit);
 *   - writes are **buffered** as prepared statements;
 *   - `commit()` flushes the whole buffer as one `db.batch(...)` — the same
 *     atomicity §6.4 requires (a rejected op rolls back by simply never
 *     flushing);
 *   - `rollback()` drops the buffer unsent.
 *
 * `appendCommit` allocates the dense per-partition `commitSeq` (§2.1) by
 * reading `max_commit_seq` live and buffering the `+1` write. Under a single
 * Worker request this is exact. Two concurrent pushes to one partition need an
 * external serialization point (normally a per-partition Durable Object); a
 * realtime notifier alone does not serialize HTTP writes. Every deployment
 * that accepts D1 pushes MUST front same-partition sync rounds with a
 * coordinating primitive (a DO or a Queue). The adapter fails closed unless
 * that coordinator explicitly sets `pushApplySerialized`, because D1 cannot
 * provide the required pre-operation lock.
 * This mirrors PostgreSQL's per-partition row lock, achieved by placement
 * rather than a lock D1 does not expose.
 */
import { decodeRow, type RowValue } from '@syncular/core';
import { syncError } from './errors';
import {
  commitWindowPageSql,
  deleteRowSql,
  dropTableDdl,
  indexRowPageStatement,
  layoutsOf,
  migratePayload,
  parseLayouts,
  quoteIdent,
  retiredTableNames,
  rewritePlan,
  rewriteRowSql,
  rewriteValues,
  SCHEMA_META_DDL_SQLITE,
  type StoredColumnLayout,
  scanRowPageSql,
  schemaDdl,
  selectRowScopesSql,
  selectRowSql,
  selectRowsForRewriteSql,
  tableColumnNames,
  toSqlValue,
  upsertSql,
  upsertValues,
} from './relational-rows';
import type { CompiledSchema, CompiledTable } from './schema';
import { matchesEffective } from './scopes';
import {
  asUint8Array,
  collectCommitWindowPage,
  deserializePushResult,
  type SqliteCommitWindowRecord,
  type SqliteRowRecord,
  serializePushResult,
  sqliteDdlStatements,
  toStoredRow,
} from './sqlite-dialect';
import type {
  ClientCursorInfo,
  ClientRecord,
  ClientSubscription,
  CommitMetadata,
  CommitMetadataQuery,
  CommitWindowQuery,
  IndexRowScanQuery,
  NewCommit,
  RowScanQuery,
  ScopeActivityQuery,
  ScopeCommitActivity,
  ServerStorage,
  StorageTransaction,
  StoredCommit,
  StoredPushResult,
  StoredRow,
} from './storage';
import { isD1ConstraintError, StorageConstraintError } from './storage-errors';
import { assertScopeIndexedScan, resolveIndexRowScan } from './storage-query';

// -- The subset of the D1 API this storage uses (structural typing) ---------
// Declared locally so the package takes no `@cloudflare/workers-types`
// dependency; the real `D1Database` binding is structurally compatible.

export interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<{ results: T[] }>;
  run(): Promise<unknown>;
}

export interface D1Database {
  prepare(query: string): D1PreparedStatement;
  batch(statements: D1PreparedStatement[]): Promise<unknown[]>;
  exec(query: string): Promise<unknown>;
}

/** A buffered write: the SQL text plus its bound parameters. */
interface BufferedStatement {
  readonly sql: string;
  readonly params: readonly unknown[];
}

function relationalValuesEqual(left: RowValue, right: RowValue): boolean {
  if (left instanceof Uint8Array && right instanceof Uint8Array) {
    return (
      left.length === right.length &&
      left.every((value, index) => value === right[index])
    );
  }
  return Object.is(left, right);
}

/** Read-your-own-writes overlay entry: a buffered upsert, or a deletion. */
type PendingRow =
  | { readonly kind: 'row'; readonly row: StoredRow }
  | {
      readonly kind: 'deleted';
    };

class D1Transaction implements StorageTransaction {
  readonly #db: D1Database;
  readonly #partition: string;
  readonly #resolveTable: (name: string) => CompiledTable;
  readonly #pushApplySerialized: boolean;
  readonly #buffer: BufferedStatement[] = [];
  #open = true;
  /** Live snapshot of `max_commit_seq`, advanced within this transaction. */
  #maxCommitSeq: number | undefined;
  #pushApplyCheckpoint: number | undefined;
  /**
   * Distinct opIndexes of buffered application upserts. A constraint that
   * only fires at `db.batch(...)` commit time (e.g. NOT NULL/CHECK the
   * `#assertNoUniqueCollision` pre-check cannot see) is reported by D1 for
   * the batch as a whole, and the batch API offers no way to re-run
   * statements individually without applying them. So attribution at commit
   * time is exact when the commit buffered exactly one application opIndex
   * and conservatively omitted otherwise (the push layer then records its
   * first-op default).
   */
  readonly #applicationOpIndexes = new Set<number>();
  /**
   * Read-your-own-writes overlay (§6.2 needs `getRow` to see buffered writes
   * of the same commit — e.g. two ops touching the same row): keyed
   * `tbl\u0000rowId` → the pending state, consulted by `getRow` before D1.
   */
  readonly #pending = new Map<string, PendingRow>();

  constructor(
    db: D1Database,
    partition: string,
    resolveTable: (name: string) => CompiledTable,
    pushApplySerialized: boolean,
  ) {
    this.#db = db;
    this.#partition = partition;
    this.#resolveTable = resolveTable;
    this.#pushApplySerialized = pushApplySerialized;
  }

  #assertOpen(): void {
    if (!this.#open) throw new Error('transaction already finished');
  }

  #buffer_(sql: string, params: readonly unknown[]): void {
    this.#buffer.push({ sql, params });
  }

  static #key(table: string, rowId: string): string {
    return `${table}\u0000${rowId}`;
  }

  async getRow(table: string, rowId: string): Promise<StoredRow | undefined> {
    this.#assertOpen();
    const pending = this.#pending.get(D1Transaction.#key(table, rowId));
    if (pending !== undefined) {
      return pending.kind === 'row' ? pending.row : undefined;
    }
    const record = await this.#db
      .prepare(selectRowSql(this.#resolveTable(table), 'sqlite'))
      .bind(this.#partition, rowId)
      .first<SqliteRowRecord>();
    return record === null ? undefined : toStoredRow(record);
  }

  async getPushResult(
    clientId: string,
    clientCommitId: string,
  ): Promise<StoredPushResult | undefined> {
    this.#assertOpen();
    // D1 reads run in autocommit; the push layer's duplicate re-check happens
    // before this transaction buffers any write, so a direct read is exact.
    const record = await this.#db
      .prepare(
        'SELECT result FROM sync_push_results WHERE partition=? AND client_id=? AND client_commit_id=?',
      )
      .bind(this.#partition, clientId, clientCommitId)
      .first<{ result: string }>();
    if (record === null) return undefined;
    try {
      return deserializePushResult(record.result);
    } catch {
      throw syncError(
        'sync.idempotency_cache_miss',
        'persisted push result unreadable (§6.3)',
      );
    }
  }

  async scanRows(query: RowScanQuery): Promise<StoredRow[]> {
    this.#assertOpen();
    const firstVariable = assertScopeIndexedScan(query);
    const firstValues = query.scopeFilter[firstVariable] ?? [];
    if (firstValues.length === 0) return [];

    const pendingForTable = [...this.#pending.entries()].filter(([key]) =>
      key.startsWith(`${query.table}\u0000`),
    );
    const persistedLimit = query.limit + pendingForTable.length;
    const sql = scanRowPageSql(
      this.#resolveTable(query.table),
      firstValues.length,
      'sqlite',
    );
    const persisted: StoredRow[] = [];
    let afterRowId = query.afterRowId ?? '';
    const batchSize = Math.max(64, persistedLimit);
    while (persisted.length < persistedLimit) {
      const { results: records } = await this.#db
        .prepare(sql)
        .bind(
          this.#partition,
          query.table,
          firstVariable,
          ...firstValues,
          afterRowId,
          batchSize,
          this.#partition,
        )
        .all<SqliteRowRecord & { payload: Uint8Array | null }>();
      if (records.length === 0) break;
      for (const record of records) {
        afterRowId = record.row_id;
        if (record.payload === null) continue;
        const stored = toStoredRow(record);
        if (!matchesEffective(stored.scopes, query.scopeFilter)) continue;
        persisted.push(stored);
        if (persisted.length >= persistedLimit) break;
      }
      if (records.length < batchSize) break;
    }

    const rows = new Map(persisted.map((row) => [row.rowId, row] as const));
    const lowerBound = query.afterRowId ?? '';
    for (const [key, pending] of pendingForTable) {
      const rowId = key.slice(query.table.length + 1);
      rows.delete(rowId);
      if (
        pending.kind === 'row' &&
        rowId > lowerBound &&
        matchesEffective(pending.row.scopes, query.scopeFilter)
      ) {
        rows.set(rowId, pending.row);
      }
    }
    return [...rows.values()]
      .sort((left, right) => left.rowId.localeCompare(right.rowId))
      .slice(0, query.limit);
  }

  async scanRowsByIndex(query: IndexRowScanQuery): Promise<StoredRow[]> {
    this.#assertOpen();
    const table = this.#resolveTable(query.table);
    const index = resolveIndexRowScan(table, query);
    const pendingForTable = [...this.#pending.entries()].filter(([key]) =>
      key.startsWith(`${query.table}\u0000`),
    );
    const persistedLimit = query.limit + pendingForTable.length;
    const statement = indexRowPageStatement(
      table,
      index,
      query.values,
      this.#partition,
      query.afterRowId,
      persistedLimit,
      'sqlite',
    );
    const { results: records } = await this.#db
      .prepare(statement.sql)
      .bind(...statement.params)
      .all<SqliteRowRecord>();

    const rows = new Map(
      records.map((record) => {
        const row = toStoredRow(record);
        return [row.rowId, row] as const;
      }),
    );
    const columnPositions = index.columns.map((column) => {
      const position = table.columnIndex.get(column);
      if (position === undefined) {
        throw new Error('compiled relational index references unknown column');
      }
      return position;
    });
    const lowerBound = query.afterRowId ?? '';
    for (const [key, pending] of pendingForTable) {
      const rowId = key.slice(query.table.length + 1);
      rows.delete(rowId);
      if (pending.kind !== 'row' || rowId <= lowerBound) continue;
      const values = decodeRow(table.columns, pending.row.payload);
      const matches = columnPositions.every((position, valueIndex) =>
        relationalValuesEqual(
          values[position] ?? null,
          query.values[valueIndex] ?? null,
        ),
      );
      if (matches) rows.set(rowId, pending.row);
    }
    return [...rows.values()]
      .sort((left, right) => left.rowId.localeCompare(right.rowId))
      .slice(0, query.limit);
  }

  async lockPartitionForPush(): Promise<void> {
    this.#assertOpen();
    if (!this.#pushApplySerialized) {
      throw new Error(
        'D1 push apply requires externally serialized partition writes',
      );
    }
    // D1 has no interactive lock. The caller explicitly asserted that every
    // write for this partition is already serialized (normally by its DO).
    this.#pushApplyCheckpoint = this.#buffer.length;
  }

  async commitRejectedPushResult(
    clientId: string,
    clientCommitId: string,
    result: StoredPushResult,
  ): Promise<void> {
    this.#assertOpen();
    const checkpoint = this.#pushApplyCheckpoint;
    if (checkpoint === undefined) {
      throw new Error('push rejection requires its apply checkpoint');
    }
    this.#buffer.length = checkpoint;
    this.#pending.clear();
    this.#maxCommitSeq = undefined;
    this.#applicationOpIndexes.clear();
    await this.putPushResult(clientId, clientCommitId, result);
    await this.commit();
  }

  async #assertNoUniqueCollision(
    table: CompiledTable,
    row: StoredRow,
    opIndex: number | undefined,
  ): Promise<void> {
    if (!table.materialize) return;
    const uniqueIndexes = table.indexes.filter(
      (index) => index.unique === true,
    );
    if (uniqueIndexes.length === 0) return;
    const incoming = decodeRow(table.columns, row.payload);

    for (const index of uniqueIndexes) {
      const indices = index.columns.map((column) => {
        const resolved = table.columnIndex.get(column);
        if (resolved === undefined) {
          throw new Error(`compiled unique index references unknown column`);
        }
        return resolved;
      });
      const values = indices.map((position) => incoming[position] ?? null);
      // SQLite UNIQUE permits multiple rows when any indexed value is NULL.
      if (values.some((value) => value === null)) continue;

      for (const [key, pending] of this.#pending) {
        if (!key.startsWith(`${table.name}\u0000`) || pending.kind !== 'row') {
          continue;
        }
        if (pending.row.rowId === row.rowId) continue;
        const candidate = decodeRow(table.columns, pending.row.payload);
        if (
          indices.every((position, valueIndex) =>
            relationalValuesEqual(
              candidate[position] ?? null,
              values[valueIndex] ?? null,
            ),
          )
        ) {
          throw new StorageConstraintError(undefined, opIndex);
        }
      }

      const predicates = index.columns
        .map((column) => `${quoteIdent(column)}=?`)
        .join(' AND ');
      const sql = `SELECT ${quoteIdent('_sync_row_id')} AS row_id FROM ${quoteIdent(table.name)} WHERE ${quoteIdent('_sync_partition')}=? AND ${predicates} AND ${quoteIdent('_sync_row_id')}<>? LIMIT 1`;
      const bind = indices.map((position, valueIndex) => {
        const schemaColumn =
          position === undefined ? undefined : table.columns[position];
        if (schemaColumn === undefined) {
          throw new Error(`compiled unique index references unknown column`);
        }
        return toSqlValue(schemaColumn, values[valueIndex] ?? null, 'sqlite');
      });
      const persisted = await this.#db
        .prepare(sql)
        .bind(this.#partition, ...bind, row.rowId)
        .first<{ row_id: string }>();
      if (persisted === null) continue;

      const pending = this.#pending.get(
        D1Transaction.#key(table.name, persisted.row_id),
      );
      if (pending?.kind === 'deleted') continue;
      if (pending?.kind === 'row') {
        const candidate = decodeRow(table.columns, pending.row.payload);
        const stillCollides = indices.every((position, valueIndex) =>
          relationalValuesEqual(
            candidate[position] ?? null,
            values[valueIndex] ?? null,
          ),
        );
        if (!stillCollides) continue;
      }
      throw new StorageConstraintError(undefined, opIndex);
    }
  }

  async upsertRow(
    table: string,
    row: StoredRow,
    context?: { readonly opIndex: number },
  ): Promise<void> {
    this.#assertOpen();
    const compiled = this.#resolveTable(table);
    await this.#assertNoUniqueCollision(compiled, row, context?.opIndex);
    if (context?.opIndex !== undefined) {
      this.#applicationOpIndexes.add(context.opIndex);
    }
    this.#pending.set(D1Transaction.#key(table, row.rowId), {
      kind: 'row',
      row,
    });
    const p = this.#partition;
    this.#buffer_(
      upsertSql(compiled, 'sqlite'),
      upsertValues(compiled, p, row, 'sqlite'),
    );
    this.#buffer_(
      'DELETE FROM sync_row_scopes WHERE partition=? AND tbl=? AND row_id=?',
      [p, table, row.rowId],
    );
    for (const [variable, value] of Object.entries(row.scopes)) {
      this.#buffer_(
        'INSERT OR IGNORE INTO sync_row_scopes(partition, tbl, var, value, row_id) VALUES (?,?,?,?,?)',
        [p, table, variable, value, row.rowId],
      );
    }
  }

  async deleteRow(table: string, rowId: string): Promise<void> {
    this.#assertOpen();
    this.#pending.set(D1Transaction.#key(table, rowId), { kind: 'deleted' });
    const p = this.#partition;
    this.#buffer_(deleteRowSql(this.#resolveTable(table), 'sqlite'), [
      p,
      rowId,
    ]);
    this.#buffer_(
      'DELETE FROM sync_row_scopes WHERE partition=? AND tbl=? AND row_id=?',
      [p, table, rowId],
    );
    // §5.9.4: a deleted row references no blobs.
    this.#buffer_(
      'DELETE FROM sync_blob_refs WHERE partition=? AND tbl=? AND row_id=?',
      [p, table, rowId],
    );
  }

  async setBlobRefs(
    table: string,
    rowId: string,
    blobIds: readonly string[],
  ): Promise<void> {
    this.#assertOpen();
    const p = this.#partition;
    this.#buffer_(
      'DELETE FROM sync_blob_refs WHERE partition=? AND tbl=? AND row_id=?',
      [p, table, rowId],
    );
    for (const blobId of blobIds) {
      this.#buffer_(
        'INSERT OR IGNORE INTO sync_blob_refs(partition, tbl, row_id, blob_id) VALUES (?,?,?,?)',
        [p, table, rowId, blobId],
      );
    }
  }

  async appendCommit(commit: NewCommit): Promise<number> {
    this.#assertOpen();
    const p = this.#partition;
    // Read the live counter once, then advance it in memory for this tx; the
    // increment is buffered and lands atomically at commit() (see header for
    // the concurrency posture).
    if (this.#maxCommitSeq === undefined) {
      const row = await this.#db
        .prepare('SELECT max_commit_seq FROM sync_partitions WHERE partition=?')
        .bind(p)
        .first<{ max_commit_seq: number }>();
      this.#maxCommitSeq = row?.max_commit_seq ?? 0;
    }
    const commitSeq = this.#maxCommitSeq + 1;
    this.#maxCommitSeq = commitSeq;
    this.#buffer_(
      'INSERT INTO sync_partitions(partition, max_commit_seq) VALUES (?,?) ON CONFLICT(partition) DO UPDATE SET max_commit_seq=excluded.max_commit_seq',
      [p, commitSeq],
    );
    this.#buffer_(
      'INSERT INTO sync_commits(partition, commit_seq, client_id, client_commit_id, actor_id, created_at_ms) VALUES (?,?,?,?,?,?)',
      [
        p,
        commitSeq,
        commit.clientId,
        commit.clientCommitId,
        commit.actorId,
        commit.createdAtMs,
      ],
    );
    commit.changes.forEach((change, idx) => {
      this.#buffer_(
        'INSERT INTO sync_changes(partition, commit_seq, idx, tbl, row_id, op, row_version, scopes, payload) VALUES (?,?,?,?,?,?,?,?,?)',
        [
          p,
          commitSeq,
          idx,
          change.table,
          change.rowId,
          change.op === 'upsert' ? 1 : 2,
          change.rowVersion ?? null,
          JSON.stringify(change.scopes),
          change.payload ?? null,
        ],
      );
      for (const [variable, value] of Object.entries(change.scopes)) {
        this.#buffer_(
          'INSERT OR IGNORE INTO sync_change_scopes(partition, tbl, var, value, commit_seq) VALUES (?,?,?,?,?)',
          [p, change.table, variable, value, commitSeq],
        );
      }
    });
    return commitSeq;
  }

  async putPushResult(
    clientId: string,
    clientCommitId: string,
    result: StoredPushResult,
  ): Promise<void> {
    this.#assertOpen();
    this.#buffer_(
      'INSERT OR IGNORE INTO sync_push_results(partition, client_id, client_commit_id, result) VALUES (?,?,?,?)',
      [this.#partition, clientId, clientCommitId, serializePushResult(result)],
    );
  }

  async commit(): Promise<void> {
    this.#assertOpen();
    if (this.#buffer.length === 0) {
      this.#open = false;
      return;
    }
    const statements = this.#buffer.map((entry) =>
      this.#db.prepare(entry.sql).bind(...entry.params),
    );
    // One atomic D1 batch — the §6.4 all-or-nothing commit.
    try {
      await this.#db.batch(statements);
      this.#open = false;
    } catch (error) {
      if (isD1ConstraintError(error)) {
        // D1 batches are atomic. Keep this logical transaction open so the
        // push layer can discard its buffered candidates and persist the
        // terminal rejection while the external partition queue is retained.
        // See `#applicationOpIndexes` for the attribution contract.
        const opIndexes = [...this.#applicationOpIndexes];
        throw new StorageConstraintError(
          error,
          opIndexes.length === 1 ? opIndexes[0] : undefined,
        );
      }
      throw error;
    }
  }

  async rollback(): Promise<void> {
    if (!this.#open) return;
    this.#open = false;
    this.#buffer.length = 0;
  }
}

/**
 * D1 caps bound parameters at 100 per statement; the relational upsert
 * binds one per app column plus the five `_sync_*` meta columns.
 */
const D1_MAX_BIND_PARAMS = 100;

export interface D1ServerStorageOptions {
  /**
   * Assert that all writes for a partition reach this storage serially.
   * Required for every push because D1 exposes no interactive transaction
   * lock. Set this only inside an explicit per-partition request queue,
   * Durable Object, or equivalent coordinator; the default fails closed.
   */
  readonly pushApplySerialized?: boolean;
  /**
   * @deprecated Use `pushApplySerialized`. This alias remains valid only
   * because the old assertion already promised that every partition write,
   * not merely validator callbacks, was externally serialized.
   */
  readonly commitValidationSerialized?: boolean;
}

export class D1ServerStorage implements ServerStorage {
  readonly #db: D1Database;
  readonly #pushApplySerialized: boolean;
  /** Set by `ensureSchema`: app-table lookup for the relational row store. */
  #tables: ReadonlyMap<string, CompiledTable> | undefined;
  #schemaVersion: number | undefined;

  constructor(db: D1Database, options: D1ServerStorageOptions = {}) {
    this.#db = db;
    this.#pushApplySerialized =
      options.pushApplySerialized === true ||
      options.commitValidationSerialized === true;
  }

  /** Apply the schema DDL (idempotent). Call once before use. */
  async migrate(): Promise<void> {
    for (const statement of sqliteDdlStatements()) {
      await this.#db.exec(`${statement.replace(/\s+/g, ' ')};`);
    }
  }

  /** Resolve a table's compiled schema; row operations require `ensureSchema`. */
  table(name: string): CompiledTable {
    const table = this.#tables?.get(name);
    if (table === undefined) {
      throw new Error(
        `unknown table ${JSON.stringify(name)} — ensureSchema(schema) must run before row operations`,
      );
    }
    return table;
  }

  async ensureSchema(schema: CompiledSchema): Promise<void> {
    // Memoized fast path: same instance, same schema version. D1 storages
    // are typically constructed per request — a fresh instance pays exactly
    // one marker read below when the version already matches.
    if (this.#schemaVersion === schema.version) return;
    for (const table of schema.tables.values()) {
      const bindCount = tableColumnNames(table).length;
      if (bindCount > D1_MAX_BIND_PARAMS) {
        throw new Error(
          `table ${JSON.stringify(table.name)} needs ${bindCount} bound parameters per upsert — D1 caps statements at ${D1_MAX_BIND_PARAMS} (DESIGN "D1 bind-parameter limit")`,
        );
      }
    }
    await this.#db.exec(`${SCHEMA_META_DDL_SQLITE.replace(/\s+/g, ' ')};`);
    const marker = await this.#db
      .prepare(
        'SELECT schema_version, layouts FROM sync_schema_meta WHERE id=1',
      )
      .first<{ schema_version: number; layouts: string }>();
    if (marker !== null && marker.schema_version > schema.version) {
      throw new Error(
        `stored schema version ${marker.schema_version} is newer than the configured schema (${schema.version}) — refusing to run an older server against a migrated database`,
      );
    }
    if (marker === null || marker.schema_version < schema.version) {
      await this.migrate();
      const layouts = parseLayouts(marker?.layouts);
      const retiredTables = retiredTableNames(schema, layouts);
      const existing = new Map<string, ReadonlySet<string>>();
      const existingIndexes = new Map<string, ReadonlySet<string>>();
      for (const table of schema.tables.values()) {
        const escapedTableName = table.name.replaceAll('"', '""');
        const { results } = await this.#db
          .prepare(`PRAGMA table_info("${escapedTableName}")`)
          .all<{ name: string }>();
        if (results.length > 0) {
          existing.set(table.name, new Set(results.map((c) => c.name)));
          const indexes = await this.#db
            .prepare(`PRAGMA index_list("${escapedTableName}")`)
            .all<{ name: string; origin: string }>();
          existingIndexes.set(
            table.name,
            new Set(
              indexes.results
                .filter((index) => index.origin === 'c')
                .map((index) => index.name),
            ),
          );
        }
      }
      for (const statement of schemaDdl(
        schema,
        existing,
        'sqlite',
        existingIndexes,
      )) {
        await this.#db.exec(`${statement.replace(/\s+/g, ' ')};`);
      }
      // Migration rewrite: payload re-encode on layout change and/or
      // projection backfill on flipped-on materialization. D1 has no
      // interactive transaction — the rewrite runs statement-at-a-time,
      // which is safe (each rewrite is idempotent and the marker only
      // advances after all rewrites land; a mid-run crash re-runs them).
      for (const table of schema.tables.values()) {
        const oldLayout = layouts[table.name];
        const plan = rewritePlan(table, oldLayout, existing.get(table.name));
        if (!plan.migrate && !plan.backfill) continue;
        await this.#rewriteRows(table, plan.migrate ? oldLayout : undefined);
      }
      // Retire tables only after the additive DDL and rewrites succeed. D1
      // cannot wrap the whole bump in an interactive transaction, but this
      // ordering avoids destructive work before every fallible preparatory
      // step and the batch keeps table + live-scope cleanup atomic.
      if (retiredTables.length > 0) {
        await this.#db.batch(
          retiredTables.flatMap((tableName) => [
            this.#db
              .prepare('DELETE FROM sync_row_scopes WHERE tbl=?')
              .bind(tableName),
            this.#db.prepare(dropTableDdl(tableName)),
          ]),
        );
      }
      await this.#db
        .prepare(
          'INSERT INTO sync_schema_meta(id, schema_version, layouts) VALUES (1, ?, ?) ON CONFLICT(id) DO UPDATE SET schema_version=excluded.schema_version, layouts=excluded.layouts',
        )
        .bind(schema.version, layoutsOf(schema))
        .run();
    }
    this.#tables = schema.tables;
    this.#schemaVersion = schema.version;
  }

  /** Keyset-paged migration rewrite (see the sqlite storage's counterpart). */
  async #rewriteRows(
    table: CompiledTable,
    oldLayout: readonly StoredColumnLayout[] | undefined,
  ): Promise<void> {
    const select = selectRowsForRewriteSql(table, 'sqlite');
    const update = rewriteRowSql(table, 'sqlite');
    const BATCH = 500;
    let afterPartition = '';
    let afterRowId = '';
    for (;;) {
      const { results } = await this.#db
        .prepare(select)
        .bind(afterPartition, afterRowId, BATCH)
        .all<{ partition: string; row_id: string; payload: unknown }>();
      if (results.length === 0) break;
      const statements = results.map((row) => {
        const bytes = asUint8Array(row.payload);
        const payload =
          oldLayout !== undefined
            ? migratePayload(oldLayout, table, bytes)
            : bytes;
        return this.#db
          .prepare(update)
          .bind(
            ...rewriteValues(
              table,
              row.partition,
              row.row_id,
              payload,
              'sqlite',
            ),
          );
      });
      await this.#db.batch(statements);
      const last = results[results.length - 1];
      if (last === undefined || results.length < BATCH) break;
      afterPartition = last.partition;
      afterRowId = last.row_id;
    }
  }

  async begin(partition: string): Promise<StorageTransaction> {
    return new D1Transaction(
      this.#db,
      partition,
      (name) => this.table(name),
      this.#pushApplySerialized,
    );
  }

  async getMaxCommitSeq(partition: string): Promise<number> {
    const row = await this.#db
      .prepare('SELECT max_commit_seq FROM sync_partitions WHERE partition=?')
      .bind(partition)
      .first<{ max_commit_seq: number }>();
    return row?.max_commit_seq ?? 0;
  }

  async getHorizonSeq(partition: string): Promise<number> {
    const row = await this.#db
      .prepare('SELECT horizon_seq FROM sync_partitions WHERE partition=?')
      .bind(partition)
      .first<{ horizon_seq: number }>();
    return row?.horizon_seq ?? 0;
  }

  async setHorizonSeq(partition: string, seq: number): Promise<void> {
    await this.#db
      .prepare(
        'INSERT INTO sync_partitions(partition, horizon_seq) VALUES (?,?) ON CONFLICT(partition) DO UPDATE SET horizon_seq=excluded.horizon_seq',
      )
      .bind(partition, seq)
      .run();
  }

  async pruneCommitsThrough(partition: string, seq: number): Promise<number> {
    const before = await this.#db
      .prepare(
        'SELECT count(*) AS n FROM sync_commits WHERE partition=? AND commit_seq<=?',
      )
      .bind(partition, seq)
      .first<{ n: number }>();
    await this.#db.batch([
      this.#db
        .prepare('DELETE FROM sync_commits WHERE partition=? AND commit_seq<=?')
        .bind(partition, seq),
      this.#db
        .prepare('DELETE FROM sync_changes WHERE partition=? AND commit_seq<=?')
        .bind(partition, seq),
      this.#db
        .prepare(
          'DELETE FROM sync_change_scopes WHERE partition=? AND commit_seq<=?',
        )
        .bind(partition, seq),
    ]);
    return before?.n ?? 0;
  }

  async getCommitSeqBefore(
    partition: string,
    createdBeforeMs: number,
  ): Promise<number> {
    const row = await this.#db
      .prepare(
        'SELECT max(commit_seq) AS seq FROM sync_commits WHERE partition=? AND created_at_ms<?',
      )
      .bind(partition, createdBeforeMs)
      .first<{ seq: number | null }>();
    return row?.seq ?? 0;
  }

  async getRow(
    partition: string,
    table: string,
    rowId: string,
  ): Promise<StoredRow | undefined> {
    const record = await this.#db
      .prepare(selectRowSql(this.table(table), 'sqlite'))
      .bind(partition, rowId)
      .first<SqliteRowRecord>();
    return record === null ? undefined : toStoredRow(record);
  }

  async getPushResult(
    partition: string,
    clientId: string,
    clientCommitId: string,
  ): Promise<StoredPushResult | undefined> {
    const record = await this.#db
      .prepare(
        'SELECT result FROM sync_push_results WHERE partition=? AND client_id=? AND client_commit_id=?',
      )
      .bind(partition, clientId, clientCommitId)
      .first<{ result: string }>();
    if (record === null) return undefined;
    try {
      return deserializePushResult(record.result);
    } catch {
      throw syncError(
        'sync.idempotency_cache_miss',
        'persisted push result unreadable (§6.3)',
      );
    }
  }

  async readCommitWindow(
    partition: string,
    query: CommitWindowQuery,
  ): Promise<StoredCommit[]> {
    const variables = Object.keys(query.scopeFilter).sort();
    const firstVariable = variables[0];
    if (firstVariable === undefined) return [];
    const firstValues = query.scopeFilter[firstVariable] ?? [];
    if (firstValues.length === 0) return [];
    // Candidates via the inverted index (one variable) LEFT JOINed to the
    // commit meta + the table's changes — one D1 round trip per page, never
    // two per candidate (see `commitWindowPageSql`). Exact multi-variable
    // verification against the stored scope map in `collectCommitWindowPage`.
    const sql = commitWindowPageSql(firstValues.length, 'sqlite');
    const commits: StoredCommit[] = [];
    let deliveredChanges = 0;
    let afterSeq = query.afterSeq;
    const batchSize = Math.max(64, query.limitChanges);
    while (deliveredChanges < query.limitChanges) {
      const { results: records } = await this.#db
        .prepare(sql)
        .bind(
          partition,
          query.table,
          firstVariable,
          ...firstValues,
          afterSeq,
          query.throughSeq,
          batchSize,
          partition,
          partition,
          query.table,
        )
        .all<SqliteCommitWindowRecord>();
      if (records.length === 0) break;
      const page = collectCommitWindowPage(
        records,
        query.scopeFilter,
        query.limitChanges - deliveredChanges,
      );
      commits.push(...page.commits);
      deliveredChanges += page.delivered;
      afterSeq = page.lastSeq;
      if (page.candidateCount < batchSize) break;
    }
    return commits;
  }

  async scanRows(partition: string, query: RowScanQuery): Promise<StoredRow[]> {
    const firstVariable = assertScopeIndexedScan(query);
    const firstValues = query.scopeFilter[firstVariable] ?? [];
    if (firstValues.length === 0) return [];
    // Candidates via the inverted index LEFT JOINed to the row table — one
    // D1 round trip per page, never one per row (see `scanRowPageSql`).
    // Exact multi-variable verification against the stored scope map below.
    const sql = scanRowPageSql(
      this.table(query.table),
      firstValues.length,
      'sqlite',
    );
    const rows: StoredRow[] = [];
    let afterRowId = query.afterRowId ?? '';
    const batchSize = Math.max(64, query.limit);
    while (rows.length < query.limit) {
      const { results: records } = await this.#db
        .prepare(sql)
        .bind(
          partition,
          query.table,
          firstVariable,
          ...firstValues,
          afterRowId,
          batchSize,
          partition,
        )
        .all<SqliteRowRecord & { payload: Uint8Array | null }>();
      if (records.length === 0) break;
      for (const record of records) {
        afterRowId = record.row_id;
        // NULL payload: an index candidate whose row vanished — it still
        // advances the keyset cursor (LEFT JOIN contract) but yields no row.
        if (record.payload === null) continue;
        const stored = toStoredRow(record);
        if (!matchesEffective(stored.scopes, query.scopeFilter)) continue;
        rows.push(stored);
        if (rows.length >= query.limit) break;
      }
      if (records.length < batchSize) break;
    }
    return rows;
  }

  async scanRowsByIndex(
    partition: string,
    query: IndexRowScanQuery,
  ): Promise<StoredRow[]> {
    const table = this.table(query.table);
    const index = resolveIndexRowScan(table, query);
    const statement = indexRowPageStatement(
      table,
      index,
      query.values,
      partition,
      query.afterRowId,
      query.limit,
      'sqlite',
    );
    const { results } = await this.#db
      .prepare(statement.sql)
      .bind(...statement.params)
      .all<SqliteRowRecord>();
    return results.map(toStoredRow);
  }

  async getClientRecord(
    partition: string,
    clientId: string,
  ): Promise<ClientRecord | undefined> {
    const record = await this.#db
      .prepare(
        'SELECT client_id, actor_id, cursor, subscriptions, updated_at_ms FROM sync_clients WHERE partition=? AND client_id=?',
      )
      .bind(partition, clientId)
      .first<{
        client_id: string;
        actor_id: string;
        cursor: number;
        subscriptions: string;
        updated_at_ms: number;
      }>();
    if (record === null) return undefined;
    return {
      clientId: record.client_id,
      actorId: record.actor_id,
      cursor: record.cursor,
      updatedAtMs: record.updated_at_ms,
      subscriptions: JSON.parse(record.subscriptions) as ClientSubscription[],
    };
  }

  async putClientRecord(
    partition: string,
    record: ClientRecord,
  ): Promise<void> {
    await this.#db
      .prepare(
        'INSERT OR REPLACE INTO sync_clients(partition, client_id, actor_id, cursor, subscriptions, updated_at_ms) VALUES (?,?,?,?,?,?)',
      )
      .bind(
        partition,
        record.clientId,
        record.actorId,
        record.cursor,
        JSON.stringify(record.subscriptions),
        record.updatedAtMs,
      )
      .run();
  }

  async listClientCursors(partition: string): Promise<ClientCursorInfo[]> {
    const { results } = await this.#db
      .prepare(
        'SELECT client_id, cursor, updated_at_ms FROM sync_clients WHERE partition=?',
      )
      .bind(partition)
      .all<{ client_id: string; cursor: number; updated_at_ms: number }>();
    return results.map((r) => ({
      clientId: r.client_id,
      cursor: r.cursor,
      updatedAtMs: r.updated_at_ms,
    }));
  }

  async listRowsReferencingBlob(
    partition: string,
    blobId: string,
  ): Promise<
    {
      readonly table: string;
      readonly rowId: string;
      readonly scopes: Record<string, string>;
    }[]
  > {
    const { results: refs } = await this.#db
      .prepare(
        'SELECT tbl, row_id FROM sync_blob_refs WHERE partition=? AND blob_id=?',
      )
      .bind(partition, blobId)
      .all<{ tbl: string; row_id: string }>();
    const out: {
      table: string;
      rowId: string;
      scopes: Record<string, string>;
    }[] = [];
    for (const ref of refs) {
      const compiled = this.#tables?.get(ref.tbl);
      if (compiled === undefined) continue; // table no longer in the schema
      const row = await this.#db
        .prepare(selectRowScopesSql(compiled, 'sqlite'))
        .bind(partition, ref.row_id)
        .first<{ scopes: string }>();
      if (row === null) continue;
      out.push({
        table: ref.tbl,
        rowId: ref.row_id,
        scopes: JSON.parse(row.scopes) as Record<string, string>,
      });
    }
    return out;
  }

  async listReferencedBlobIds(partition: string): Promise<string[]> {
    const { results } = await this.#db
      .prepare('SELECT DISTINCT blob_id FROM sync_blob_refs WHERE partition=?')
      .bind(partition)
      .all<{ blob_id: string }>();
    return results.map((r) => r.blob_id);
  }

  // -- admin/console read surface (TODO §2.5) --------------------------------

  async listClientRecords(partition: string): Promise<ClientRecord[]> {
    const { results } = await this.#db
      .prepare(
        'SELECT client_id, actor_id, cursor, subscriptions, updated_at_ms FROM sync_clients WHERE partition=? ORDER BY updated_at_ms DESC',
      )
      .bind(partition)
      .all<{
        client_id: string;
        actor_id: string;
        cursor: number;
        subscriptions: string;
        updated_at_ms: number;
      }>();
    return results.map((record) => ({
      clientId: record.client_id,
      actorId: record.actor_id,
      cursor: record.cursor,
      updatedAtMs: record.updated_at_ms,
      subscriptions: JSON.parse(record.subscriptions) as ClientSubscription[],
    }));
  }

  async listCommitMetadata(
    partition: string,
    query: CommitMetadataQuery,
  ): Promise<CommitMetadata[]> {
    const { results: rows } = query.table
      ? await this.#db
          .prepare(
            `SELECT c.commit_seq, c.client_id, c.client_commit_id, c.actor_id, c.created_at_ms
             FROM sync_commits c
             WHERE c.partition=? AND c.commit_seq>?
               AND EXISTS (SELECT 1 FROM sync_changes ch
                 WHERE ch.partition=c.partition AND ch.commit_seq=c.commit_seq AND ch.tbl=?)
             ORDER BY c.commit_seq DESC LIMIT ?`,
          )
          .bind(partition, query.afterSeq, query.table, query.limit)
          .all<{
            commit_seq: number;
            client_id: string;
            client_commit_id: string;
            actor_id: string;
            created_at_ms: number;
          }>()
      : await this.#db
          .prepare(
            `SELECT commit_seq, client_id, client_commit_id, actor_id, created_at_ms
             FROM sync_commits
             WHERE partition=? AND commit_seq>?
             ORDER BY commit_seq DESC LIMIT ?`,
          )
          .bind(partition, query.afterSeq, query.limit)
          .all<{
            commit_seq: number;
            client_id: string;
            client_commit_id: string;
            actor_id: string;
            created_at_ms: number;
          }>();
    const out: CommitMetadata[] = [];
    for (const row of rows) {
      const { results: changes } = await this.#db
        .prepare(
          'SELECT tbl, count(*) AS n FROM sync_changes WHERE partition=? AND commit_seq=? GROUP BY tbl',
        )
        .bind(partition, row.commit_seq)
        .all<{ tbl: string; n: number }>();
      out.push({
        commitSeq: row.commit_seq,
        clientId: row.client_id,
        clientCommitId: row.client_commit_id,
        actorId: row.actor_id,
        createdAtMs: row.created_at_ms,
        changeCount: changes.reduce((sum, c) => sum + c.n, 0),
        tables: changes.map((c) => c.tbl),
      });
    }
    return out;
  }

  async scopeActivity(
    partition: string,
    query: ScopeActivityQuery,
  ): Promise<ScopeCommitActivity[]> {
    const { results: rows } = await this.#db
      .prepare(
        `SELECT DISTINCT commit_seq, tbl FROM sync_change_scopes
         WHERE partition=? AND var=? AND value=?
         ORDER BY commit_seq DESC LIMIT ?`,
      )
      .bind(partition, query.variable, query.value, query.limit)
      .all<{ commit_seq: number; tbl: string }>();
    const out: ScopeCommitActivity[] = [];
    for (const row of rows) {
      const meta = await this.#db
        .prepare(
          'SELECT actor_id, created_at_ms FROM sync_commits WHERE partition=? AND commit_seq=?',
        )
        .bind(partition, row.commit_seq)
        .first<{ actor_id: string; created_at_ms: number }>();
      if (meta === null) continue;
      const count = await this.#db
        .prepare(
          'SELECT count(*) AS n FROM sync_changes WHERE partition=? AND commit_seq=? AND tbl=?',
        )
        .bind(partition, row.commit_seq, row.tbl)
        .first<{ n: number }>();
      out.push({
        commitSeq: row.commit_seq,
        table: row.tbl,
        createdAtMs: meta.created_at_ms,
        actorId: meta.actor_id,
        changeCount: count?.n ?? 0,
      });
    }
    return out;
  }

  async getRowScopes(
    partition: string,
    table: string,
    rowId: string,
  ): Promise<
    { serverVersion: number; scopes: Record<string, string> } | undefined
  > {
    const record = await this.#db
      .prepare(selectRowScopesSql(this.table(table), 'sqlite'))
      .bind(partition, rowId)
      .first<{ server_version: number; scopes: string }>();
    if (record === null) return undefined;
    return {
      serverVersion: record.server_version,
      scopes: JSON.parse(record.scopes) as Record<string, string>,
    };
  }

  async listPartitions(): Promise<string[]> {
    // Union: the registry row appears on first commit, the client row on
    // first pull — a partition with only one of the two still shows up.
    const { results } = await this.#db
      .prepare(
        `SELECT partition FROM sync_partitions
         UNION SELECT partition FROM sync_clients ORDER BY partition`,
      )
      .all<{ partition: string }>();
    return results.map((r) => r.partition);
  }
}
