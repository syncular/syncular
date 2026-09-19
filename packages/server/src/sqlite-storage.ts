import { validateCommitPruneQuery } from './prune';
import { StorageQueryError } from './storage-errors';
import type { CommitPruneQuery, CommitPruneResult } from './storage';
/**
 * SQLite server storage over the shared synchronous driver.
 *
 * Scope fanout is index-first: both the commit log and the
 * current-row table carry a (table, variable, value) inverted index; reads
 * select candidates from the index and verify the full multi-variable
 * match against the stored scope map — never a log scan.
 */
import {
  bindAuthoritativePartition,
  prepareAuthoritativeQuery,
} from './authoritative-query';
import { syncError } from './errors';
import {
  assertPhysicalColumns,
  commitWindowPageSql,
  deleteRowSql,
  deleteSqliteRowScopesSql,
  dropTableDdl,
  indexRowPageStatement,
  layoutsOf,
  migratePayload,
  parseLayouts,
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
  upsertSql,
  upsertValues,
} from './relational-rows';
import type { CompiledSchema, CompiledTable } from './schema';
import { matchesEffective } from './scopes';
import {
  collectCommitWindowPage,
  deserializePushResult,
  placeholders,
  SQLITE_DDL,
  type SqliteCommitWindowRecord,
  type SqliteRowRecord,
  serializePushResult,
  toStoredRow,
} from './sqlite-dialect';
import {
  SqliteAdapterRequiredError,
  type SqliteDatabase,
} from './sqlite-driver';
import type {
  AuthoritativeQueryRequest,
  AuthoritativeQueryResult,
  AuthoritativeQueryValue,
  CheckpointDeclaration,
  ClientCursorInfo,
  ClientRecord,
  ClientSubscription,
  CommitMetadata,
  CommitMetadataQuery,
  CommitWindowQuery,
  DurableJsonValue,
  IndexRowScanQuery,
  NewCommit,
  NewReaction,
  PartitionRegistryEntry,
  PrunedReactionCounts,
  ReactionClaimQuery,
  ReactionFailure,
  ReactionFailureUpdate,
  ReactionListQuery,
  ReactionPruneQuery,
  RowScanQuery,
  ScopeActivityQuery,
  ScopeCommitActivity,
  ServerStorage,
  StorageTransaction,
  StoredCommit,
  StoredCheckpoint,
  StoredPushResult,
  StoredReaction,
  StoredRow,
} from './storage';
import {
  isSqliteConstraintError,
  StorageConstraintError,
} from './storage-errors';
import { assertScopeIndexedScan, resolveIndexRowScan } from './storage-query';

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

interface SqliteReactionRecord {
  partition: string;
  idempotency_key: string;
  type: string;
  version: number;
  payload: string;
  source_client_id: string;
  source_client_commit_id: string;
  source_commit_seq: number;
  created_at_ms: number;
  available_at_ms: number;
  status: StoredReaction['status'];
  attempts: number;
  max_attempts: number;
  lease_owner: string | null;
  lease_expires_at_ms: number | null;
  completed_at_ms: number | null;
  last_failure: string | null;
}

function toStoredReaction(record: SqliteReactionRecord): StoredReaction {
  return {
    idempotencyKey: record.idempotency_key,
    type: record.type,
    version: record.version,
    payload: JSON.parse(record.payload) as DurableJsonValue,
    sourceClientId: record.source_client_id,
    sourceClientCommitId: record.source_client_commit_id,
    sourceCommitSeq: record.source_commit_seq,
    createdAtMs: record.created_at_ms,
    maxAttempts: record.max_attempts,
    status: record.status,
    attempts: record.attempts,
    availableAtMs: record.available_at_ms,
    ...(record.lease_owner !== null ? { leaseOwner: record.lease_owner } : {}),
    ...(record.lease_expires_at_ms !== null
      ? { leaseExpiresAtMs: record.lease_expires_at_ms }
      : {}),
    ...(record.completed_at_ms !== null
      ? { completedAtMs: record.completed_at_ms }
      : {}),
    ...(record.last_failure !== null
      ? { lastFailure: JSON.parse(record.last_failure) as ReactionFailure }
      : {}),
  };
}

class SqliteTransaction implements StorageTransaction {
  #storage: SqliteServerStorage;
  #partition: string;
  /** Schema version this transaction writes; rides every appended commit row. */
  #writerVersion: number;
  #open = true;
  #pushApplySavepoint = false;
  readonly #release: () => void;

  constructor(
    storage: SqliteServerStorage,
    partition: string,
    writerVersion: number,
    release: () => void,
  ) {
    this.#storage = storage;
    this.#partition = partition;
    this.#writerVersion = writerVersion;
    this.#release = release;
    storage.db.exec('BEGIN IMMEDIATE');
  }

  #assertOpen(): void {
    if (!this.#open) throw new Error('transaction already finished');
  }

  getRow(table: string, rowId: string): Promise<StoredRow | undefined> {
    this.#assertOpen();
    return this.#storage.getRow(this.#partition, table, rowId);
  }

