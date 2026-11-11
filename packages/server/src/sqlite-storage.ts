/**
 * SQLite server storage over the shared synchronous driver. The statements
 * it shares with D1 live in `SqliteFamilyStorage` (`sqlite-dialect.ts`);
 * this class adds the request lock, interactive `BEGIN IMMEDIATE`
 * transactions, in-place schema migration and backfill checkpoints.
 *
 * Scope fanout is index-first: both the commit log and the
 * current-row table carry a (table, variable, value) inverted index; reads
 * select candidates from the index and verify the full multi-variable
 * match against the stored scope map — never a log scan.
 */
import {
  isSqliteConstraintError,
  retainRollbackFailure,
  rollbackAfterError,
  StorageConstraintError,
  StorageQueryError,
} from './storage-errors';
import { serveGateRefusal } from './storage';
import { serveNotReadyError } from './readiness';
import {
  assertPhysicalColumns,
  assertStoredLayouts,
  dropTableDdl,
  layoutsOf,
  migratePayload,
  parseLayouts,
  retiredTableNames,
  rewritePlan,
  rewriteRowSql,
  rewriteValues,
  SCHEMA_META_DDL_SQLITE,
  type StoredColumnLayout,
  schemaDdl,
  serverIndexDdl,
  SQLITE_TABLE_INDEXES_SQL,
  type SqliteTableIndexRow,
  sqliteIndexSignatures,
  selectRowsForRewriteSql,
} from './relational-rows';
import type { CompiledSchema, CompiledTable } from './schema';
import {
  SQLITE_DDL,
  SQLITE_UPGRADE_PROBE,
  SqliteFamilyStorage,
  SqliteFamilyTransaction,
  type SqliteStatementSpec,
  sqliteUpgradeDdl,
} from './sqlite-dialect';
import {
  SqliteAdapterRequiredError,
  type SqliteDatabase,
  type SqliteValue,
} from './sqlite-driver';
import type {
  AuthoritativeQueryRequest,
  AuthoritativeQueryResult,
  AuthoritativeQueryValue,
  CheckpointDeclaration,
  IndexRowScanQuery,
  NewCommit,
  OutboxSequence,
  OutboxSettlement,
  PreparedPushApply,
  RowScanQuery,
  ServerStorage,
  ServeGate,
  StorageTransaction,
  StoredCheckpoint,
  StoredPushResult,
  StoredRow,
} from './storage';

interface SqliteCheckpointRecord {
  partition: string;
  name: string;
  schema_version: number;
  state: StoredCheckpoint['state'];
  watermark: number;
  owner_epoch: number;
  observed_rows: number;
  updated_at_ms: number;
}

function toStoredCheckpoint(record: SqliteCheckpointRecord): StoredCheckpoint {
  return {
    partition: record.partition,
    name: record.name,
    schemaVersion: record.schema_version,
    state: record.state,
    watermark: record.watermark,
    ownerEpoch: record.owner_epoch,
    observedRows: record.observed_rows,
    updatedAtMs: record.updated_at_ms,
  };
}

