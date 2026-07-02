/**
 * SQLite storage via `bun:sqlite` (dev-speed, dependency-free).
 *
 * Scope fanout is index-first (REVISE B2): both the commit log and the
 * current-row table carry a (table, variable, value) inverted index; reads
 * select candidates from the index and verify the full multi-variable
 * match against the stored scope map — never a log scan.
 */
import { Database } from 'bun:sqlite';
import type { PushOperationResult } from '@syncular-v2/core';
import { syncError } from './errors';
import { matchesEffective } from './scopes';
import type {
  ClientCursorInfo,
  ClientRecord,
  ClientSubscription,
  CommitWindowQuery,
  NewCommit,
  RowScanQuery,
  ServerStorage,
  StorageTransaction,
  StoredChange,
  StoredCommit,
  StoredPushResult,
  StoredRow,
} from './storage';

const DDL = `
CREATE TABLE IF NOT EXISTS sync_partitions(
  partition TEXT PRIMARY KEY,
  max_commit_seq INTEGER NOT NULL DEFAULT 0,
  horizon_seq INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS sync_rows(
  partition TEXT NOT NULL, tbl TEXT NOT NULL, row_id TEXT NOT NULL,
  server_version INTEGER NOT NULL, scopes TEXT NOT NULL, payload BLOB NOT NULL,
  PRIMARY KEY(partition, tbl, row_id)
);
CREATE TABLE IF NOT EXISTS sync_row_scopes(
  partition TEXT NOT NULL, tbl TEXT NOT NULL,
  var TEXT NOT NULL, value TEXT NOT NULL, row_id TEXT NOT NULL,
  PRIMARY KEY(partition, tbl, var, value, row_id)
);
CREATE TABLE IF NOT EXISTS sync_commits(
  partition TEXT NOT NULL, commit_seq INTEGER NOT NULL,
  client_id TEXT NOT NULL, client_commit_id TEXT NOT NULL,
  actor_id TEXT NOT NULL, created_at_ms INTEGER NOT NULL,
  PRIMARY KEY(partition, commit_seq)
);
CREATE TABLE IF NOT EXISTS sync_changes(
  partition TEXT NOT NULL, commit_seq INTEGER NOT NULL, idx INTEGER NOT NULL,
  tbl TEXT NOT NULL, row_id TEXT NOT NULL, op INTEGER NOT NULL,
  row_version INTEGER, scopes TEXT NOT NULL, payload BLOB,
  PRIMARY KEY(partition, commit_seq, idx)
);
CREATE TABLE IF NOT EXISTS sync_change_scopes(
  partition TEXT NOT NULL, tbl TEXT NOT NULL,
  var TEXT NOT NULL, value TEXT NOT NULL, commit_seq INTEGER NOT NULL,
  PRIMARY KEY(partition, tbl, var, value, commit_seq)
);
CREATE TABLE IF NOT EXISTS sync_push_results(
  partition TEXT NOT NULL, client_id TEXT NOT NULL,
  client_commit_id TEXT NOT NULL, result TEXT NOT NULL,
  PRIMARY KEY(partition, client_id, client_commit_id)
);
CREATE TABLE IF NOT EXISTS sync_clients(
  partition TEXT NOT NULL, client_id TEXT NOT NULL, actor_id TEXT NOT NULL,
  cursor INTEGER NOT NULL, subscriptions TEXT NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  PRIMARY KEY(partition, client_id)
);
`;

function toBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64');
}

function fromBase64(text: string): Uint8Array {
  return new Uint8Array(Buffer.from(text, 'base64'));
}

interface SerializedResult {
  opIndex: number;
  status: string;
  code?: string;
  message?: string;
  serverVersion?: number;
  serverRow?: string;
  retryable?: boolean;
}

function serializePushResult(result: StoredPushResult): string {
  return JSON.stringify({
    status: result.status,
    ...(result.commitSeq !== undefined ? { commitSeq: result.commitSeq } : {}),
    results: result.results.map((record) => {
      if (record.status === 'conflict') {
        return {
          opIndex: record.opIndex,
          status: record.status,
          code: record.code,
          message: record.message,
          serverVersion: record.serverVersion,
          serverRow: toBase64(record.serverRow),
        };
      }
      if (record.status === 'error') {
        return {
          opIndex: record.opIndex,
          status: record.status,
          code: record.code,
          message: record.message,
          retryable: record.retryable,
        };
      }
      return { opIndex: record.opIndex, status: record.status };
    }),
  });
}

function deserializePushResult(text: string): StoredPushResult {
  const parsed = JSON.parse(text) as {
    status: 'applied' | 'rejected';
    commitSeq?: number;
    results: SerializedResult[];
  };
  const results: PushOperationResult[] = parsed.results.map((record) => {
    if (record.status === 'conflict') {
      return {
        opIndex: record.opIndex,
        status: 'conflict',
        code: record.code ?? '',
        message: record.message ?? '',
        serverVersion: record.serverVersion ?? 0,
        serverRow: fromBase64(record.serverRow ?? ''),
      };
    }
    if (record.status === 'error') {
      return {
        opIndex: record.opIndex,
        status: 'error',
        code: record.code ?? '',
        message: record.message ?? '',
        retryable: record.retryable ?? false,
      };
    }
    return { opIndex: record.opIndex, status: 'applied' };
  });
  return {
    status: parsed.status,
    ...(parsed.commitSeq !== undefined ? { commitSeq: parsed.commitSeq } : {}),
    results,
  };
}

interface RowRecord {
  row_id: string;
  server_version: number;
  scopes: string;
  payload: Uint8Array;
}

interface ChangeRecord {
  tbl: string;
  row_id: string;
  op: number;
  row_version: number | null;
  scopes: string;
  payload: Uint8Array | null;
}

function toStoredRow(record: RowRecord): StoredRow {
  return {
    rowId: record.row_id,
    serverVersion: record.server_version,
    scopes: JSON.parse(record.scopes) as Record<string, string>,
    payload: new Uint8Array(record.payload),
  };
}

function toStoredChange(record: ChangeRecord): StoredChange {
  return {
    table: record.tbl,
    rowId: record.row_id,
    op: record.op === 1 ? 'upsert' : 'delete',
    ...(record.row_version !== null ? { rowVersion: record.row_version } : {}),
    scopes: JSON.parse(record.scopes) as Record<string, string>,
    ...(record.payload !== null
      ? { payload: new Uint8Array(record.payload) }
      : {}),
  };
}

function placeholders(count: number): string {
  return new Array(count).fill('?').join(',');
}

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
    this.db.exec(DDL);
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

  async pruneCommitsThrough(partition: string, seq: number): Promise<void> {
    this.db
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
      .query<RowRecord, [string, string, string]>(
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
          .query<ChangeRecord, [string, number, string]>(
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
}
