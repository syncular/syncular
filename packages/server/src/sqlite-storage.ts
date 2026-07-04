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
import { matchesEffective } from './scopes';
import {
  deserializePushResult,
  placeholders,
  SQLITE_DDL,
  type SqliteChangeRecord,
  type SqliteRowRecord,
  serializePushResult,
  toStoredChange,
  toStoredRow,
} from './sqlite-dialect';
import type {
  ClientCursorInfo,
  ClientRecord,
  ClientSubscription,
  CommitMetadata,
  CommitMetadataQuery,
  CommitWindowQuery,
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

class SqliteTransaction implements StorageTransaction {
  #storage: SqliteServerStorage;
  #partition: string;
  #open = true;

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

  async upsertRow(table: string, row: StoredRow): Promise<void> {
    this.#assertOpen();
    this.#storage.writeRow(this.#partition, table, row);
  }

  async deleteRow(table: string, rowId: string): Promise<void> {
    this.#assertOpen();
    const db = this.#storage.db;
    db.query(
      'DELETE FROM sync_rows WHERE partition=? AND tbl=? AND row_id=?',
    ).run(this.#partition, table, rowId);
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
        'INSERT OR REPLACE INTO sync_push_results(partition, client_id, client_commit_id, result) VALUES (?,?,?,?)',
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

  constructor(db: Database | string = ':memory:') {
    this.db = typeof db === 'string' ? new Database(db) : db;
    this.db.exec(SQLITE_DDL);
  }

  async begin(partition: string): Promise<StorageTransaction> {
    return new SqliteTransaction(this, partition);
  }

  /** Internal: write a row + refresh its scope-index entries. */
  writeRow(partition: string, table: string, row: StoredRow): void {
    this.db
      .query(
        'INSERT OR REPLACE INTO sync_rows(partition, tbl, row_id, server_version, scopes, payload) VALUES (?,?,?,?,?,?)',
      )
      .run(
        partition,
        table,
        row.rowId,
        row.serverVersion,
        JSON.stringify(row.scopes),
        row.payload,
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
      .query<SqliteRowRecord, [string, string, string]>(
        'SELECT row_id, server_version, scopes, payload FROM sync_rows WHERE partition=? AND tbl=? AND row_id=?',
      )
      .get(partition, table, rowId);
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
    const commits: StoredCommit[] = [];
    let deliveredChanges = 0;
    let afterSeq = query.afterSeq;
    const batchSize = Math.max(64, query.limitChanges);
    while (deliveredChanges < query.limitChanges) {
      // Candidate selection via the inverted index (one variable), exact
      // multi-variable verification against the stored scope map below.
      const candidates = this.db
        .query<{ commit_seq: number }, (string | number)[]>(
          `SELECT DISTINCT commit_seq FROM sync_change_scopes
           WHERE partition=? AND tbl=? AND var=? AND value IN (${placeholders(firstValues.length)})
             AND commit_seq>? AND commit_seq<=?
           ORDER BY commit_seq LIMIT ?`,
        )
        .all(
          partition,
          query.table,
          firstVariable,
          ...firstValues,
          afterSeq,
          query.throughSeq,
          batchSize,
        );
      if (candidates.length === 0) break;
      for (const candidate of candidates) {
        afterSeq = candidate.commit_seq;
        const meta = this.db
          .query<{ actor_id: string; created_at_ms: number }, [string, number]>(
            'SELECT actor_id, created_at_ms FROM sync_commits WHERE partition=? AND commit_seq=?',
          )
          .get(partition, candidate.commit_seq);
        if (meta === null) continue;
        const changeRecords = this.db
          .query<SqliteChangeRecord, [string, number, string]>(
            'SELECT tbl, row_id, op, row_version, scopes, payload FROM sync_changes WHERE partition=? AND commit_seq=? AND tbl=? ORDER BY idx',
          )
          .all(partition, candidate.commit_seq, query.table);
        const changes = changeRecords
          .map(toStoredChange)
          .filter((change) =>
            matchesEffective(change.scopes, query.scopeFilter),
          );
        if (changes.length === 0) continue;
        commits.push({
          commitSeq: candidate.commit_seq,
          createdAtMs: meta.created_at_ms,
          actorId: meta.actor_id,
          changes,
        });
        deliveredChanges += changes.length;
        if (deliveredChanges >= query.limitChanges) break;
      }
      if (candidates.length < batchSize) break;
    }
    return commits;
  }

  async scanRows(partition: string, query: RowScanQuery): Promise<StoredRow[]> {
    const variables = Object.keys(query.scopeFilter).sort();
    const firstVariable = variables[0];
    if (firstVariable === undefined) return [];
    const firstValues = query.scopeFilter[firstVariable] ?? [];
    if (firstValues.length === 0) return [];
    const rows: StoredRow[] = [];
    let afterRowId = query.afterRowId ?? '';
    const batchSize = Math.max(64, query.limit);
    while (rows.length < query.limit) {
      const candidates = this.db
        .query<{ row_id: string }, (string | number)[]>(
          `SELECT DISTINCT row_id FROM sync_row_scopes
           WHERE partition=? AND tbl=? AND var=? AND value IN (${placeholders(firstValues.length)})
             AND row_id>?
           ORDER BY row_id LIMIT ?`,
        )
        .all(
          partition,
          query.table,
          firstVariable,
          ...firstValues,
          afterRowId,
          batchSize,
        );
      if (candidates.length === 0) break;
      for (const candidate of candidates) {
        afterRowId = candidate.row_id;
        const stored = await this.getRow(
          partition,
          query.table,
          candidate.row_id,
        );
        if (stored === undefined) continue;
        if (!matchesEffective(stored.scopes, query.scopeFilter)) continue;
        rows.push(stored);
        if (rows.length >= query.limit) break;
      }
      if (candidates.length < batchSize) break;
    }
    return rows;
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
      const row = this.db
        .query<{ scopes: string }, [string, string, string]>(
          'SELECT scopes FROM sync_rows WHERE partition=? AND tbl=? AND row_id=?',
        )
        .get(partition, ref.tbl, ref.row_id);
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
      .query<
        { server_version: number; scopes: string },
        [string, string, string]
      >(
        'SELECT server_version, scopes FROM sync_rows WHERE partition=? AND tbl=? AND row_id=?',
      )
      .get(partition, table, rowId);
    if (record === null) return undefined;
    return {
      serverVersion: record.server_version,
      scopes: JSON.parse(record.scopes) as Record<string, string>,
    };
  }
}