class SqliteTransaction
  extends SqliteFamilyTransaction
  implements StorageTransaction
{
  #storage: SqliteServerStorage;
  /** Schema version this transaction writes; rides every appended commit row. */
  #writerVersion: number;
  #pushApplySavepoint = false;
  readonly #release: () => void;

  constructor(
    storage: SqliteServerStorage,
    partition: string,
    writerVersion: number,
    release: () => void,
  ) {
    super(partition);
    this.#storage = storage;
    this.#writerVersion = writerVersion;
    this.#release = release;
    storage.db.exec('BEGIN IMMEDIATE');
  }

  protected run(sql: string, params: readonly SqliteValue[]): void {
    this.#storage.db.run(sql, params);
  }

  protected async all<T>(
    sql: string,
    params: readonly SqliteValue[],
  ): Promise<T[]> {
    return this.#storage.db.query<T, SqliteValue[]>(sql).all(...params);
  }

  protected table(name: string): CompiledTable {
    return this.#storage.table(name);
  }

  getRow(table: string, rowId: string): Promise<StoredRow | undefined> {
    this.assertOpen();
    return this.#storage.getRow(this.partition, table, rowId);
  }

  scanRows(query: RowScanQuery): Promise<StoredRow[]> {
    this.assertOpen();
    return this.#storage.scanRows(this.partition, query);
  }

  scanRowsByIndex(query: IndexRowScanQuery): Promise<StoredRow[]> {
    this.assertOpen();
    return this.#storage.scanRowsByIndex(this.partition, query);
  }

  async queryAuthoritative(
    query: AuthoritativeQueryRequest,
  ): Promise<AuthoritativeQueryResult> {
    this.assertOpen();
    // Same shared connection: the query runs inside this transaction's
    // BEGIN IMMEDIATE and observes every row staged so far.
    return this.#storage.runAuthoritativeQuery(this.partition, query);
  }

  async preparePushApply(
    clientId: string,
    clientCommitId: string,
    runningSchemaVersion: number,
    _targets: readonly {
      readonly table: string;
      readonly rowIds: readonly string[];
    }[] = [],
    outbox?: OutboxSettlement,
  ): Promise<PreparedPushApply> {
    this.assertOpen();
    // BEGIN IMMEDIATE in the constructor already owns SQLite's writer lock.
    // The settlement precedes the savepoint, so a rejection keeps it.
    const settled =
      outbox === undefined
        ? undefined
        : await this.settleOutbox(clientId, clientCommitId, outbox);
    this.#storage.db.exec('SAVEPOINT syncular_push_candidate');
    this.#pushApplySavepoint = true;
    const gate = await this.#storage.readServeGate(
      this.partition,
      runningSchemaVersion,
    );
    return settled === undefined
      ? {
          gate,
          persisted: await this.#storage.getPushResult(
            this.partition,
            clientId,
            clientCommitId,
          ),
        }
      : { gate, ...settled };
  }

  async lockPartition(): Promise<void> {
    this.assertOpen();
    // BEGIN IMMEDIATE in the constructor already owns SQLite's writer lock.
  }

  async advanceCheckpoint(
    name: string,
    ownerEpoch: number,
    watermark: number,
    observedRows: number,
    nowMs: number,
  ): Promise<boolean> {
    this.assertOpen();
    const result = this.#storage.db
      .query(
        `UPDATE sync_backfill_checkpoints
            SET watermark=?, observed_rows=?, updated_at_ms=?
          WHERE partition=? AND name=? AND owner_epoch=?`,
      )
      .run(watermark, observedRows, nowMs, this.partition, name, ownerEpoch);
    return Number(result.changes) === 1;
  }

  readServeGate(runningSchemaVersion: number): Promise<ServeGate> {
    this.assertOpen();
    // Same shared connection: this read runs inside this transaction's
    // BEGIN IMMEDIATE, so the gate and the write share one transaction.
    return this.#storage.readServeGate(this.partition, runningSchemaVersion);
  }

  async commitRejectedPushResult(
    clientId: string,
    clientCommitId: string,
    result: StoredPushResult,
    sequence?: OutboxSequence,
  ): Promise<StoredPushResult> {
    this.assertOpen();
    if (!this.#pushApplySavepoint) {
      throw new Error('push rejection requires its apply savepoint');
    }
    this.#storage.db.exec('ROLLBACK TO SAVEPOINT syncular_push_candidate');
    this.#storage.db.exec('RELEASE SAVEPOINT syncular_push_candidate');
    this.#pushApplySavepoint = false;
    await this.putPushResult(clientId, clientCommitId, result, sequence);
    await this.commit();
    // The idempotency re-check found no record under the writer lock, so the
    // insert above is the canonical outcome.
    return result;
  }

  async upsertRow(
    table: string,
    row: StoredRow,
    context?: { readonly opIndex: number },
  ): Promise<void> {
    this.assertOpen();
    try {
      this.writeRow(table, row);
    } catch (error) {
      if (isSqliteConstraintError(error)) {
        throw new StorageConstraintError(error, context?.opIndex);
      }
      throw error;
    }
  }

  protected async appendCommitRow(commit: NewCommit): Promise<number> {
    const p = this.partition;
    this.run('INSERT OR IGNORE INTO sync_partitions(partition) VALUES (?)', [
      p,
    ]);
    const [row] = await this.all<{ max_commit_seq: number }>(
      'SELECT max_commit_seq FROM sync_partitions WHERE partition=?',
      [p],
    );
    const commitSeq = (row?.max_commit_seq ?? 0) + 1;
    this.run('UPDATE sync_partitions SET max_commit_seq=? WHERE partition=?', [
      commitSeq,
      p,
    ]);
    this.run(
      'INSERT INTO sync_commits(partition, commit_seq, client_id, client_commit_id, actor_id, created_at_ms, writer_version) VALUES (?,?,?,?,?,?,?)',
      [
        p,
        commitSeq,
        commit.clientId,
        commit.clientCommitId,
        commit.actorId,
        commit.createdAtMs,
        this.#writerVersion,
      ],
    );
    return commitSeq;
  }

  async commit(): Promise<void> {
    this.assertOpen();
    try {
      this.#storage.db.exec('COMMIT');
    } catch (error) {
      // A failed COMMIT (SQLITE_BUSY from an external writer, I/O error)
      // leaves the connection inside BEGIN IMMEDIATE. Roll back before the
      // FIFO releases, so the next queued transaction starts on a clean
      // connection.
      try {
        this.#storage.db.exec('ROLLBACK');
      } catch (rollbackError) {
        retainRollbackFailure(error, rollbackError);
      }
      throw error;
    } finally {
      this.open = false;
      this.#release();
    }
  }

  async rollback(): Promise<void> {
    if (!this.open) return;
    this.open = false;
    try {
      this.#storage.db.exec('ROLLBACK');
    } finally {
      this.#release();
    }
  }
}

