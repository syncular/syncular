/**
 * Cloudflare D1 server storage for Workers deployments.
 *
 * D1 *is* SQLite exposed over an async, statement-at-a-time API
 * (`prepare(sql).bind(...).all()` / `.first()` / `.run()`, plus `batch([…])`
 * for atomic multi-statement writes). The statements it shares with
 * `SqliteServerStorage` live in `SqliteFamilyStorage` (`sqlite-dialect.ts`);
 * this class adds the execution seam, the published-schema guard, the
 * resumable schema migration and the buffered transaction.
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
import type { BoundAuthoritativeQuery } from './authoritative-query';
import {
  assertAppendOnlyMigration,
  assertPhysicalColumns,
  assertStoredLayouts,
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
  serverIndexDdl,
  SQLITE_TABLE_INDEXES_SQL,
  type SqliteTableIndexRow,
  sqliteIndexSignatures,
  selectRowSql,
  selectRowsSql,
  selectRowsForRewriteSql,
  tableColumnNames,
  toSqlValue,
} from './relational-rows';
import type { CompiledSchema, CompiledTable } from './schema';
import { matchesEffective } from './scopes';
import {
  asUint8Array,
  deserializePushResult,
  placeholders,
  type SqliteRowRecord,
  type SqliteStatementSpec,
  SqliteFamilyStorage,
  SqliteFamilyTransaction,
  sqliteDdlStatements,
  SYNC_CLIENT_ROUND_COLUMNS,
  toStoredRow,
} from './sqlite-dialect';
import type { SqliteValue } from './sqlite-driver';
import type {
  AuthoritativeQueryRequest,
  AuthoritativeQueryResult,
  CheckpointDeclaration,
  CommitPruneQuery,
  CommitPruneResult,
  IndexRowScanQuery,
  NewCommit,
  PreparedPushApply,
  RowScanQuery,
  ScopeValueHistoryQuery,
  ServerStorage,
  ServeGate,
  StorageTransaction,
  StoredCheckpoint,
  StoredPushResult,
  StoredRow,
} from './storage';
import {
  isD1ConstraintError,
  StorageConstraintError,
  StorageQueryError,
} from './storage-errors';
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

/** The rows of one `db.batch` result entry (`{ results }` per statement). */
function batchRows(result: unknown): unknown[] {
  if (
    typeof result !== 'object' ||
    result === null ||
    !('results' in result) ||
    !Array.isArray(result.results)
  ) {
    throw new Error('D1 batch returned an invalid result');
  }
  return result.results;
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

/** Run one partition-bound registered query and the cursor read as one batch. */
async function queryAuthoritativeOn(
  db: Pick<D1Database, 'prepare' | 'batch'>,
  partition: string,
  prepared: BoundAuthoritativeQuery,
): Promise<AuthoritativeQueryResult> {
  const results = await db.batch([
    db.prepare(prepared.sql).bind(...prepared.params),
    db
      .prepare('SELECT max_commit_seq FROM sync_partitions WHERE partition=?')
      .bind(partition),
  ]);
  const cursor = batchRows(results[1])[0];
  return {
    rows: batchRows(results[0]).filter(
      (row): row is Readonly<Record<string, unknown>> =>
        typeof row === 'object' && row !== null,
    ),
    maxCommitSeq:
      typeof cursor === 'object' &&
      cursor !== null &&
      'max_commit_seq' in cursor &&
      typeof cursor.max_commit_seq === 'number'
        ? cursor.max_commit_seq
        : 0,
  };
}

/** Read-your-own-writes overlay entry: a buffered upsert, or a deletion. */
type PendingRow =
  | { readonly kind: 'row'; readonly row: StoredRow }
  | {
      readonly kind: 'deleted';
    };

class D1Transaction
  extends SqliteFamilyTransaction
  implements StorageTransaction
{
  readonly #db: Pick<D1Database, 'prepare' | 'batch'>;
  readonly #resolveTable: (name: string) => CompiledTable;
  /** Storage-owned relation rewrite, bound to this transaction's partition. */
  readonly #prepareQuery: (
    query: AuthoritativeQueryRequest,
  ) => BoundAuthoritativeQuery;
  readonly #pushApplySerialized: boolean;
  readonly #buffer: SqliteStatementSpec[] = [];
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
  readonly #clearedTombstones = new Set<string>();
  /**
   * `prefetchRows` snapshot keyed `tbl\u0000rowId`: the stored row and its §5
   * tombstone, `undefined` when absent. Nothing persists before `commit()`,
   * so the snapshot stays exact; the `#pending` overlay still wins for rows
   * this transaction wrote.
   */
  readonly #prefetched = new Map<
    string,
    {
      readonly row: StoredRow | undefined;
      readonly tombstoneSeq: number | undefined;
    }
  >();

  constructor(
    db: Pick<D1Database, 'prepare' | 'batch'>,
    partition: string,
    resolveTable: (name: string) => CompiledTable,
    prepareQuery: (query: AuthoritativeQueryRequest) => BoundAuthoritativeQuery,
    pushApplySerialized: boolean,
  ) {
    super(partition);
    this.#db = db;
    this.#resolveTable = resolveTable;
    this.#prepareQuery = prepareQuery;
    this.#pushApplySerialized = pushApplySerialized;
  }

  protected run(sql: string, params: readonly SqliteValue[]): void {
    this.#buffer.push({ sql, params });
  }

  protected async all<T>(
    sql: string,
    params: readonly SqliteValue[],
  ): Promise<T[]> {
    return (
      await this.#db
        .prepare(sql)
        .bind(...params)
        .all<T>()
    ).results;
  }

  protected table(name: string): CompiledTable {
    return this.#resolveTable(name);
  }

  static #key(table: string, rowId: string): string {
    return `${table}\u0000${rowId}`;
  }

  async getRow(table: string, rowId: string): Promise<StoredRow | undefined> {
    this.assertOpen();
    const pending = this.#pending.get(D1Transaction.#key(table, rowId));
    if (pending !== undefined) {
      return pending.kind === 'row' ? pending.row : undefined;
    }
    const prefetched = this.#prefetched.get(D1Transaction.#key(table, rowId));
    if (prefetched !== undefined) return prefetched.row;
    const record = await this.#db
      .prepare(selectRowSql(this.table(table), 'sqlite'))
      .bind(this.partition, rowId)
      .first<SqliteRowRecord>();
    return record === null ? undefined : toStoredRow(record);
  }

  override async getTombstoneSeq(
    table: string,
    rowId: string,
  ): Promise<number | undefined> {
    this.assertOpen();
    // Persisted read, no #pending overlay: a delete buffered by this commit
    // records its tombstone at appendCommit, matching the SQLite/Postgres
    // adapters where the tombstone insert also runs at commit append.
    const key = D1Transaction.#key(table, rowId);
    if (this.#clearedTombstones.has(key)) return undefined;
    const prefetched = this.#prefetched.get(key);
    return prefetched === undefined
      ? super.getTombstoneSeq(table, rowId)
      : prefetched.tombstoneSeq;
  }

  /**
   * Read every named row and its tombstone in one `db.batch` (two statements
   * per table, ids bound as a JSON array), so a multi-operation push pays one
   * round trip instead of up to two per operation.
   */
  async prefetchRows(
    targets: readonly {
      readonly table: string;
      readonly rowIds: readonly string[];
    }[],
  ): Promise<void> {
    this.assertOpen();
    const specs = targets
      .map(({ table, rowIds }) => ({
        table,
        ids: [...new Set(rowIds)].filter(
          (rowId) => !this.#prefetched.has(D1Transaction.#key(table, rowId)),
        ),
      }))
      .filter(({ ids }) => ids.length > 0);
    if (specs.length === 0) return;
    const results = await this.#db.batch(
      specs.flatMap(({ table, ids }) => {
        const bound = JSON.stringify(ids);
        return [
          this.#db
            .prepare(selectRowsSql(this.table(table), 'sqlite'))
            .bind(this.partition, bound),
          this.#db
            .prepare(
              'SELECT row_id, commit_seq FROM sync_tombstones WHERE partition=? AND tbl=? AND row_id IN (SELECT value FROM json_each(?))',
            )
            .bind(this.partition, table, bound),
        ];
      }),
    );
    specs.forEach(({ table, ids }, i) => {
      const rows = new Map(
        (batchRows(results[2 * i]) as SqliteRowRecord[]).map((record) => [
          record.row_id,
          toStoredRow(record),
        ]),
      );
      const tombstones = new Map(
        (
          batchRows(results[2 * i + 1]) as {
            row_id: string;
            commit_seq: number;
          }[]
        ).map((record) => [record.row_id, record.commit_seq]),
      );
      for (const rowId of ids) {
        this.#prefetched.set(D1Transaction.#key(table, rowId), {
          row: rows.get(rowId),
          tombstoneSeq: tombstones.get(rowId),
        });
      }
    });
  }

  override async clearTombstone(table: string, rowId: string): Promise<void> {
    await super.clearTombstone(table, rowId);
    this.#clearedTombstones.add(D1Transaction.#key(table, rowId));
  }

  async getPushResult(
    clientId: string,
    clientCommitId: string,
  ): Promise<StoredPushResult | undefined> {
    this.assertOpen();
    // D1 reads run in autocommit; the push layer's duplicate re-check happens
    // before this transaction buffers any write, so a direct read is exact.
    const [record] = await this.all<{ result: string }>(
      'SELECT result FROM sync_push_results WHERE partition=? AND client_id=? AND client_commit_id=?',
      [this.partition, clientId, clientCommitId],
    );
    return record === undefined
      ? undefined
      : deserializePushResult(record.result);
  }

  async scanRows(query: RowScanQuery): Promise<StoredRow[]> {
    this.assertOpen();
    const firstVariable = assertScopeIndexedScan(query);
    const firstValues = query.scopeFilter[firstVariable] ?? [];
    if (firstValues.length === 0) return [];

    const pendingForTable = [...this.#pending.entries()].filter(([key]) =>
      key.startsWith(`${query.table}\u0000`),
    );
    const persistedLimit = query.limit + pendingForTable.length;
    const sql = scanRowPageSql(
      this.table(query.table),
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
          this.partition,
          query.table,
          firstVariable,
          JSON.stringify(firstValues),
          afterRowId,
          batchSize,
          this.partition,
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
      .sort((left, right) =>
        left.rowId < right.rowId ? -1 : left.rowId > right.rowId ? 1 : 0,
      )
      .slice(0, query.limit);
  }

  async scanRowsByIndex(query: IndexRowScanQuery): Promise<StoredRow[]> {
    this.assertOpen();
    const table = this.table(query.table);
    const index = resolveIndexRowScan(table, query);
    const pendingForTable = [...this.#pending.entries()].filter(([key]) =>
      key.startsWith(`${query.table}\u0000`),
    );
    const persistedLimit = query.limit + pendingForTable.length;
    const statement = indexRowPageStatement(
      table,
      index,
      query.values,
      this.partition,
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
      .sort((left, right) =>
        left.rowId < right.rowId ? -1 : left.rowId > right.rowId ? 1 : 0,
      )
      .slice(0, query.limit);
  }

  async queryAuthoritative(
    query: AuthoritativeQueryRequest,
  ): Promise<AuthoritativeQueryResult> {
    this.assertOpen();
    // D1 buffers writes until commit() and cannot overlay them on generated
    // SQL, so a read over a written table would return committed state
    // without this transaction's staged rows. Refuse it instead.
    for (const key of this.#pending.keys()) {
      if (query.tables.includes(key.slice(0, key.indexOf('\u0000')))) {
        throw new StorageQueryError('sync.storage.query_over_staged_writes');
      }
    }
    return queryAuthoritativeOn(
      this.#db,
      this.partition,
      this.#prepareQuery(query),
    );
  }

  async preparePushApply(
    clientId: string,
    clientCommitId: string,
    runningSchemaVersion: number,
    _targets: readonly {
      readonly table: string;
      readonly rowIds: readonly string[];
    }[] = [],
  ): Promise<PreparedPushApply> {
    this.assertOpen();
    if (!this.#pushApplySerialized) {
      throw new Error(
        'D1 push apply requires externally serialized partition writes',
      );
    }
    // D1 has no interactive lock. The caller explicitly asserted that every
    // write for this partition is already serialized (normally by its DO).
    this.#pushApplyCheckpoint = this.#buffer.length;
    return {
      gate: await this.readServeGate(runningSchemaVersion),
      persisted: await this.getPushResult(clientId, clientCommitId),
    };
  }

  advanceCheckpoint(
    _name: string,
    _ownerEpoch: number,
    _watermark: number,
    _observedRows: number,
    _nowMs: number,
  ): Promise<boolean> {
    // D1 installs no fence and declares no checkpoints in this release.
    return Promise.reject(
      new StorageQueryError('sync.storage.checkpoint_unsupported'),
    );
  }

  async readServeGate(_runningSchemaVersion: number): Promise<ServeGate> {
    this.assertOpen();
    const marker = await this.#db
      .prepare('SELECT schema_version FROM sync_schema_meta WHERE id=1')
      .first<{ schema_version: number }>();
    return {
      storedSchemaVersion: marker?.schema_version ?? 0,
      logEpoch: undefined,
      pending: [],
    };
  }

  async commitRejectedPushResult(
    clientId: string,
    clientCommitId: string,
    result: StoredPushResult,
  ): Promise<StoredPushResult> {
    this.assertOpen();
    const checkpoint = this.#pushApplyCheckpoint;
    if (checkpoint === undefined) {
      throw new Error('push rejection requires its apply checkpoint');
    }
    this.#buffer.length = checkpoint;
    this.#pending.clear();
    this.#clearedTombstones.clear();
    this.#maxCommitSeq = undefined;
    this.#applicationOpIndexes.clear();
    await this.putPushResult(clientId, clientCommitId, result);
    await this.commit();
    // The idempotency re-check found no record under the serialized apply, so
    // the insert above is the canonical outcome.
    return result;
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
        .bind(this.partition, ...bind, row.rowId)
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
    this.assertOpen();
    await this.#assertNoUniqueCollision(
      this.table(table),
      row,
      context?.opIndex,
    );
    if (context?.opIndex !== undefined) {
      this.#applicationOpIndexes.add(context.opIndex);
    }
    this.#pending.set(D1Transaction.#key(table, row.rowId), {
      kind: 'row',
      row,
    });
    this.writeRow(table, row);
  }

  override async deleteRow(table: string, rowId: string): Promise<void> {
    await super.deleteRow(table, rowId);
    this.#pending.set(D1Transaction.#key(table, rowId), { kind: 'deleted' });
  }

  protected async appendCommitRow(commit: NewCommit): Promise<number> {
    const p = this.partition;
    // Read the live counter once, then advance it in memory for this tx; the
    // increment is buffered and lands atomically at commit() (see header for
    // the concurrency posture).
    if (this.#maxCommitSeq === undefined) {
      const [row] = await this.all<{ max_commit_seq: number }>(
        'SELECT max_commit_seq FROM sync_partitions WHERE partition=?',
        [p],
      );
      this.#maxCommitSeq = row?.max_commit_seq ?? 0;
    }
    const commitSeq = this.#maxCommitSeq + 1;
    this.#maxCommitSeq = commitSeq;
    this.run(
      'INSERT INTO sync_partitions(partition, max_commit_seq) VALUES (?,?) ON CONFLICT(partition) DO UPDATE SET max_commit_seq=excluded.max_commit_seq',
      [p, commitSeq],
    );
    this.run(
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
    return commitSeq;
  }

  async commit(): Promise<void> {
    this.assertOpen();
    if (this.#buffer.length === 0) {
      this.open = false;
      return;
    }
    const statements = this.#buffer.map((entry) =>
      this.#db.prepare(entry.sql).bind(...entry.params),
    );
    // One atomic D1 batch — the §6.4 all-or-nothing commit.
    try {
      await this.#db.batch(statements);
      this.open = false;
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
    if (!this.open) return;
    this.open = false;
    this.#buffer.length = 0;
  }
}

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