  async getTombstoneSeq(
    table: string,
    rowId: string,
  ): Promise<number | undefined> {
    this.#assertOpen();
    const row = this.#storage.db
      .query<{ commit_seq: number }, [string, string, string]>(
        'SELECT commit_seq FROM sync_tombstones WHERE partition=? AND tbl=? AND row_id=?',
      )
      .get(this.#partition, table, rowId);
    return row?.commit_seq;
  }

  async clearTombstone(table: string, rowId: string): Promise<void> {
    this.#assertOpen();
    this.#storage.db
      .query(
        'DELETE FROM sync_tombstones WHERE partition=? AND tbl=? AND row_id=?',
      )
      .run(this.#partition, table, rowId);
  }

  getPushResult(
    clientId: string,
    clientCommitId: string,
  ): Promise<StoredPushResult | undefined> {
    this.#assertOpen();
    // One shared SQLite connection: this read runs inside this
    // transaction's BEGIN IMMEDIATE.
    return this.#storage.getPushResult(
      this.#partition,
      clientId,
      clientCommitId,
    );
  }

  scanRows(query: RowScanQuery): Promise<StoredRow[]> {
    this.#assertOpen();
    return this.#storage.scanRows(this.#partition, query);
  }

  scanRowsByIndex(query: IndexRowScanQuery): Promise<StoredRow[]> {
    this.#assertOpen();
    return this.#storage.scanRowsByIndex(this.#partition, query);
  }

  async lockPartitionForPush(): Promise<void> {
    this.#assertOpen();
    // BEGIN IMMEDIATE in the constructor already owns SQLite's writer lock.
    this.#storage.db.exec('SAVEPOINT syncular_push_candidate');
    this.#pushApplySavepoint = true;
  }

  async advanceCheckpoint(
    name: string,
    ownerEpoch: number,
    watermark: number,
    observedRows: number,
    nowMs: number,
  ): Promise<boolean> {
    this.#assertOpen();
    const result = this.#storage.db
      .query(
        `UPDATE sync_backfill_checkpoints
            SET watermark=?, observed_rows=?, updated_at_ms=?
          WHERE partition=? AND name=? AND owner_epoch=?`,
      )
      .run(watermark, observedRows, nowMs, this.#partition, name, ownerEpoch);
    return Number(result.changes) === 1;
  }

  async commitRejectedPushResult(
    clientId: string,
    clientCommitId: string,
    result: StoredPushResult,
  ): Promise<void> {
    this.#assertOpen();
    if (!this.#pushApplySavepoint) {
      throw new Error('push rejection requires its apply savepoint');
    }
    this.#storage.db.exec('ROLLBACK TO SAVEPOINT syncular_push_candidate');
    this.#storage.db.exec('RELEASE SAVEPOINT syncular_push_candidate');
    this.#pushApplySavepoint = false;
    await this.putPushResult(clientId, clientCommitId, result);
    await this.commit();
  }

  async upsertRow(
    table: string,
    row: StoredRow,
    context?: { readonly opIndex: number },
  ): Promise<void> {
    this.#assertOpen();
    try {
      this.#storage.writeRow(this.#partition, table, row);
    } catch (error) {
      if (isSqliteConstraintError(error)) {
        throw new StorageConstraintError(error, context?.opIndex);
      }
      throw error;
    }
  }

  async deleteRow(table: string, rowId: string): Promise<void> {
    this.#assertOpen();
    const db = this.#storage.db;
    const compiled = this.#storage.table(table);
    db.query(deleteSqliteRowScopesSql(compiled)).run(
      this.#partition,
      table,
      rowId,
      this.#partition,
      rowId,
    );
    db.query(deleteRowSql(compiled, 'sqlite')).run(this.#partition, rowId);
    // §5.9.4: a deleted row references no blobs.
    db.query(
      'DELETE FROM sync_blob_refs WHERE partition=? AND tbl=? AND row_id=?',
    ).run(this.#partition, table, rowId);
  }

  async setBlobRefs(
    table: string,
    rowId: string,
    blobIds: readonly string[],
  ): Promise<void> {
    this.#assertOpen();
    const db = this.#storage.db;
    // Replace the row's reference set atomically (§5.9.4).
    db.query(
      'DELETE FROM sync_blob_refs WHERE partition=? AND tbl=? AND row_id=?',
    ).run(this.#partition, table, rowId);
    for (const blobId of blobIds) {
      db.query(
        'INSERT OR IGNORE INTO sync_blob_refs(partition, tbl, row_id, blob_id) VALUES (?,?,?,?)',
      ).run(this.#partition, table, rowId, blobId);
    }
  }

  async appendCommit(commit: NewCommit): Promise<number> {
    this.#assertOpen();
    const db = this.#storage.db;
    const p = this.#partition;
    db.query('INSERT OR IGNORE INTO sync_partitions(partition) VALUES (?)').run(
      p,
    );
    const row = db
      .query<{ max_commit_seq: number }, [string]>(
        'SELECT max_commit_seq FROM sync_partitions WHERE partition=?',
      )
      .get(p);
    const commitSeq = (row?.max_commit_seq ?? 0) + 1;
    db.query(
      'UPDATE sync_partitions SET max_commit_seq=? WHERE partition=?',
    ).run(commitSeq, p);
    db.query(
      'INSERT INTO sync_commits(partition, commit_seq, client_id, client_commit_id, actor_id, created_at_ms, writer_version) VALUES (?,?,?,?,?,?,?)',
    ).run(
      p,
      commitSeq,
      commit.clientId,
      commit.clientCommitId,
      commit.actorId,
      commit.createdAtMs,
      this.#writerVersion,
    );
    commit.changes.forEach((change, idx) => {
      db.query(
        'INSERT INTO sync_changes(partition, commit_seq, idx, tbl, row_id, op, row_version, scopes, payload) VALUES (?,?,?,?,?,?,?,?,?)',
      ).run(
        p,
        commitSeq,
        idx,
        change.table,
        change.rowId,
        change.op === 'upsert' ? 1 : 2,
        change.rowVersion ?? null,
        JSON.stringify(change.scopes),
        change.payload ?? null,
      );
      if (change.op === 'delete') {
        // §5 delete precedence: every applied delete leaves a tombstone,
        // pruned with the commit log (§4.6).
        db.query(
          `INSERT INTO sync_tombstones(partition, tbl, row_id, commit_seq) VALUES (?,?,?,?)
           ON CONFLICT(partition, tbl, row_id) DO UPDATE SET commit_seq=excluded.commit_seq`,
        ).run(p, change.table, change.rowId, commitSeq);
      }
      for (const [variable, value] of Object.entries(change.scopes)) {
        db.query(
          'INSERT OR IGNORE INTO sync_change_scopes(partition, tbl, var, value, commit_seq) VALUES (?,?,?,?,?)',
        ).run(p, change.table, variable, value, commitSeq);
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
    this.#storage.db
      .query(
        'INSERT OR IGNORE INTO sync_push_results(partition, client_id, client_commit_id, result) VALUES (?,?,?,?)',
      )
      .run(
        this.#partition,
        clientId,
        clientCommitId,
        serializePushResult(result),
      );
  }

  async enqueueReactions(reactions: readonly NewReaction[]): Promise<void> {
    this.#assertOpen();
    const statement = this.#storage.db.query(
      `INSERT INTO sync_reactions(
         partition, idempotency_key, type, version, payload,
         source_client_id, source_client_commit_id, source_commit_seq,
         created_at_ms, available_at_ms, status, attempts, max_attempts
       ) VALUES (?,?,?,?,?,?,?,?,?,?,'pending',0,?)`,
    );
    for (const reaction of reactions) {
      statement.run(
        this.#partition,
        reaction.idempotencyKey,
        reaction.type,
        reaction.version,
        JSON.stringify(reaction.payload),
        reaction.sourceClientId,
        reaction.sourceClientCommitId,
        reaction.sourceCommitSeq,
        reaction.createdAtMs,
        reaction.createdAtMs,
        reaction.maxAttempts,
      );
    }
  }

  async commit(): Promise<void> {
    this.#assertOpen();
    try {
      this.#storage.db.exec('COMMIT');
    } catch (error) {
      // A failed COMMIT (SQLITE_BUSY from an external writer, I/O error)
      // leaves the connection inside BEGIN IMMEDIATE. Roll back before the
      // FIFO releases, so the next queued transaction starts on a clean
      // connection.
      try {
        this.#storage.db.exec('ROLLBACK');
      } catch {
        // Surface the COMMIT failure; a rollback failure would otherwise
        // mask it.
      }
      throw error;
    } finally {
      this.#open = false;
      this.#release();
    }
  }

  async rollback(): Promise<void> {
    if (!this.#open) return;
    this.#open = false;
    try {
      this.#storage.db.exec('ROLLBACK');
    } finally {
      this.#release();
    }
  }
}

export class SqliteServerStorage implements ServerStorage {
  readonly db: SqliteDatabase;
  /** One SQLite connection can own only one transaction at a time. */
  #transactionTail: Promise<void> = Promise.resolve();
  /** Set by `ensureSchema`: app-table lookup for the relational row store. */
  #tables: ReadonlyMap<string, CompiledTable> | undefined;
  #schemaVersion: number | undefined;

  async #serializeWrite<T>(operation: () => T): Promise<T> {
    const previous = this.#transactionTail;
    let release!: () => void;
    this.#transactionTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return operation();
    } finally {
      release();
    }
  }

  constructor(db: SqliteDatabase | string = ':memory:') {
    if (typeof db === 'string') {
      throw new SqliteAdapterRequiredError();
    }
    this.db = db;
    this.db.exec(SQLITE_DDL);
    const clientColumns = this.db
      .query<{ name: string }, []>('PRAGMA table_info("sync_clients")')
      .all();
    if (!clientColumns.some((column) => column.name === 'wire_version')) {
      this.db.exec(
        'ALTER TABLE sync_clients ADD COLUMN wire_version INTEGER NOT NULL DEFAULT 1',
      );
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

  async ensureSchema(
    schema: CompiledSchema,
    checkpoints?: readonly CheckpointDeclaration[],
  ): Promise<void> {
    // Memoized fast path: same instance, same schema version.
    if (this.#schemaVersion === schema.version) return;
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
      // Version equality is not layout equality: a marker written by another
      // build at the same version describes rows the running codec cannot
      // decode. Compare the stored layouts instead of trusting the number.
      const storedLayouts = parseLayouts(marker.layouts);
      const configuredLayouts = parseLayouts(layoutsOf(schema));
      let mismatch: string | undefined;
      for (const [tableName, columns] of Object.entries(configuredLayouts)) {
        const stored = storedLayouts[tableName];
        const columnCount = Math.max(columns.length, stored?.length ?? 0);
        for (let index = 0; index < columnCount; index++) {
          const expected = columns[index];
          const actual = stored?.[index];
          if (
            expected !== undefined &&
            actual !== undefined &&
            actual.name === expected.name &&
            actual.type === expected.type &&
            actual.nullable === expected.nullable
          ) {
            continue;
          }
          mismatch = `table ${JSON.stringify(tableName)} column ${JSON.stringify(expected?.name ?? actual?.name ?? '')}`;
          break;
        }
        if (mismatch !== undefined) break;
      }
      if (mismatch === undefined) {
        for (const tableName of Object.keys(storedLayouts)) {
          if (!(tableName in configuredLayouts)) {
            mismatch = `table ${JSON.stringify(tableName)}`;
            break;
          }
        }
      }
      if (mismatch !== undefined) {
        throw new Error(
          `stored schema layouts disagree with the configured schema at version ${schema.version} (${mismatch}) — refusing to serve a database whose stored rows the running code cannot decode`,
        );
      }
      // The persisted layouts describe the codec's app columns only: read the
      // physical tables so a same-version database missing a
      // storage-internal column is refused at startup instead of failing at
      // the first write.
      for (const table of schema.tables.values()) {
        const escapedTableName = table.name.replaceAll('"', '""');
        const columns = this.db
          .query<{ name: string }, []>(
            `PRAGMA table_info("${escapedTableName}")`,
          )
          .all();
        assertPhysicalColumns(table, new Set(columns.map((c) => c.name)));
      }
    }
    if (marker === null || marker.schema_version < schema.version) {
      // Introspect existing app tables, then apply the migration subset
      // (CREATE TABLE / ADD COLUMN / rebuild indexes) to reach `schema`, then
      // rewrite stored rows (payload re-encode for layout changes, and/or
      // projection backfill for flipped-on materialization). One
      // transaction: a failed bump leaves no half-state.
      const layouts = parseLayouts(marker?.layouts);
      const retiredTables = retiredTableNames(schema, layouts);
      const existing = new Map<string, ReadonlySet<string>>();
      const existingIndexes = new Map<string, ReadonlySet<string>>();
      for (const table of schema.tables.values()) {
        const escapedTableName = table.name.replaceAll('"', '""');
        const columns = this.db
          .query<{ name: string }, []>(
            `PRAGMA table_info("${escapedTableName}")`,
          )
          .all();
        if (columns.length > 0) {
          existing.set(table.name, new Set(columns.map((c) => c.name)));
          const indexes = this.db
            .query<{ name: string; origin: string }, []>(
              `PRAGMA index_list("${escapedTableName}")`,
            )
            .all()
            .filter((index) => index.origin === 'c');
          existingIndexes.set(
            table.name,
            new Set(indexes.map((index) => index.name)),
          );
        }
      }
      // The migration rewrites application rows (`#rewriteRows`) with no
      // commit log entry. Serialize it through the same writer queue as
      // pushes and prune (`#serializeWrite`) rather than trusting the
      // migration as privileged; `BEGIN IMMEDIATE` then owns SQLite's writer
      // lock for the whole rewrite.
      await this.#serializeWrite(() => {
        this.db.exec('BEGIN IMMEDIATE');
        try {
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
            const plan = rewritePlan(
              table,
              oldLayout,
              existing.get(table.name),
            );
            if (!plan.migrate && !plan.backfill) continue;
            this.#rewriteRows(table, plan.migrate ? oldLayout : undefined);
          }
          this.db
            .query(
              'INSERT INTO sync_schema_meta(id, schema_version, layouts) VALUES (1, ?, ?) ON CONFLICT(id) DO UPDATE SET schema_version=excluded.schema_version, layouts=excluded.layouts',
            )
            .run(schema.version, layoutsOf(schema));
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
          this.db.exec('ROLLBACK');
          throw error;
        }
      });
    }
    this.#tables = schema.tables;
    this.#schemaVersion = schema.version;
  }

  async touchPartition(
    partition: string,
    authenticatedAtMs: number,
    initialLogEpoch: string,
  ): Promise<PartitionRegistryEntry> {
    if (initialLogEpoch.length === 0) {
      throw new Error('initial log epoch must be non-empty');
    }
    this.db
      .query(
        `INSERT INTO sync_partition_registry(
           partition, log_epoch, last_authenticated_at_ms
         ) VALUES (?,?,?)
         ON CONFLICT(partition) DO UPDATE SET
           last_authenticated_at_ms=excluded.last_authenticated_at_ms`,
      )
      .run(partition, initialLogEpoch, authenticatedAtMs);
    const row = this.db
      .query<
        {
          log_epoch: string;
          epoch_required: number;
          last_authenticated_at_ms: number;
        },
        [string]
      >(
        `SELECT log_epoch, epoch_required, last_authenticated_at_ms
           FROM sync_partition_registry WHERE partition=?`,
      )
      .get(partition);
    if (row === null)
      throw new Error('partition registry write did not persist');
    return {
      partition,
      logEpoch: row.log_epoch,
      epochRequired: row.epoch_required === 1,
      lastAuthenticatedAtMs: row.last_authenticated_at_ms,
    };
  }

  async rotatePartitionLogEpoch(
    partition: string,
    logEpoch: string,
    authenticatedAtMs: number,
  ): Promise<PartitionRegistryEntry> {
    if (logEpoch.length === 0) throw new Error('log epoch must be non-empty');
    return this.#serializeWrite(() => {
      this.db.exec('BEGIN IMMEDIATE');
      try {
        this.db
          .query(
            `INSERT INTO sync_partition_registry(
               partition, log_epoch, epoch_required, last_authenticated_at_ms
             ) VALUES (?,?,1,?)
             ON CONFLICT(partition) DO UPDATE SET
               log_epoch=excluded.log_epoch,
               epoch_required=1,
               last_authenticated_at_ms=excluded.last_authenticated_at_ms`,
          )
          .run(partition, logEpoch, authenticatedAtMs);
        this.db
          .query('DELETE FROM sync_clients WHERE partition=?')
          .run(partition);
        this.db.exec('COMMIT');
      } catch (error) {
        this.db.exec('ROLLBACK');
        throw error;
      }
      return {
        partition,
        logEpoch,
        epochRequired: true,
        lastAuthenticatedAtMs: authenticatedAtMs,
      };
    });
  }

  async listPartitionRegistry(): Promise<PartitionRegistryEntry[]> {
    return this.db
      .query<
        {
          partition: string;
          log_epoch: string;
          epoch_required: number;
          last_authenticated_at_ms: number;
        },
        []
      >(
        `SELECT partition, log_epoch, epoch_required, last_authenticated_at_ms
           FROM sync_partition_registry ORDER BY partition`,
      )
      .all()
      .map((row) => ({
        partition: row.partition,
        logEpoch: row.log_epoch,
        epochRequired: row.epoch_required === 1,
        lastAuthenticatedAtMs: row.last_authenticated_at_ms,
      }));
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
    const update = this.db.query(rewriteRowSql(table, 'sqlite'));
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
          ...(rewriteValues(
            table,
            row.partition,
            row.row_id,
            payload,
            'sqlite',
          ) as (string | number | boolean | Uint8Array | null)[]),
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
    const previous = this.#transactionTail;
    let release!: () => void;
    this.#transactionTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return new SqliteTransaction(
        this,
        partition,
        this.#schemaVersion ?? 0,
        release,
      );
    } catch (error) {
      release();
      throw error;
    }
  }

  /** Internal: write a row + refresh its scope-index entries. */
  writeRow(partition: string, table: string, row: StoredRow): void {
    const compiled = this.table(table);
    this.db
      .query(deleteSqliteRowScopesSql(compiled))
      .run(partition, table, row.rowId, partition, row.rowId);
    this.db
      .query(upsertSql(compiled, 'sqlite'))
      .run(
        ...(upsertValues(compiled, partition, row, 'sqlite') as (
          | string
          | number
          | boolean
          | Uint8Array
          | null
        )[]),
      );
    for (const [variable, value] of Object.entries(row.scopes)) {
      this.db
        .query(
          'INSERT OR IGNORE INTO sync_row_scopes(partition, tbl, var, value, row_id) VALUES (?,?,?,?,?)',
        )
        .run(partition, table, variable, value, row.rowId);
    }
  }

  async getMaxCommitSeq(partition: string): Promise<number> {
    const row = this.db
      .query<{ max_commit_seq: number }, [string]>(
        'SELECT max_commit_seq FROM sync_partitions WHERE partition=?',
      )
      .get(partition);
    return row?.max_commit_seq ?? 0;
  }

  async queryAuthoritative(
    partition: string,
    query: AuthoritativeQueryRequest,
  ): Promise<AuthoritativeQueryResult> {
    if (this.#tables === undefined) {
      throw new Error(
        'ensureSchema(schema) must run before registered queries',
      );
    }
    const prepared = bindAuthoritativePartition(
      prepareAuthoritativeQuery(
        query.plan,
        query.params,
        query.tables,
        this.#tables,
      ),
      partition,
    );
    const previous = this.#transactionTail;
    let release!: () => void;
    this.#transactionTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    let open = false;
    try {
      this.db.exec('BEGIN');
      open = true;
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
      this.db.exec('COMMIT');
      open = false;
      return { rows, maxCommitSeq: cursor?.max_commit_seq ?? 0 };
    } catch (error) {
      if (open) this.db.exec('ROLLBACK');
      throw error;
    } finally {
      release();
    }
  }

  async getPartitionLogEpoch(partition: string): Promise<string | undefined> {
    return this.db
      .query<{ log_epoch: string }, [string]>(
        'SELECT log_epoch FROM sync_partition_registry WHERE partition=?',
      )
      .get(partition)?.log_epoch;
  }

  async getHorizonSeq(partition: string): Promise<number> {
    const row = this.db
      .query<{ horizon_seq: number }, [string]>(
        'SELECT horizon_seq FROM sync_partitions WHERE partition=?',
      )
      .get(partition);
    return row?.horizon_seq ?? 0;
  }

  async setHorizonSeq(partition: string, seq: number): Promise<void> {
    await this.#serializeWrite(() => {
      this.db
        .query(`INSERT INTO sync_partitions(partition, horizon_seq) VALUES (?,?)
        ON CONFLICT(partition) DO UPDATE SET horizon_seq=max(horizon_seq,excluded.horizon_seq)`)
        .run(partition, seq);
    });
  }

