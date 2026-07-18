/**
 * SQLite storage via `bun:sqlite` (dev-speed, dependency-free).
 *
 * Scope fanout is index-first (REVISE B2): both the commit log and the
 * current-row table carry a (table, variable, value) inverted index; reads
 * select candidates from the index and verify the full multi-variable
 * match against the stored scope map — never a log scan.
 */
import { Database } from 'bun:sqlite';
import { syncError } from './errors';
import {
  commitWindowPageSql,
  deleteRowSql,
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
  SQLITE_DDL,
  type SqliteCommitWindowRecord,
  type SqliteRowRecord,
  serializePushResult,
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
import {
  isSqliteConstraintError,
  StorageConstraintError,
} from './storage-errors';
import { assertScopeIndexedScan, resolveIndexRowScan } from './storage-query';

class SqliteTransaction implements StorageTransaction {
  #storage: SqliteServerStorage;
  #partition: string;
  #open = true;
  #commitValidationSavepoint = false;

  constructor(storage: SqliteServerStorage, partition: string) {
    this.#storage = storage;
    this.#partition = partition;
    storage.db.exec('BEGIN IMMEDIATE');
  }

  #assertOpen(): void {
    if (!this.#open) throw new Error('transaction already finished');
  }

  getRow(table: string, rowId: string): Promise<StoredRow | undefined> {
    this.#assertOpen();
    return this.#storage.getRow(this.#partition, table, rowId);
  }

  scanRows(query: RowScanQuery): Promise<StoredRow[]> {
    this.#assertOpen();
    return this.#storage.scanRows(this.#partition, query);
  }

  scanRowsByIndex(query: IndexRowScanQuery): Promise<StoredRow[]> {
    this.#assertOpen();
    return this.#storage.scanRowsByIndex(this.#partition, query);
  }

  async lockPartitionForCommitValidation(): Promise<void> {
    this.#assertOpen();
    // BEGIN IMMEDIATE in the constructor already owns SQLite's writer lock.
    this.#storage.db.exec('SAVEPOINT syncular_commit_validation_candidate');
    this.#commitValidationSavepoint = true;
  }

  async commitRejectedPushResult(
    clientId: string,
    clientCommitId: string,
    result: StoredPushResult,
  ): Promise<void> {
    this.#assertOpen();
    if (!this.#commitValidationSavepoint) {
      throw new Error(
        'whole-commit rejection requires its validation savepoint',
      );
    }
    this.#storage.db.exec(
      'ROLLBACK TO SAVEPOINT syncular_commit_validation_candidate',
    );
    this.#storage.db.exec(
      'RELEASE SAVEPOINT syncular_commit_validation_candidate',
    );
    this.#commitValidationSavepoint = false;
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
    db.query(deleteRowSql(this.#storage.table(table), 'sqlite')).run(
      this.#partition,
      rowId,
    );
    db.query(
      'DELETE FROM sync_row_scopes WHERE partition=? AND tbl=? AND row_id=?',
    ).run(this.#partition, table, rowId);
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
      'INSERT INTO sync_commits(partition, commit_seq, client_id, client_commit_id, actor_id, created_at_ms) VALUES (?,?,?,?,?,?)',
    ).run(
      p,
      commitSeq,
      commit.clientId,
      commit.clientCommitId,
      commit.actorId,
      commit.createdAtMs,
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

  async commit(): Promise<void> {
    this.#assertOpen();
    this.#open = false;
    this.#storage.db.exec('COMMIT');
  }

  async rollback(): Promise<void> {
    if (!this.#open) return;
    this.#open = false;
    this.#storage.db.exec('ROLLBACK');
  }
}

export class SqliteServerStorage implements ServerStorage {
  readonly db: Database;
  /** Set by `ensureSchema`: app-table lookup for the relational row store. */
  #tables: ReadonlyMap<string, CompiledTable> | undefined;
  #schemaVersion: number | undefined;

  constructor(db: Database | string = ':memory:') {
    this.db = typeof db === 'string' ? new Database(db) : db;
    this.db.exec(SQLITE_DDL);
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
    // Memoized fast path: same instance, same schema version.
    if (this.#schemaVersion === schema.version) return;
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
      this.db.exec('BEGIN IMMEDIATE');
      try {
        for (const tableName of retiredTables) {
          this.db
            .query('DELETE FROM sync_row_scopes WHERE tbl=?')
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
        this.db.exec('COMMIT');
      } catch (error) {
        this.db.exec('ROLLBACK');
        throw error;
      }
    }
    this.#tables = schema.tables;
    this.#schemaVersion = schema.version;
  }

  /**
   * Migration rewrite (DESIGN "optional materialization"): keyset-paged walk
   * of a row table; when `oldLayout` is given every payload re-encodes under
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
    return new SqliteTransaction(this, partition);
  }

  /** Internal: write a row + refresh its scope-index entries. */
  writeRow(partition: string, table: string, row: StoredRow): void {
    const compiled = this.table(table);
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
    this.db
      .query(
        'DELETE FROM sync_row_scopes WHERE partition=? AND tbl=? AND row_id=?',
      )
      .run(partition, table, row.rowId);
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

  async getHorizonSeq(partition: string): Promise<number> {
    const row = this.db
      .query<{ horizon_seq: number }, [string]>(
        'SELECT horizon_seq FROM sync_partitions WHERE partition=?',
      )
      .get(partition);
    return row?.horizon_seq ?? 0;
  }

  async setHorizonSeq(partition: string, seq: number): Promise<void> {
    this.db
      .query('INSERT OR IGNORE INTO sync_partitions(partition) VALUES (?)')
      .run(partition);
    this.db
      .query('UPDATE sync_partitions SET horizon_seq=? WHERE partition=?')
      .run(seq, partition);
  }

  async pruneCommitsThrough(partition: string, seq: number): Promise<number> {
    const removed = this.db
      .query('DELETE FROM sync_commits WHERE partition=? AND commit_seq<=?')
      .run(partition, seq);
    this.db
      .query('DELETE FROM sync_changes WHERE partition=? AND commit_seq<=?')
      .run(partition, seq);
    this.db
      .query(
        'DELETE FROM sync_change_scopes WHERE partition=? AND commit_seq<=?',
      )
      .run(partition, seq);
    return Number(removed.changes);
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
    assertScopeIndexedScan(query);
    const variables = Object.keys(query.scopeFilter).sort();
    const firstVariable = variables[0];
    if (firstVariable === undefined) return [];
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
          cursor: number;
          subscriptions: string;
          updated_at_ms: number;
        },
        [string, string]
      >(
        'SELECT client_id, actor_id, cursor, subscriptions, updated_at_ms FROM sync_clients WHERE partition=? AND client_id=?',
      )
      .get(partition, clientId);
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
    this.db
      .query(
        'INSERT OR REPLACE INTO sync_clients(partition, client_id, actor_id, cursor, subscriptions, updated_at_ms) VALUES (?,?,?,?,?,?)',
      )
      .run(
        partition,
        record.clientId,
        record.actorId,
        record.cursor,
        JSON.stringify(record.subscriptions),
        record.updatedAtMs,
      );
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

  // -- admin/console read surface (TODO §2.5) --------------------------------

  async listClientRecords(partition: string): Promise<ClientRecord[]> {
    const records = this.db
      .query<
        {
          client_id: string;
          actor_id: string;
          cursor: number;
          subscriptions: string;
          updated_at_ms: number;
        },
        [string]
      >(
        'SELECT client_id, actor_id, cursor, subscriptions, updated_at_ms FROM sync_clients WHERE partition=? ORDER BY updated_at_ms DESC',
      )
      .all(partition);
    return records.map((record) => ({
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
    // Union: the registry row appears on first commit, the client row on
    // first pull — a partition with only one of the two still shows up.
    const rows = this.db
      .query<{ partition: string }, []>(
        `SELECT partition FROM sync_partitions
         UNION SELECT partition FROM sync_clients ORDER BY partition`,
      )
      .all();
    return rows.map((r) => r.partition);
  }
}