/**
 * The core tables `D1ServerStorage` reads or writes outside schema migration.
 * `migrateSchema` creates them in its core phase, which runs only when the
 * version marker advances, so a same-version open refuses a database missing
 * one. `sync_backfill_checkpoints` and `sync_writer_fence` stay out: D1
 * declares no checkpoints and installs no fence.
 */
const D1_CORE_TABLES = [
  'sync_partitions',
  'sync_partition_registry',
  'sync_row_scopes',
  'sync_commits',
  'sync_changes',
  'sync_change_scopes',
  'sync_push_results',
  'sync_reactions',
  'sync_clients',
  'sync_blob_refs',
  'sync_tombstones',
] as const;

interface D1MigrationState {
  phase: 'core' | 'prepare' | 'ddl' | 'rewrite';
  offset: number;
  columns: Record<string, string[]>;
  indexes: Record<string, Record<string, string>>;
  ddl: string[];
  rewrites: Array<{ table: string; oldLayout?: readonly StoredColumnLayout[] }>;
  afterPartition: string;
  afterRowId: string;
}

interface D1MigrationClaim {
  target: string;
  source_layouts: string;
  state: string;
}

/** The reads queued for one `D1ServerStorage.guardedAll` round trip. */
interface PendingReads {
  readonly db: Pick<D1Database, 'prepare' | 'batch'>;
  readonly entries: {
    readonly statement: D1PreparedStatement;
    readonly resolve: (rows: unknown[]) => void;
    readonly reject: (error: unknown) => void;
  }[];
}