  async pruneCommitsThrough(
    partition: string,
    query: CommitPruneQuery,
  ): Promise<CommitPruneResult> {
    validateCommitPruneQuery(query);
    return this.#serializeWrite(() => {
      this.db.exec('BEGIN IMMEDIATE');
      try {
        const epoch = this.db
          .query<{ log_epoch: string }, [string]>(
            'SELECT log_epoch FROM sync_partition_registry WHERE partition=?',
          )
          .get(partition)?.log_epoch;
        if (epoch !== query.logEpoch)
          throw new StorageQueryError('sync.storage.prune_epoch_mismatch');
        const previousHorizonSeq =
          this.db
            .query<{ horizon_seq: number }, [string]>(
              'SELECT horizon_seq FROM sync_partitions WHERE partition=?',
            )
            .get(partition)?.horizon_seq ?? 0;
        const horizonSeq = Math.max(previousHorizonSeq, query.throughSeq);
        this.db
          .query(`INSERT INTO sync_partitions(partition, horizon_seq) VALUES (?,?)
          ON CONFLICT(partition) DO UPDATE SET horizon_seq=excluded.horizon_seq`)
          .run(partition, horizonSeq);
        const removed = this.db
          .query('DELETE FROM sync_commits WHERE partition=? AND commit_seq<=?')
          .run(partition, horizonSeq);
        this.db
          .query('DELETE FROM sync_changes WHERE partition=? AND commit_seq<=?')
          .run(partition, horizonSeq);
        this.db
          .query(
            'DELETE FROM sync_change_scopes WHERE partition=? AND commit_seq<=?',
          )
          .run(partition, horizonSeq);
        // §4.6: tombstones prune in the same pass as the commit log.
        this.db
          .query(
            'DELETE FROM sync_tombstones WHERE partition=? AND commit_seq<=?',
          )
          .run(partition, horizonSeq);
        this.db.exec('COMMIT');
        return {
          previousHorizonSeq,
          horizonSeq,
          removedCommits: Number(removed.changes),
        };
      } catch (error) {
        this.db.exec('ROLLBACK');
        throw error;
      }
    });
  }

  async getCommitSeqBefore(
    partition: string,
    createdBeforeMs: number,
  ): Promise<number> {
    const row = this.db
      .query<{ seq: number | null }, [string, number]>(
        'SELECT max(commit_seq) AS seq FROM sync_commits WHERE partition=? AND created_at_ms<?',
      )
      .get(partition, createdBeforeMs);
    return row?.seq ?? 0;
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
    return this.#serializeWrite(() => {
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
        this.db.exec('ROLLBACK');
        throw error;
      }
    });
  }

  async activateCheckpoint(
    partition: string,
    name: string,
    ownerEpoch: number,
    watermark: number,
    sources: readonly string[],
    nowMs: number,
  ): Promise<'activated' | 'stale' | 'unverifiable'> {
    return this.#serializeWrite(() => {
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
        const coverage = this.#hasSourceChangesAbove(
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
        this.db.exec('ROLLBACK');
        throw error;
      }
    });
  }

  async claimCheckpoint(
    partition: string,
    name: string,
    schemaVersion: number,
    nowMs: number,
  ): Promise<StoredCheckpoint> {
    return this.#serializeWrite(() => {
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
    });
  }

  async advanceCheckpoint(
    partition: string,
    name: string,
    ownerEpoch: number,
    watermark: number,
    observedRows: number,
    nowMs: number,
  ): Promise<boolean> {
    return this.#serializeWrite(() => {
      const result = this.db
        .query(
          `UPDATE sync_backfill_checkpoints
              SET watermark=?, observed_rows=?, updated_at_ms=?
            WHERE partition=? AND name=? AND owner_epoch=?`,
        )
        .run(watermark, observedRows, nowMs, partition, name, ownerEpoch);
      return Number(result.changes) === 1;
    });
  }

  async sourceCoverageSeq(
    partition: string,
    tables: readonly string[],
  ): Promise<number> {
    if (tables.length === 0) return 0;
    const row = this.db
      .query<{ seq: number | null }, (string | number)[]>(
        `SELECT max(commit_seq) AS seq FROM sync_changes
          WHERE partition=? AND tbl IN (${placeholders(tables.length)})`,
      )
      .get(partition, ...tables);
    return row?.seq ?? 0;
  }

  #hasSourceChangesAbove(
    partition: string,
    tables: readonly string[],
    seq: number,
  ): 'clean' | 'changed' | 'unverifiable' {
    // Read the horizon before the window scan: a horizon past `seq` means the
    // history that would answer the question is gone, so an empty scan proves
    // nothing and must not be reported as `clean`.
    const horizon =
      this.db
        .query<{ horizon_seq: number }, [string]>(
          'SELECT horizon_seq FROM sync_partitions WHERE partition=?',
        )
        .get(partition)?.horizon_seq ?? 0;
    if (tables.length === 0) return 'clean';
    const hit = this.db
      .query<{ hit: number }, (string | number)[]>(
        `SELECT 1 AS hit FROM sync_changes
          WHERE partition=? AND tbl IN (${placeholders(tables.length)})
            AND commit_seq>? LIMIT 1`,
      )
      .get(partition, ...tables, seq);
    if (hit !== null && hit !== undefined) return 'changed';
    return horizon > seq ? 'unverifiable' : 'clean';
  }

  async hasSourceChangesAbove(
    partition: string,
    tables: readonly string[],
    seq: number,
  ): Promise<'clean' | 'changed' | 'unverifiable'> {
    return this.#hasSourceChangesAbove(partition, tables, seq);
  }

  async writerFenceAllows(
    partition: string,
    writerVersion: number,
  ): Promise<boolean> {
    const row = this.db
      .query<{ required_writer_version: number }, [string]>(
        'SELECT required_writer_version FROM sync_writer_fence WHERE partition=?',
      )
      .get(partition);
    // An absent row means no barrier on this partition; writes are allowed.
    return row === null || writerVersion >= row.required_writer_version;
  }

  async getRow(
    partition: string,
    table: string,
    rowId: string,
  ): Promise<StoredRow | undefined> {
    const record = this.db
      .query<SqliteRowRecord, [string, string]>(
        selectRowSql(this.table(table), 'sqlite'),
      )
      .get(partition, rowId);
    return record === null ? undefined : toStoredRow(record);
  }

  async getPushResult(
    partition: string,
    clientId: string,
    clientCommitId: string,
  ): Promise<StoredPushResult | undefined> {
    const record = this.db
      .query<{ result: string }, [string, string, string]>(
        'SELECT result FROM sync_push_results WHERE partition=? AND client_id=? AND client_commit_id=?',
      )
      .get(partition, clientId, clientCommitId);
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

  async claimReactions(
    partition: string,
    query: ReactionClaimQuery,
  ): Promise<StoredReaction[]> {
    if (query.types.length === 0 || query.limit <= 0) return [];
    return this.#serializeWrite(() => {
      const typeParams = query.types.map(() => '?').join(',');
      const records = this.db
        .query<SqliteReactionRecord, (string | number)[]>(
          `UPDATE sync_reactions
            SET status='leased', attempts=attempts+1,
                lease_owner=?, lease_expires_at_ms=?, completed_at_ms=NULL
          WHERE (partition, idempotency_key) IN (
            SELECT partition, idempotency_key
              FROM sync_reactions
             WHERE partition=? AND type IN (${typeParams})
               AND ((status='pending' AND available_at_ms<=?)
                 OR (status='leased' AND lease_expires_at_ms<=?))
             ORDER BY CASE WHEN status='leased' THEN lease_expires_at_ms
                           ELSE available_at_ms END,
                      created_at_ms, idempotency_key
             LIMIT ?
          )
        RETURNING *`,
        )
        .all(
          query.leaseOwner,
          Math.min(
            Number.MAX_SAFE_INTEGER,
            query.nowMs + query.leaseDurationMs,
          ),
          partition,
          ...query.types,
          query.nowMs,
          query.nowMs,
          query.limit,
        );
      return records
        .map(toStoredReaction)
        .sort(
          (a, b) =>
            a.createdAtMs - b.createdAtMs ||
            a.idempotencyKey.localeCompare(b.idempotencyKey),
        );
    });
  }

  async completeReaction(
    partition: string,
    idempotencyKey: string,
    leaseOwner: string,
    completedAtMs: number,
  ): Promise<boolean> {
    return this.#serializeWrite(() => {
      const result = this.db
        .query(
          `UPDATE sync_reactions
            SET status='completed', completed_at_ms=?,
                lease_owner=NULL, lease_expires_at_ms=NULL
          WHERE partition=? AND idempotency_key=?
            AND status='leased' AND lease_owner=?`,
        )
        .run(completedAtMs, partition, idempotencyKey, leaseOwner);
      return Number(result.changes) === 1;
    });
  }

  async extendReactionLease(
    partition: string,
    idempotencyKey: string,
    leaseOwner: string,
    leaseExpiresAtMs: number,
  ): Promise<boolean> {
    return this.#serializeWrite(() => {
      const result = this.db
        .query(
          `UPDATE sync_reactions SET lease_expires_at_ms=?
          WHERE partition=? AND idempotency_key=?
            AND status='leased' AND lease_owner=?`,
        )
        .run(leaseExpiresAtMs, partition, idempotencyKey, leaseOwner);
      return Number(result.changes) === 1;
    });
  }

  async failReaction(
    partition: string,
    idempotencyKey: string,
    update: ReactionFailureUpdate,
  ): Promise<boolean> {
    const retry = update.retryAtMs !== undefined;
    return this.#serializeWrite(() => {
      const result = this.db
        .query(
          `UPDATE sync_reactions
            SET status=?, available_at_ms=?, last_failure=?,
                lease_owner=NULL, lease_expires_at_ms=NULL
          WHERE partition=? AND idempotency_key=?
            AND status='leased' AND lease_owner=?`,
        )
        .run(
          retry ? 'pending' : 'dead-letter',
          update.retryAtMs ?? update.failure.atMs,
          JSON.stringify(update.failure),
          partition,
          idempotencyKey,
          update.leaseOwner,
        );
      return Number(result.changes) === 1;
    });
  }

  async retryReaction(
    partition: string,
    idempotencyKey: string,
    nowMs: number,
  ): Promise<boolean> {
    return this.#serializeWrite(() => {
      const result = this.db
        .query(
          `UPDATE sync_reactions
            SET status='pending', attempts=0, available_at_ms=?,
                last_failure=NULL, lease_owner=NULL, lease_expires_at_ms=NULL,
                completed_at_ms=NULL
          WHERE partition=? AND idempotency_key=? AND status='dead-letter'`,
        )
        .run(nowMs, partition, idempotencyKey);
      return Number(result.changes) === 1;
    });
  }

  async getReaction(
    partition: string,
    idempotencyKey: string,
  ): Promise<StoredReaction | undefined> {
    const record = this.db
      .query<SqliteReactionRecord, [string, string]>(
        'SELECT * FROM sync_reactions WHERE partition=? AND idempotency_key=?',
      )
      .get(partition, idempotencyKey);
    return record === null ? undefined : toStoredReaction(record);
  }

  async listReactions(
    partition: string,
    query: ReactionListQuery,
  ): Promise<StoredReaction[]> {
    const where = ['partition=?'];
    const params: (string | number)[] = [partition];
    if (query.statuses !== undefined && query.statuses.length > 0) {
      where.push(`status IN (${query.statuses.map(() => '?').join(',')})`);
      params.push(...query.statuses);
    }
    if (query.types !== undefined && query.types.length > 0) {
      where.push(`type IN (${query.types.map(() => '?').join(',')})`);
      params.push(...query.types);
    }
    params.push(query.limit);
    const records = this.db
      .query<SqliteReactionRecord, (string | number)[]>(
        `SELECT * FROM sync_reactions WHERE ${where.join(' AND ')}
          ORDER BY created_at_ms DESC, idempotency_key DESC LIMIT ?`,
      )
      .all(...params);
    return records.map(toStoredReaction);
  }

  async pruneReactions(
    partition: string,
    query: ReactionPruneQuery,
  ): Promise<PrunedReactionCounts> {
    if (query.limit <= 0) return { completed: 0, deadLetter: 0 };
    return this.#serializeWrite(() => {
      const records = this.db
        .query<
          { status: 'completed' | 'dead-letter' },
          [string, string, number, number, number, number, number]
        >(
          `DELETE FROM sync_reactions
            WHERE partition=? AND idempotency_key IN (
              SELECT idempotency_key FROM sync_reactions
               WHERE partition=?
                 AND ((status='completed' AND completed_at_ms IS NOT NULL
                       AND completed_at_ms<?)
                   OR (status='dead-letter' AND available_at_ms<?))
               ORDER BY CASE WHEN status='completed' THEN completed_at_ms
                             ELSE available_at_ms END,
                        idempotency_key
               LIMIT ?
            )
              AND ((status='completed' AND completed_at_ms IS NOT NULL
                    AND completed_at_ms<?)
                OR (status='dead-letter' AND available_at_ms<?))
          RETURNING status`,
        )
        .all(
          partition,
          partition,
          query.completedBeforeMs,
          query.deadLetterBeforeMs,
          query.limit,
          query.completedBeforeMs,
          query.deadLetterBeforeMs,
        );
      return {
        completed: records.filter((record) => record.status === 'completed')
          .length,
        deadLetter: records.filter((record) => record.status === 'dead-letter')
          .length,
      };
    });
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
    // commit meta + the table's changes — one statement per page, never two
    // per candidate (see `commitWindowPageSql`). Exact multi-variable
    // verification against the stored scope map in `collectCommitWindowPage`.
    const sql = commitWindowPageSql(firstValues.length, 'sqlite');
    const commits: StoredCommit[] = [];
    let deliveredChanges = 0;
    let afterSeq = query.afterSeq;
    const batchSize = Math.max(64, query.limitChanges);
    while (deliveredChanges < query.limitChanges) {
      const records = this.db
        .query<SqliteCommitWindowRecord, (string | number)[]>(sql)
        .all(
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
        );
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
    // statement per page, never one per row (see `scanRowPageSql`). Exact
    // multi-variable verification against the stored scope map below.
    const sql = scanRowPageSql(
      this.table(query.table),
      firstValues.length,
      'sqlite',
    );
    const rows: StoredRow[] = [];
    let afterRowId = query.afterRowId ?? '';
    const batchSize = Math.max(64, query.limit);
    while (rows.length < query.limit) {
      const records = this.db
        .query<
          SqliteRowRecord & { payload: Uint8Array | null },
          (string | number)[]
        >(sql)
        .all(
          partition,
          query.table,
          firstVariable,
          ...firstValues,
          afterRowId,
          batchSize,
          partition,
        );
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
    const params = statement.params as readonly (
      | string
      | number
      | Uint8Array
      | null
    )[];
    const records = this.db
      .query<SqliteRowRecord, (string | number | Uint8Array | null)[]>(
        statement.sql,
      )
      .all(...params);
    return records.map(toStoredRow);
  }

  async getClientRecord(
    partition: string,
    clientId: string,
  ): Promise<ClientRecord | undefined> {
    const record = this.db
      .query<
        {
          client_id: string;
          actor_id: string;
          wire_version: number;
          cursor: number;
          subscriptions: string;
          updated_at_ms: number;
        },
        [string, string]
      >(
        'SELECT client_id, actor_id, wire_version, cursor, subscriptions, updated_at_ms FROM sync_clients WHERE partition=? AND client_id=?',
      )
      .get(partition, clientId);
    if (record === null) return undefined;
    return {
      clientId: record.client_id,
      actorId: record.actor_id,
      wireVersion: record.wire_version,
      cursor: record.cursor,
      updatedAtMs: record.updated_at_ms,
      subscriptions: JSON.parse(record.subscriptions) as ClientSubscription[],
    };
  }

  async putClientRecord(
    partition: string,
    record: ClientRecord,
  ): Promise<void> {
    this.db
      .query(
        'INSERT OR REPLACE INTO sync_clients(partition, client_id, actor_id, wire_version, cursor, subscriptions, updated_at_ms) VALUES (?,?,?,?,?,?,?)',
      )
      .run(
        partition,
        record.clientId,
        record.actorId,
        record.wireVersion,
        record.cursor,
        JSON.stringify(record.subscriptions),
        record.updatedAtMs,
      );
  }

  async advanceClientCursor(
    partition: string,
    clientId: string,
    actorId: string,
    logEpoch: string,
    cursor: number,
    updatedAtMs: number,
  ): Promise<void> {
    this.db
      .query(`UPDATE sync_clients
         SET cursor=MAX(cursor, ?), updated_at_ms=MAX(updated_at_ms, ?)
         WHERE partition=? AND client_id=? AND actor_id=?
           AND EXISTS (SELECT 1 FROM sync_partition_registry
                       WHERE partition=sync_clients.partition AND log_epoch=?)`)
      .run(cursor, updatedAtMs, partition, clientId, actorId, logEpoch);
  }

  async updateClientCursor(
    partition: string,
    clientId: string,
    cursor: number,
    updatedAtMs: number,
  ): Promise<void> {
    this.db
      .query(
        `UPDATE sync_clients
         SET cursor=MAX(cursor, ?), updated_at_ms=MAX(updated_at_ms, ?)
         WHERE partition=? AND client_id=?`,
      )
      .run(cursor, updatedAtMs, partition, clientId);
  }

  async getActiveClientCursorFloor(
    partition: string,
    cutoffMs: number,
  ): Promise<number | null> {
    const row = this.db
      .query<{ cursor: number | null }, [string, number]>(
        'SELECT MIN(cursor) AS cursor FROM sync_clients WHERE partition=? AND updated_at_ms>=?',
      )
      .get(partition, cutoffMs);
    return row!.cursor;
  }

  async listClientCursors(partition: string): Promise<ClientCursorInfo[]> {
    const records = this.db
      .query<
        { client_id: string; cursor: number; updated_at_ms: number },
        [string]
      >(
        'SELECT client_id, cursor, updated_at_ms FROM sync_clients WHERE partition=?',
      )
      .all(partition);
    return records.map((r) => ({
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
    // Candidate rows via the by-blob index (§5.9.4/§5.9.5); each row's
    // stored scopes come from sync_rows for the §3.4 authorization test.
    const refs = this.db
      .query<{ tbl: string; row_id: string }, [string, string]>(
        'SELECT tbl, row_id FROM sync_blob_refs WHERE partition=? AND blob_id=?',
      )
      .all(partition, blobId);
    const out: {
      table: string;
      rowId: string;
      scopes: Record<string, string>;
    }[] = [];
    for (const ref of refs) {
      const compiled = this.#tables?.get(ref.tbl);
      if (compiled === undefined) continue; // table no longer in the schema
      const row = this.db
        .query<{ scopes: string }, [string, string]>(
          selectRowScopesSql(compiled, 'sqlite'),
        )
        .get(partition, ref.row_id);
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
    const rows = this.db
      .query<{ blob_id: string }, [string]>(
        'SELECT DISTINCT blob_id FROM sync_blob_refs WHERE partition=?',
      )
      .all(partition);
    return rows.map((r) => r.blob_id);
  }

  // -- admin/console read surface --------------------------------------------

  async listClientRecords(partition: string): Promise<ClientRecord[]> {
    const records = this.db
      .query<
        {
          client_id: string;
          actor_id: string;
          wire_version: number;
          cursor: number;
          subscriptions: string;
          updated_at_ms: number;
        },
        [string]
      >(
        'SELECT client_id, actor_id, wire_version, cursor, subscriptions, updated_at_ms FROM sync_clients WHERE partition=? ORDER BY updated_at_ms DESC',
      )
      .all(partition);
    return records.map((record) => ({
      clientId: record.client_id,
      actorId: record.actor_id,
      wireVersion: record.wire_version,
      cursor: record.cursor,
      updatedAtMs: record.updated_at_ms,
      subscriptions: JSON.parse(record.subscriptions) as ClientSubscription[],
    }));
  }

  async listCommitMetadata(
    partition: string,
    query: CommitMetadataQuery,
  ): Promise<CommitMetadata[]> {
    // Newest-first window, resumed by `afterSeq` (exclusive lower bound).
    const rows = query.table
      ? this.db
          .query<
            {
              commit_seq: number;
              client_id: string;
              client_commit_id: string;
              actor_id: string;
              created_at_ms: number;
            },
            [string, number, string, number]
          >(
            `SELECT c.commit_seq, c.client_id, c.client_commit_id, c.actor_id, c.created_at_ms
             FROM sync_commits c
             WHERE c.partition=? AND c.commit_seq>?
               AND EXISTS (SELECT 1 FROM sync_changes ch
                 WHERE ch.partition=c.partition AND ch.commit_seq=c.commit_seq AND ch.tbl=?)
             ORDER BY c.commit_seq DESC LIMIT ?`,
          )
          .all(partition, query.afterSeq, query.table, query.limit)
      : this.db
          .query<
            {
              commit_seq: number;
              client_id: string;
              client_commit_id: string;
              actor_id: string;
              created_at_ms: number;
            },
            [string, number, number]
          >(
            `SELECT commit_seq, client_id, client_commit_id, actor_id, created_at_ms
             FROM sync_commits
             WHERE partition=? AND commit_seq>?
             ORDER BY commit_seq DESC LIMIT ?`,
          )
          .all(partition, query.afterSeq, query.limit);
    return rows.map((row) => {
      const changes = this.db
        .query<{ tbl: string; n: number }, [string, number]>(
          'SELECT tbl, count(*) AS n FROM sync_changes WHERE partition=? AND commit_seq=? GROUP BY tbl',
        )
        .all(partition, row.commit_seq);
      return {
        commitSeq: row.commit_seq,
        clientId: row.client_id,
        clientCommitId: row.client_commit_id,
        actorId: row.actor_id,
        createdAtMs: row.created_at_ms,
        changeCount: changes.reduce((sum, c) => sum + c.n, 0),
        tables: changes.map((c) => c.tbl),
      };
    });
  }

  async scopeActivity(
    partition: string,
    query: ScopeActivityQuery,
  ): Promise<ScopeCommitActivity[]> {
    // Candidate commits via the change-scope index (§3.1) — never a scan.
    const rows = this.db
      .query<
        { commit_seq: number; tbl: string },
        [string, string, string, number]
      >(
        `SELECT DISTINCT commit_seq, tbl FROM sync_change_scopes
         WHERE partition=? AND var=? AND value=?
         ORDER BY commit_seq DESC LIMIT ?`,
      )
      .all(partition, query.variable, query.value, query.limit);
    const out: ScopeCommitActivity[] = [];
    for (const row of rows) {
      const meta = this.db
        .query<{ actor_id: string; created_at_ms: number }, [string, number]>(
          'SELECT actor_id, created_at_ms FROM sync_commits WHERE partition=? AND commit_seq=?',
        )
        .get(partition, row.commit_seq);
      if (meta === null) continue;
      const count = this.db
        .query<{ n: number }, [string, number, string]>(
          'SELECT count(*) AS n FROM sync_changes WHERE partition=? AND commit_seq=? AND tbl=?',
        )
        .get(partition, row.commit_seq, row.tbl);
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
    const record = this.db
      .query<{ server_version: number; scopes: string }, [string, string]>(
        selectRowScopesSql(this.table(table), 'sqlite'),
      )
      .get(partition, rowId);
    if (record === null) return undefined;
    return {
      serverVersion: record.server_version,
      scopes: JSON.parse(record.scopes) as Record<string, string>,
    };
  }

  async listPartitions(): Promise<string[]> {
    return (await this.listPartitionRegistry()).map((entry) => entry.partition);
  }
}