export class SqliteServerStorage
  extends SqliteFamilyStorage
  implements ServerStorage
{
  readonly db: SqliteDatabase;
  protected readonly maxBindParams = Number.POSITIVE_INFINITY;
  /**
   * §6.4: one SQLite connection serves one caller at a time. A transaction
   * holds it from `begin` until commit or rollback; every other call waits
   * behind it in FIFO order, so no request reads another's uncommitted rows
   * and no write joins another's open transaction. A call on an idle
   * connection takes it synchronously and runs at call time.
   */
  #busy = false;
  readonly #waiters: (() => void)[] = [];

  /** `undefined` when the caller owns the connection now. */
  #acquire(): Promise<void> | undefined {
    if (!this.#busy) {
      this.#busy = true;
      return undefined;
    }
    return new Promise<void>((resolve) => {
      this.#waiters.push(resolve);
    });
  }

  /** Hand the connection to the next waiter, or mark it idle. */
  #release(): void {
    const next = this.#waiters.shift();
    if (next === undefined) this.#busy = false;
    else next();
  }

  constructor(db: SqliteDatabase | string = ':memory:') {
    if (typeof db === 'string') {
      throw new SqliteAdapterRequiredError();
    }
    super();
    this.db = db;
    this.db.exec(SQLITE_DDL);
    for (const statement of sqliteUpgradeDdl(
      this.db
        .query<{ tbl: string; name: string }, SqliteValue[]>(
          SQLITE_UPGRADE_PROBE.sql,
        )
        .all(...SQLITE_UPGRADE_PROBE.params),
    )) {
      this.db.exec(statement);
    }
    const commitColumns = this.db
      .query<{ name: string }, []>('PRAGMA table_info("sync_commits")')
      .all();
    if (!commitColumns.some((column) => column.name === 'writer_version')) {
      // Nullable by design: an old writer omits the column and the trigger's
      // explicit NULL test rejects it. `ADD COLUMN NOT NULL` is unavailable in
      // SQLite, and a default would hand old writers a passing value.
      this.db.exec(
        'ALTER TABLE sync_commits ADD COLUMN writer_version INTEGER',
      );
    }
    // The fence is database-side: an old binary's INSERT never reaches JS. An
    // absent `sync_writer_fence` row makes the WHEN clause false, so a
    // partition with no barrier behaves exactly as before.
    this.db.exec(`CREATE TRIGGER IF NOT EXISTS sync_commits_writer_fence
BEFORE INSERT ON sync_commits
FOR EACH ROW
WHEN EXISTS (
  SELECT 1 FROM sync_writer_fence
   WHERE partition = NEW.partition
     AND (NEW.writer_version IS NULL
          OR NEW.writer_version < required_writer_version)
)
BEGIN
  SELECT RAISE(ABORT, 'sync.storage.writer_fence_rejected');
END`);
    // Callers receive this proxy: every method except the ones below runs
    // under `#acquire`. Methods execute against the raw instance, so a
    // transaction (constructed with the raw instance) and a method's own
    // internal calls never queue behind themselves.
    return new Proxy(this, {
      get: (target, property) => {
        const value: unknown = Reflect.get(target, property, target);
        // An own property is a caller's override (a test double or host
        // wrapper); it reaches the queue through the original it calls.
        if (typeof value !== 'function' || Object.hasOwn(target, property)) {
          return value;
        }
        if (
          property === 'begin' ||
          property === 'table' ||
          property === 'runAuthoritativeQuery' ||
          property === 'constructor'
        ) {
          return value.bind(target);
        }
        return (...args: unknown[]): Promise<unknown> => {
          const run = async () => {
            try {
              return await Reflect.apply(value, target, args);
            } finally {
              target.#release();
            }
          };
          return target.#acquire()?.then(run) ?? run();
        };
      },
    });
  }

  protected async all<T>(
    sql: string,
    params: readonly SqliteValue[],
  ): Promise<T[]> {
    return this.db.query<T, SqliteValue[]>(sql).all(...params);
  }

  protected guardedAll<T>(
    sql: string,
    params: readonly SqliteValue[],
  ): Promise<T[]> {
    return this.all<T>(sql, params);
  }

  protected async atomic(
    statements: readonly SqliteStatementSpec[],
  ): Promise<unknown[][]> {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const results = statements.map(({ sql, params }) =>
        this.db.query<unknown, SqliteValue[]>(sql).all(...params),
      );
      this.db.exec('COMMIT');
      return results;
    } catch (error) {
      rollbackAfterError(() => {
        this.db.exec('ROLLBACK');
      }, error);
    }
  }

  async ensureSchema(
    schema: CompiledSchema,
    checkpoints?: readonly CheckpointDeclaration[],
  ): Promise<void> {
    // Memoized fast path: same instance, same schema version.
    if (this.schemaVersion === schema.version) return;
    // The barrier reads stored state: a checkpoint at this schema version that
    // is not activated and that this caller did not declare means this process
    // must not serve. An omitted or empty declaration set declares nothing and
    // is refused here, never treated as a bypass.
    const declarations = checkpoints ?? [];
    const incomplete = this.db
      .query<{ partition: string; name: string }, [number]>(
        `SELECT partition, name FROM sync_backfill_checkpoints
          WHERE schema_version=? AND state<>'activated'`,
      )
      .all(schema.version)
      .filter(
        (row) =>
          !declarations.some(
            (declaration) =>
              declaration.partition === row.partition &&
              declaration.name === row.name,
          ),
      );
    if (incomplete.length > 0) {
      throw new StorageQueryError('sync.storage.checkpoint_incomplete');
    }
    this.db.exec(SCHEMA_META_DDL_SQLITE);
    const marker = this.db
      .query<{ schema_version: number; layouts: string }, []>(
        'SELECT schema_version, layouts FROM sync_schema_meta WHERE id=1',
      )
      .get();
    if (marker !== null && marker.schema_version > schema.version) {
      throw new Error(
        `stored schema version ${marker.schema_version} is newer than the configured schema (${schema.version}) — refusing to run an older server against a migrated database`,
      );
    }
    if (marker !== null && marker.schema_version === schema.version) {
      assertStoredLayouts(schema, marker.layouts);
      for (const table of schema.tables.values()) {
        const escapedTableName = table.name.replaceAll('"', '""');
        const columns = this.db
          .query<
            { name: string; type: string; notnull: number; pk: number },
            []
          >(`PRAGMA table_info("${escapedTableName}")`)
          .all();
        assertPhysicalColumns(
          table,
          columns.map((column) => ({
            name: column.name,
            type: column.type,
            notNull: column.notnull === 1,
            primaryKeyPosition: column.pk,
          })),
          'sqlite',
        );
      }
      // Server-only indexes reconcile at every open of a database already at
      // this version: they never reach a client, so no version bump is needed.
      const reconcile = serverIndexDdl(
        schema,
        new Map(
          [...schema.tables.values()].map((table) => [
            table.name,
            new Map(
              Object.entries(
                sqliteIndexSignatures(
                  this.db
                    .query<SqliteTableIndexRow, [string]>(
                      SQLITE_TABLE_INDEXES_SQL,
                    )
                    .all(table.name),
                ),
              ),
            ),
          ]),
        ),
      );
      if (reconcile.length > 0) {
        this.db.exec('BEGIN IMMEDIATE');
        try {
          for (const statement of reconcile) this.db.exec(statement);
          this.db.exec('COMMIT');
        } catch (error) {
          rollbackAfterError(() => {
            this.db.exec('ROLLBACK');
          }, error);
        }
      }
    }
    if (marker === null || marker.schema_version < schema.version) {
      // Introspect existing app tables, then apply the migration subset
      // (CREATE TABLE / ADD COLUMN / rebuild indexes) to reach `schema`, then
      // rewrite stored rows (payload re-encode for layout changes, and/or
      // projection backfill for flipped-on materialization). One
      // transaction: a failed bump leaves no half-state.
      const existing = new Map<string, ReadonlySet<string>>();
      const existingIndexes = new Map<string, ReadonlyMap<string, string>>();
      for (const table of schema.tables.values()) {
        const escapedTableName = table.name.replaceAll('"', '""');
        const columns = this.db
          .query<{ name: string }, []>(
            `PRAGMA table_info("${escapedTableName}")`,
          )
          .all();
        if (columns.length > 0) {
          existing.set(table.name, new Set(columns.map((c) => c.name)));
          existingIndexes.set(
            table.name,
            new Map(
              Object.entries(
                sqliteIndexSignatures(
                  this.db
                    .query<SqliteTableIndexRow, [string]>(
                      SQLITE_TABLE_INDEXES_SQL,
                    )
                    .all(table.name),
                ),
              ),
            ),
          );
        }
      }
      // The migration rewrites application rows (`#rewriteRows`) with no
      // commit log entry. It runs behind the same connection queue as pushes
      // and prune rather than trusting the migration as privileged;
      // `BEGIN IMMEDIATE` then owns SQLite's writer lock for the whole
      // rewrite.
      this.db.exec('BEGIN IMMEDIATE');
      try {
        // Another process sharing the database may have bumped between the
        // marker read above and the writer lock; the locked marker decides
        // (SPEC "Schema upgrade writer fence").
        const locked = this.db
          .query<{ schema_version: number; layouts: string }, []>(
            'SELECT schema_version, layouts FROM sync_schema_meta WHERE id=1',
          )
          .get();
        if (locked !== null && locked.schema_version > schema.version) {
          throw new Error(
            `stored schema version ${locked.schema_version} is newer than the configured schema (${schema.version}) — refusing to run an older server against a migrated database`,
          );
        }
        if (locked !== null && locked.schema_version === schema.version) {
          this.db.exec('COMMIT');
          this.tables = schema.tables;
          this.schemaVersion = schema.version;
          return;
        }
        const layouts = parseLayouts(locked?.layouts);
        const retiredTables = retiredTableNames(schema, layouts);
        for (const tableName of retiredTables) {
          this.db
            .query('DELETE FROM sync_row_scopes WHERE tbl=?')
            .run(tableName);
          this.db
            .query('DELETE FROM sync_blob_refs WHERE tbl=?')
            .run(tableName);
          this.db.exec(dropTableDdl(tableName));
        }
        for (const statement of schemaDdl(
          schema,
          existing,
          'sqlite',
          existingIndexes,
        )) {
          this.db.exec(statement);
        }
        for (const table of schema.tables.values()) {
          const oldLayout = layouts[table.name];
          const plan = rewritePlan(table, oldLayout, existing.get(table.name));
          if (!plan.migrate && !plan.backfill) continue;
          this.#rewriteRows(table, plan.migrate ? oldLayout : undefined);
        }
        this.db
          .query(
            'INSERT INTO sync_schema_meta(id, schema_version, layouts) VALUES (1, ?, ?) ON CONFLICT(id) DO UPDATE SET schema_version=excluded.schema_version, layouts=excluded.layouts',
          )
          .run(schema.version, layoutsOf(schema));
        // A writer of the previous schema would append payloads in the
        // previous layout; the bump fences every partition at the new
        // version (see PostgresServerStorage.ensureSchema).
        this.db
          .query(
            `INSERT INTO sync_writer_fence(partition, required_writer_version)
             SELECT partition, ? FROM sync_partitions WHERE true
             ON CONFLICT(partition) DO UPDATE SET
               required_writer_version=max(
                 sync_writer_fence.required_writer_version,
                 excluded.required_writer_version)`,
          )
          .run(schema.version);
        // The host's declared checkpoints install in the schema-bump
        // transaction, so no observer sees the bumped marker without the
        // fence, or the fence without its declaration row.
        const installedAtMs = Date.now();
        for (const declaration of checkpoints ?? []) {
          this.#installCheckpoint(
            declaration.partition,
            declaration.name,
            declaration.schemaVersion,
            installedAtMs,
          );
        }
        this.db.exec('COMMIT');
      } catch (error) {
        rollbackAfterError(() => {
          this.db.exec('ROLLBACK');
        }, error);
      }
    }
    this.tables = schema.tables;
    this.schemaVersion = schema.version;
  }

  /**
   * Migration rewrite: keyset-paged walk of a row table. When `oldLayout` is
   * given every payload re-encodes under
   * the current columns, and the projection (when materialized) refreshes
   * from the payload either way.
   */
  #rewriteRows(
    table: CompiledTable,
    oldLayout: readonly StoredColumnLayout[] | undefined,
  ): void {
    const select = selectRowsForRewriteSql(table, 'sqlite');
    const update = this.db.query(rewriteRowSql(table));
    const BATCH = 500;
    let afterPartition = '';
    let afterRowId = '';
    for (;;) {
      const rows = this.db
        .query<
          { partition: string; row_id: string; payload: Uint8Array },
          [string, string, number]
        >(select)
        .all(afterPartition, afterRowId, BATCH);
      if (rows.length === 0) break;
      for (const row of rows) {
        const payload =
          oldLayout !== undefined
            ? migratePayload(oldLayout, table, row.payload)
            : row.payload;
        update.run(
          ...rewriteValues(table, row.partition, row.row_id, payload, 'sqlite'),
        );
      }
      const last = rows[rows.length - 1];
      if (last === undefined || rows.length < BATCH) break;
      afterPartition = last.partition;
      afterRowId = last.row_id;
    }
  }

  async begin(partition: string): Promise<StorageTransaction> {
    // Deliberately global across partitions: SQLite is single-writer per
    // database file, so one FIFO over the shared connection is the correct
    // serialization unit — a per-partition queue would still contend on the
    // same BEGIN IMMEDIATE writer lock.
    await this.#acquire();
    try {
      return new SqliteTransaction(
        this,
        partition,
        this.schemaVersion ?? 0,
        () => this.#release(),
      );
    } catch (error) {
      this.#release();
      throw error;
    }
  }

  /**
   * Internal: rewrite and run one registered query on the shared connection.
   * The caller owns the transaction: `queryAuthoritative` opens a read
   * transaction behind the FIFO; `SqliteTransaction.queryAuthoritative` runs
   * inside the push transaction's `BEGIN IMMEDIATE`.
   */
  runAuthoritativeQuery(
    partition: string,
    query: AuthoritativeQueryRequest,
  ): AuthoritativeQueryResult {
    const prepared = this.prepareAuthoritativeQuery(partition, query);
    const rows = this.db
      .query<Readonly<Record<string, unknown>>, AuthoritativeQueryValue[]>(
        prepared.sql,
      )
      .all(...prepared.params);
    const cursor = this.db
      .query<{ max_commit_seq: number }, [string]>(
        'SELECT max_commit_seq FROM sync_partitions WHERE partition=?',
      )
      .get(partition);
    return { rows, maxCommitSeq: cursor?.max_commit_seq ?? 0 };
  }

  async queryAuthoritative(
    partition: string,
    query: AuthoritativeQueryRequest,
    checkpoints?: readonly CheckpointDeclaration[],
  ): Promise<AuthoritativeQueryResult> {
    let open = false;
    try {
      this.db.exec('BEGIN');
      open = true;
      // RFC 0007: evaluate the gate on this connection after BEGIN. SQLite is
      // single-writer and the shared connection serializes writers, so the
      // gate read and the query read cannot straddle a migration.
      const runningVersion = this.schemaVersion ?? 0;
      const gate = await this.readServeGate(partition, runningVersion);
      const refusal = serveGateRefusal(gate, runningVersion, checkpoints);
      if (refusal !== undefined) throw serveNotReadyError(refusal);
      const result = this.runAuthoritativeQuery(partition, query);
      this.db.exec('COMMIT');
      open = false;
      return result;
    } catch (error) {
      rollbackAfterError(() => {
        if (open) this.db.exec('ROLLBACK');
      }, error);
    }
  }

  async readServeGate(
    partition: string,
    runningSchemaVersion: number,
  ): Promise<ServeGate> {
    const [marker] = await this.all<{ schema_version: number }>(
      'SELECT schema_version FROM sync_schema_meta WHERE id=1',
      [],
    );
    const pending = await this.all<{ partition: string; name: string }>(
      `SELECT partition, name FROM sync_backfill_checkpoints
        WHERE schema_version=? AND state<>'activated'`,
      [runningSchemaVersion],
    );
    return {
      storedSchemaVersion: marker?.schema_version ?? 0,
      logEpoch: await this.getPartitionLogEpoch(partition),
      pending,
    };
  }

  async readCheckpoints(partition: string): Promise<StoredCheckpoint[]> {
    return this.db
      .query<SqliteCheckpointRecord, [string]>(
        `SELECT partition, name, schema_version, state, watermark,
                owner_epoch, observed_rows, updated_at_ms
           FROM sync_backfill_checkpoints WHERE partition=? ORDER BY name`,
      )
      .all(partition)
      .map(toStoredCheckpoint);
  }

  /**
   * Insert the `declared` row and raise the fence, inside the caller's open
   * transaction. Shared by `declareCheckpoint` and the `ensureSchema`
   * migration so the schema bump and the fence commit together. Never lowers a
   * fence and never re-declares an existing row.
   */
  #installCheckpoint(
    partition: string,
    name: string,
    schemaVersion: number,
    nowMs: number,
  ): void {
    this.db
      .query(
        `INSERT INTO sync_backfill_checkpoints(
           partition, name, schema_version, state, watermark,
           owner_epoch, observed_rows, updated_at_ms)
         VALUES (?,?,?,'declared',0,0,0,?)
         ON CONFLICT(partition, name) DO NOTHING`,
      )
      .run(partition, name, schemaVersion, nowMs);
    this.db
      .query(
        `INSERT INTO sync_writer_fence(partition, required_writer_version)
         VALUES (?,?)
         ON CONFLICT(partition) DO UPDATE SET
           required_writer_version=max(
             sync_writer_fence.required_writer_version,
             excluded.required_writer_version)`,
      )
      .run(partition, schemaVersion);
  }

  async declareCheckpoint(
    partition: string,
    name: string,
    schemaVersion: number,
    nowMs: number,
  ): Promise<StoredCheckpoint> {
    // One transaction: the checkpoint becomes visible and the fence that
    // protects it is raised together. The fence is raised at declaration, not
    // at activation, so old writers are rejected for the whole backfill.
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.#installCheckpoint(partition, name, schemaVersion, nowMs);
      const row = this.db
        .query<SqliteCheckpointRecord, [string, string]>(
          `SELECT partition, name, schema_version, state, watermark,
                  owner_epoch, observed_rows, updated_at_ms
             FROM sync_backfill_checkpoints WHERE partition=? AND name=?`,
        )
        .get(partition, name);
      if (row === null)
        throw new StorageQueryError('sync.storage.checkpoint_not_declared');
      this.db.exec('COMMIT');
      return toStoredCheckpoint(row);
    } catch (error) {
      rollbackAfterError(() => {
        this.db.exec('ROLLBACK');
      }, error);
    }
  }

  async activateCheckpoint(
    partition: string,
    name: string,
    ownerEpoch: number,
    watermark: number,
    sources: readonly string[],
    nowMs: number,
  ): Promise<'activated' | 'stale' | 'unverifiable'> {
    // `BEGIN IMMEDIATE` is SQLite's partition write lock; the same writer
    // lock a push takes. Nothing may observe activation without the fence.
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const fence = this.db
        .query<{ required_writer_version: number }, [string]>(
          'SELECT required_writer_version FROM sync_writer_fence WHERE partition=?',
        )
        .get(partition);
      const checkpoint = this.db
        .query<{ schema_version: number }, [string, string]>(
          'SELECT schema_version FROM sync_backfill_checkpoints WHERE partition=? AND name=?',
        )
        .get(partition, name);
      if (
        fence === null ||
        checkpoint === null ||
        fence.required_writer_version < checkpoint.schema_version
      ) {
        // The barrier is not installed. Activating would certify a state old
        // writers can still decay; refuse instead of silently proceeding.
        throw new StorageQueryError('sync.storage.checkpoint_fence_missing');
      }
      const coverage = await this.hasSourceChangesAbove(
        partition,
        sources,
        watermark,
      );
      if (coverage !== 'clean') {
        this.db.exec('ROLLBACK');
        return coverage === 'changed' ? 'stale' : 'unverifiable';
      }
      const updated = this.db
        .query(
          `UPDATE sync_backfill_checkpoints
              SET state='activated', watermark=?, updated_at_ms=?
            WHERE partition=? AND name=? AND owner_epoch=?
              AND state<>'activated'`,
        )
        .run(watermark, nowMs, partition, name, ownerEpoch);
      this.db.exec('COMMIT');
      return Number(updated.changes) === 1 ? 'activated' : 'stale';
    } catch (error) {
      rollbackAfterError(() => {
        this.db.exec('ROLLBACK');
      }, error);
    }
  }

  async claimCheckpoint(
    partition: string,
    name: string,
    schemaVersion: number,
    nowMs: number,
  ): Promise<StoredCheckpoint> {
    const claimed = this.db
      .query<SqliteCheckpointRecord, (string | number)[]>(
        `UPDATE sync_backfill_checkpoints
            SET owner_epoch=owner_epoch+1,
                state=CASE WHEN state='declared' THEN 'backfilling' ELSE state END,
                schema_version=?, updated_at_ms=?
          WHERE partition=? AND name=? AND state<>'activated'
      RETURNING partition, name, schema_version, state, watermark,
                owner_epoch, observed_rows, updated_at_ms`,
      )
      .get(schemaVersion, nowMs, partition, name);
    if (claimed === null) {
      throw new StorageQueryError('sync.storage.checkpoint_not_declared');
    }
    return toStoredCheckpoint(claimed);
  }

  async advanceCheckpoint(
    partition: string,
    name: string,
    ownerEpoch: number,
    watermark: number,
    observedRows: number,
    nowMs: number,
  ): Promise<boolean> {
    const result = this.db
      .query(
        `UPDATE sync_backfill_checkpoints
            SET watermark=?, observed_rows=?, updated_at_ms=?
          WHERE partition=? AND name=? AND owner_epoch=?`,
      )
      .run(watermark, observedRows, nowMs, partition, name, ownerEpoch);
    return Number(result.changes) === 1;
  }
}