export class D1ServerStorage
  extends SqliteFamilyStorage
  implements ServerStorage
{
  readonly #db: D1Database;
  readonly #pushApplySerialized: boolean;
  /**
   * D1 caps bound parameters at 100 per statement; the relational upsert
   * binds one per app column plus the five `_sync_*` meta columns.
   */
  protected readonly maxBindParams = 100;
  /**
   * Page reads waiting for the end of the current microtask turn. A pull
   * starts the window read (or first snapshot page) of every subscription
   * before awaiting any of them, so they leave as ONE `db.batch` round trip
   * instead of one per subscription (SYNCULAR-PULL-ROUNDTRIPS-001).
   */
  #pendingReads: PendingReads | undefined;

  constructor(db: D1Database, options: D1ServerStorageOptions = {}) {
    super();
    this.#db = db;
    this.#pushApplySerialized =
      options.pushApplySerialized === true ||
      options.commitValidationSerialized === true;
  }

  protected async all<T>(
    sql: string,
    params: readonly SqliteValue[],
  ): Promise<T[]> {
    return (
      await this.#db
        .prepare(sql)
        .bind(...params)
        .all<T>()
    ).results;
  }

  /** Queue one read into the current turn's `db.batch` (see `#pendingReads`). */
  protected guardedAll<T>(
    sql: string,
    params: readonly SqliteValue[],
  ): Promise<T[]> {
    let pending = this.#pendingReads;
    if (pending === undefined) {
      const created: PendingReads = {
        db: this.#schemaDatabase(),
        entries: [],
      };
      pending = created;
      this.#pendingReads = created;
      queueMicrotask(() => {
        this.#pendingReads = undefined;
        created.db.batch(created.entries.map((entry) => entry.statement)).then(
          (results) => {
            created.entries.forEach((entry, i) => {
              try {
                entry.resolve(batchRows(results[i]));
              } catch (error) {
                entry.reject(error);
              }
            });
          },
          (error: unknown) => {
            for (const entry of created.entries) entry.reject(error);
          },
        );
      });
    }
    const target = pending;
    const statement = target.db.prepare(sql).bind(...params);
    return new Promise<T[]>((resolve, reject) => {
      target.entries.push({
        statement,
        resolve: (rows) => resolve(rows as T[]),
        reject,
      });
    });
  }

  protected async atomic(
    statements: readonly SqliteStatementSpec[],
  ): Promise<unknown[][]> {
    const results = await this.#db.batch(
      statements.map(({ sql, params }) =>
        this.#db.prepare(sql).bind(...params),
      ),
    );
    return results.map(batchRows);
  }

  /** Apply the schema DDL (idempotent). Call once before use. */
  async migrate(): Promise<void> {
    for (const statement of sqliteDdlStatements()) {
      await this.#db.exec(`${statement.replace(/\s+/g, ' ')};`);
    }
    const { results } = await this.#db
      .prepare('PRAGMA table_info("sync_clients")')
      .all<{ name: string }>();
    if (!results.some((column) => column.name === 'wire_version')) {
      await this.#db.exec(
        'ALTER TABLE sync_clients ADD COLUMN wire_version INTEGER NOT NULL DEFAULT 1;',
      );
    }
    for (const [name, definition] of Object.entries(
      SYNC_CLIENT_ROUND_COLUMNS,
    )) {
      if (!results.some((column) => column.name === name)) {
        await this.#db.exec(
          `ALTER TABLE sync_clients ADD COLUMN ${name} ${definition};`,
        );
      }
    }
  }

  async ensureSchema(
    schema: CompiledSchema,
    checkpoints?: readonly CheckpointDeclaration[],
  ): Promise<void> {
    if (checkpoints !== undefined && checkpoints.length > 0) {
      // No database-side fence can be installed atomically with schema
      // visibility here; refuse instead of accepting a weaker guarantee.
      throw new StorageQueryError('sync.storage.checkpoint_unsupported');
    }
    if (this.schemaVersion === schema.version) {
      await this.#schemaDatabase().batch([]);
      return;
    }
    if (!(await this.migrateSchema(schema)).complete) {
      throw new StorageQueryError('sync.storage.schema_migration_pending');
    }
  }

  /** Run once per Worker invocation. Resume an incomplete result in another invocation. */
  async migrateSchema(
    schema: CompiledSchema,
    options: { readonly maxStatements?: number } = {},
  ): Promise<{
    readonly complete: boolean;
    readonly statementsExecuted: number;
  }> {
    const maxStatements = options.maxStatements ?? 50;
    if (
      !Number.isInteger(maxStatements) ||
      maxStatements < 10 ||
      maxStatements > 1000
    ) {
      throw new StorageQueryError('sync.storage.invalid_migration_budget');
    }
    const tables = [...schema.tables.values()].sort((a, b) =>
      a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
    );
    for (const table of tables) {
      if (tableColumnNames(table).length > this.maxBindParams) {
        throw new Error('D1 caps statements at 100 bound parameters');
      }
    }
    const target = JSON.stringify({
      version: schema.version,
      tables: tables.map((table) => ({
        name: table.name,
        columns: table.columns,
        primaryKeyIndex: table.primaryKeyIndex,
        materialize: table.materialize,
        indexes: table.indexes,
        scopes: table.scopePatterns,
      })),
    });
    let statementsExecuted = 0;
    const read = async <T>(
      statement: D1PreparedStatement,
    ): Promise<T | null> => {
      statementsExecuted++;
      return statement.first<T>();
    };
    const batch = async (
      statements: D1PreparedStatement[],
    ): Promise<unknown[]> => {
      statementsExecuted += statements.length;
      return this.#db.batch(statements);
    };
    await batch([
      this.#db.prepare(SCHEMA_META_DDL_SQLITE),
      this.#db.prepare(`CREATE TABLE IF NOT EXISTS sync_schema_migration(
  id INTEGER PRIMARY KEY CHECK(id=1),
  target TEXT NOT NULL,
  source_layouts TEXT NOT NULL,
  state TEXT NOT NULL
)`),
    ]);
    const marker = await read<{ schema_version: number; layouts: string }>(
      this.#db.prepare(
        'SELECT schema_version, layouts FROM sync_schema_meta WHERE id=1',
      ),
    );
    let claim = await read<D1MigrationClaim>(
      this.#db.prepare('SELECT * FROM sync_schema_migration WHERE id=1'),
    );
    if (claim === null && marker?.schema_version === schema.version) {
      assertStoredLayouts(schema, marker.layouts);
      statementsExecuted++;
      const present = await this.#db
        .prepare(
          `SELECT name FROM sqlite_master WHERE type='table' AND name IN (${placeholders(D1_CORE_TABLES.length)})`,
        )
        .bind(...D1_CORE_TABLES)
        .all<{ name: string }>();
      const presentNames = new Set(present.results.map((row) => row.name));
      for (const name of D1_CORE_TABLES) {
        if (!presentNames.has(name)) {
          throw new StorageQueryError('sync.storage.physical_layout_mismatch', {
            table: name,
            reason: 'missing_table',
          });
        }
      }
      for (const table of tables) {
        statementsExecuted++;
        const { results } = await this.#db
          .prepare(`PRAGMA table_info(${quoteIdent(table.name)})`)
          .all<{ name: string; type: string; notnull: number; pk: number }>();
        assertPhysicalColumns(
          table,
          results.map((column) => ({
            name: column.name,
            type: column.type,
            notNull: column.notnull === 1,
            primaryKeyPosition: column.pk,
          })),
          'sqlite',
        );
      }
      // A database from before the round-state columns gains them in place.
      statementsExecuted++;
      const clientColumns = await this.#db
        .prepare('PRAGMA table_info("sync_clients")')
        .all<{ name: string }>();
      const missingRoundColumns = Object.entries(
        SYNC_CLIENT_ROUND_COLUMNS,
      ).filter(
        ([name]) =>
          !clientColumns.results.some((column) => column.name === name),
      );
      if (missingRoundColumns.length > 0) {
        await batch(
          missingRoundColumns.map(([name, definition]) =>
            this.#db.prepare(
              `ALTER TABLE sync_clients ADD COLUMN ${name} ${definition}`,
            ),
          ),
        );
      }
      // Server-only indexes reconcile at every open of a database already at
      // this version: they never reach a client, so no version bump is needed.
      const indexes = new Map<string, ReadonlyMap<string, string>>();
      for (const table of tables) {
        statementsExecuted++;
        const { results } = await this.#db
          .prepare(SQLITE_TABLE_INDEXES_SQL)
          .bind(table.name)
          .all<SqliteTableIndexRow>();
        indexes.set(
          table.name,
          new Map(Object.entries(sqliteIndexSignatures(results))),
        );
      }
      const reconcile = serverIndexDdl(schema, indexes);
      if (reconcile.length > 0) {
        await batch(reconcile.map((sql) => this.#db.prepare(sql)));
      }
      this.tables = schema.tables;
      this.schemaVersion = schema.version;
      return { complete: true, statementsExecuted };
    }
    if (marker !== null && marker.schema_version > schema.version) {
      throw new StorageQueryError('sync.storage.schema_changed');
    }
    if (claim === null) {
      const layouts = parseLayouts(marker?.layouts);
      for (const table of tables) {
        const oldLayout = layouts[table.name];
        if (oldLayout !== undefined) {
          assertAppendOnlyMigration(table.name, oldLayout, table);
        }
      }
      const state: D1MigrationState = {
        phase: 'core',
        offset: 0,
        columns: {},
        indexes: {},
        rewrites: [],
        ddl: [],
        afterPartition: '',
        afterRowId: '',
      };
      // Claim the database before inspecting projection layouts. The marker
      // comparison prevents a delayed caller from planning against an old schema.
      try {
        await batch([
          this.#db
            .prepare(`INSERT INTO sync_schema_migration
          SELECT 2, '', '', '' WHERE EXISTS (SELECT 1 FROM sync_schema_meta
            WHERE id=1 AND schema_version<>?) OR (?=0 AND EXISTS (SELECT 1 FROM sync_schema_meta WHERE id=1))`)
            .bind(marker?.schema_version ?? 0, marker === null ? 0 : 1),
          this.#db
            .prepare(`INSERT OR IGNORE INTO sync_schema_migration
          (id, target, source_layouts, state) VALUES (1,?,?,?)`)
            .bind(target, marker?.layouts ?? '{}', JSON.stringify(state)),
        ]);
      } catch (error) {
        const current = await read<{ schema_version: number }>(
          this.#db.prepare(
            'SELECT schema_version FROM sync_schema_meta WHERE id=1',
          ),
        );
        if (current?.schema_version !== marker?.schema_version)
          return { complete: false, statementsExecuted };
        throw error;
      }
      claim = await read<D1MigrationClaim>(
        this.#db.prepare('SELECT * FROM sync_schema_migration WHERE id=1'),
      );
    }
    if (claim === null || claim.target !== target) {
      throw new StorageQueryError('sync.storage.schema_migration_conflict');
    }
    const sourceLayouts = parseLayouts(claim.source_layouts);
    let state = JSON.parse(claim.state) as D1MigrationState;
    // Reserve one statement to distinguish a stale checkpoint from a database
    // failure. A losing concurrent step returns incomplete without retrying here.
    const save = async (
      next: D1MigrationState,
      statements: D1PreparedStatement[],
      publish = false,
    ): Promise<boolean> => {
      const prior = claim.state;
      const encoded = JSON.stringify(next);
      try {
        await batch([
          this.#db
            .prepare(`INSERT INTO sync_schema_migration
            SELECT 2, '', '', '' WHERE NOT EXISTS (
              SELECT 1 FROM sync_schema_migration WHERE id=1 AND target=? AND state=?)`)
            .bind(target, prior),
          ...statements,
          publish
            ? this.#db.prepare('DELETE FROM sync_schema_migration WHERE id=1')
            : this.#db
                .prepare('UPDATE sync_schema_migration SET state=? WHERE id=1')
                .bind(encoded),
        ]);
      } catch (error) {
        const current = await read<D1MigrationClaim>(
          this.#db.prepare('SELECT * FROM sync_schema_migration WHERE id=1'),
        );
        if (
          current === null ||
          (current.target === target && current.state !== prior)
        )
          return false;
        throw error;
      }
      claim.state = encoded;
      state = next;
      return true;
    };
    while (maxStatements - statementsExecuted >= 4) {
      const remaining = maxStatements - statementsExecuted - 1;
      if (state.phase === 'core') {
        const ddl = sqliteDdlStatements();
        const count = Math.min(ddl.length - state.offset, remaining - 2);
        if (count > 0) {
          const statements = ddl
            .slice(state.offset, state.offset + count)
            .map((sql) => this.#db.prepare(sql));
          if (
            !(await save(
              { ...state, offset: state.offset + count },
              statements,
            ))
          )
            break;
          continue;
        }
        if (remaining < 4) break;
        statementsExecuted++;
        const columns = await this.#db
          .prepare('PRAGMA table_info("sync_clients")')
          .all<{ name: string }>();
        const missingColumns = Object.entries({
          wire_version: 'INTEGER NOT NULL DEFAULT 1',
          ...SYNC_CLIENT_ROUND_COLUMNS,
        }).filter(
          ([name]) => !columns.results.some((column) => column.name === name),
        );
        if (
          !(await save(
            { ...state, phase: 'prepare', offset: 0 },
            missingColumns.map(([name, definition]) =>
              this.#db.prepare(
                `ALTER TABLE sync_clients ADD COLUMN ${name} ${definition}`,
              ),
            ),
          ))
        )
          break;
      } else if (state.phase === 'prepare') {
        const table = tables[state.offset];
        if (table !== undefined) {
          if (remaining < 4) break;
          statementsExecuted += 2;
          const columns = await this.#db
            .prepare(`PRAGMA table_info(${quoteIdent(table.name)})`)
            .all<{ name: string }>();
          const indexes = await this.#db
            .prepare(SQLITE_TABLE_INDEXES_SQL)
            .bind(table.name)
            .all<SqliteTableIndexRow>();
          // Validate the old codec before any application DDL or row rewrite.
          rewritePlan(
            table,
            sourceLayouts[table.name],
            columns.results.length > 0
              ? new Set(columns.results.map((column) => column.name))
              : undefined,
          );
          if (
            !(await save(
              {
                ...state,
                offset: state.offset + 1,
                columns: {
                  ...state.columns,
                  ...(columns.results.length > 0
                    ? {
                        [table.name]: columns.results.map(
                          (column) => column.name,
                        ),
                      }
                    : {}),
                },
                indexes: {
                  ...state.indexes,
                  [table.name]: sqliteIndexSignatures(indexes.results),
                },
              },
              [],
            ))
          )
            break;
          continue;
        }
        const columns = new Map(
          Object.entries(state.columns).map(([name, names]) => [
            name,
            new Set(names),
          ]),
        );
        const indexes = new Map(
          Object.entries(state.indexes).map(([name, signatures]) => [
            name,
            new Map(Object.entries(signatures)),
          ]),
        );
        const rewrites = tables.flatMap((table) => {
          const plan = rewritePlan(
            table,
            sourceLayouts[table.name],
            columns.get(table.name),
          );
          return plan.migrate || plan.backfill
            ? [
                {
                  table: table.name,
                  ...(plan.migrate
                    ? { oldLayout: sourceLayouts[table.name] }
                    : {}),
                },
              ]
            : [];
        });
        const ddl = [
          ...retiredTableNames(schema, sourceLayouts).flatMap((name) => [
            `DELETE FROM sync_row_scopes WHERE tbl='${name.replaceAll("'", "''")}'`,
            `DELETE FROM sync_blob_refs WHERE tbl='${name.replaceAll("'", "''")}'`,
            dropTableDdl(name),
          ]),
          ...schemaDdl(schema, columns, 'sqlite', indexes),
        ];
        if (
          !(await save(
            {
              ...state,
              phase: 'ddl',
              offset: 0,
              ddl,
              rewrites,
              columns: {},
              indexes: {},
            },
            [],
          ))
        )
          break;
      } else if (state.phase === 'ddl') {
        const count = Math.min(state.ddl.length - state.offset, remaining - 2);
        if (count === 0) {
          if (
            !(await save(
              { ...state, phase: 'rewrite', offset: 0, ddl: [] },
              [],
            ))
          )
            break;
        } else if (
          !(await save(
            { ...state, offset: state.offset + count },
            state.ddl
              .slice(state.offset, state.offset + count)
              .map((sql) => this.#db.prepare(sql)),
          ))
        )
          break;
      } else {
        const plan = state.rewrites[state.offset];
        if (plan === undefined) {
          if (
            !(await save(
              state,
              [
                this.#db
                  .prepare(`INSERT INTO sync_schema_meta(id, schema_version, layouts) VALUES (1,?,?)
            ON CONFLICT(id) DO UPDATE SET schema_version=excluded.schema_version, layouts=excluded.layouts`)
                  .bind(schema.version, layoutsOf(schema)),
              ],
              true,
            ))
          )
            break;
          this.tables = schema.tables;
          this.schemaVersion = schema.version;
          return { complete: true, statementsExecuted };
        }
        const table = schema.tables.get(plan.table);
        if (table === undefined)
          throw new StorageQueryError('sync.storage.schema_migration_conflict');
        if (remaining < 4) break;
        const limit = Math.min(32, remaining - 3);
        statementsExecuted++;
        const { results } = await this.#db
          .prepare(`SELECT * FROM (${selectRowsForRewriteSql(table, 'sqlite')})
            WHERE EXISTS (SELECT 1 FROM sync_schema_migration WHERE id=1 AND target=? AND state=?)`)
          .bind(
            state.afterPartition,
            state.afterRowId,
            limit,
            target,
            claim.state,
          )
          .all<{ partition: string; row_id: string; payload: unknown }>();
        const statements = results.map((row) => {
          const bytes = asUint8Array(row.payload);
          const payload =
            plan.oldLayout !== undefined
              ? migratePayload(plan.oldLayout, table, bytes)
              : bytes;
          return this.#db
            .prepare(rewriteRowSql(table))
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
        const last = results.at(-1);
        const done = results.length < limit;
        if (
          !(await save(
            {
              ...state,
              offset: state.offset + (done ? 1 : 0),
              afterPartition: done ? '' : last!.partition,
              afterRowId: done ? '' : last!.row_id,
            },
            statements,
          ))
        )
          break;
      }
    }
    return { complete: false, statementsExecuted };
  }

  /** Every protected read or write shares a transaction with its schema check. */
  #schemaDatabase(): Pick<D1Database, 'prepare' | 'batch'> {
    if (this.schemaVersion === undefined)
      throw new StorageQueryError('sync.storage.schema_changed');
    const db = this.#db;
    const version = this.schemaVersion;
    const sources = new WeakMap<D1PreparedStatement, D1PreparedStatement>();
    const execute = async (
      statements: D1PreparedStatement[],
    ): Promise<unknown[]> => {
      try {
        const results = await db.batch([
          db
            .prepare(`INSERT INTO sync_schema_migration SELECT 2, '', '', ''
            WHERE EXISTS (SELECT 1 FROM sync_schema_migration WHERE id=1)
              OR NOT EXISTS (SELECT 1 FROM sync_schema_meta WHERE id=1 AND schema_version=?)`)
            .bind(version),
          ...statements,
        ]);
        return results.slice(1);
      } catch (error) {
        const migration = await db
          .prepare('SELECT id FROM sync_schema_migration WHERE id=1')
          .first();
        if (migration !== null)
          throw new StorageQueryError('sync.storage.schema_migration_pending');
        const marker = await db
          .prepare('SELECT schema_version FROM sync_schema_meta WHERE id=1')
          .first<{ schema_version: number }>();
        if (marker?.schema_version !== version)
          throw new StorageQueryError('sync.storage.schema_changed');
        throw error;
      }
    };
    const prepare = (
      sql: string,
      params: unknown[] = [],
    ): D1PreparedStatement => {
      const source = db.prepare(sql).bind(...params);
      const all = async <T>(): Promise<{ results: T[] }> => {
        return {
          results: batchRows((await execute([source]))[0]) as T[],
        };
      };
      const statement: D1PreparedStatement = {
        bind: (...values) => prepare(sql, values),
        all,
        first: async <T>() => (await all<T>()).results[0] ?? null,
        run: async () => (await execute([source]))[0],
      };
      sources.set(statement, source);
      return statement;
    };
    return {
      prepare,
      batch: (statements) =>
        execute(
          statements.map((statement) => {
            const source = sources.get(statement);
            if (source === undefined)
              throw new Error('D1 batch contains a foreign statement');
            return source;
          }),
        ),
    };
  }

  async begin(partition: string): Promise<StorageTransaction> {
    const tables = this.tables;
    const db = this.#schemaDatabase();
    return new D1Transaction(
      db,
      partition,
      (name) => {
        const table = tables?.get(name);
        if (table === undefined)
          throw new StorageQueryError('sync.storage.schema_changed');
        return table;
      },
      (query) => this.prepareAuthoritativeQuery(partition, query),
      this.#pushApplySerialized,
    );
  }

  async queryAuthoritative(
    partition: string,
    query: AuthoritativeQueryRequest,
    _checkpoints?: readonly CheckpointDeclaration[],
  ): Promise<AuthoritativeQueryResult> {
    // D1 declares no checkpoints. `#schemaDatabase` prepends a guard that
    // re-checks the published marker inside this same batch, so condition 2
    // is already evaluated with the query (§2.4 D1 schema readiness).
    const db = this.#schemaDatabase();
    return queryAuthoritativeOn(
      db,
      partition,
      this.prepareAuthoritativeQuery(partition, query),
    );
  }

  override async pruneCommitsThrough(
    partition: string,
    query: CommitPruneQuery,
  ): Promise<CommitPruneResult> {
    if (!this.#pushApplySerialized)
      throw new Error(
        'D1 pruning requires externally serialized partition writes',
      );
    return super.pruneCommitsThrough(partition, query);
  }

  async readCheckpoints(_partition: string): Promise<StoredCheckpoint[]> {
    // D1 supports no declared backfill checkpoints in this release: migrations
    // run out of band and no database-side fence can be installed atomically
    // with schema visibility. No checkpoint row can exist.
    return [];
  }

  async readServeGate(
    partition: string,
    _runningSchemaVersion: number,
  ): Promise<ServeGate> {
    // D1 has no checkpoints. The published marker is the only gate input;
    // `#schemaDatabase` already re-checks it per protected batch.
    const marker = await this.#db
      .prepare('SELECT schema_version FROM sync_schema_meta WHERE id=1')
      .first<{ schema_version: number }>();
    return {
      storedSchemaVersion: marker?.schema_version ?? 0,
      logEpoch: await this.getPartitionLogEpoch(partition),
      pending: [],
    };
  }

  async declareCheckpoint(
    _partition: string,
    _name: string,
    _schemaVersion: number,
    _nowMs: number,
  ): Promise<StoredCheckpoint> {
    throw new StorageQueryError('sync.storage.checkpoint_unsupported');
  }

  async activateCheckpoint(
    _partition: string,
    _name: string,
    _ownerEpoch: number,
    _watermark: number,
    _sources: readonly string[],
    _nowMs: number,
  ): Promise<'activated' | 'stale' | 'unverifiable'> {
    throw new StorageQueryError('sync.storage.checkpoint_unsupported');
  }

  async claimCheckpoint(
    _partition: string,
    _name: string,
    _schemaVersion: number,
    _nowMs: number,
  ): Promise<StoredCheckpoint> {
    throw new StorageQueryError('sync.storage.checkpoint_unsupported');
  }

  async advanceCheckpoint(
    _partition: string,
    _name: string,
    _ownerEpoch: number,
    _watermark: number,
    _observedRows: number,
    _nowMs: number,
  ): Promise<boolean> {
    throw new StorageQueryError('sync.storage.checkpoint_unsupported');
  }

  override async eraseScopeValueHistory(
    partition: string,
    query: ScopeValueHistoryQuery,
  ): Promise<number> {
    if (!this.#pushApplySerialized)
      throw new Error(
        'D1 erasure requires externally serialized partition writes',
      );
    return super.eraseScopeValueHistory(partition, query);
  }
}
