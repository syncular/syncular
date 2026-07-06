/**
 * Shared SQLite dialect for the two SQLite-family storages: `bun:sqlite`
 * (synchronous, `SqliteServerStorage`) and Cloudflare D1 (async,
 * `D1ServerStorage`). D1 *is* SQLite — same DDL, same statement grammar,
 * same `?` positional placeholders, same `INSERT OR REPLACE` / `INSERT OR
 * IGNORE` upsert idioms — so the schema and the value (de)serialization are
 * genuinely common ground and live here.
 *
 * What is NOT shared: statement *execution*. `bun:sqlite` is sync
 * (`db.query(sql).get(...)`) and D1 is async (`await
 * db.prepare(sql).bind(...).all()`); a shared execution layer would have to
 * pick one calling convention and adapt the other, which is uglier than two
 * thin storage classes that each speak their driver's native shape while
 * importing the same SQL text and codecs from here (TODO §4.2 judgment
 * call — "clean parallel implementation against the storage contract").
 * Both classes run the identical `test/storage-contract.ts`, so the
 * behavior is held key-for-key regardless.
 */
import type { PushOperationResult, ScopeMap } from '@syncular/core';
import { matchesEffective } from './scopes';
import type {
  StoredChange,
  StoredCommit,
  StoredPushResult,
  StoredRow,
} from './storage';

/**
 * Schema DDL — one statement per `;`-delimited chunk. `bun:sqlite` applies
 * the whole string via `db.exec(SQLITE_DDL)`; D1 applies each statement
 * separately (its `prepare`/`batch` API is one statement per call). Types
 * are SQLite's: `INTEGER`/`TEXT`/`BLOB`. Scopes are stored as JSON `TEXT`
 * (no JSONB on SQLite), payloads as `BLOB`.
 *
 * The inverted scope index carries the ordered column (`commit_seq` /
 * `row_id`) last in the PRIMARY KEY, so the candidate scan is an index
 * range that returns already-ordered rows — the same covering-index shape
 * the Postgres storage documents (§3.1, REVISE B2 performance-by-
 * construction).
 */
export const SQLITE_DDL = `
CREATE TABLE IF NOT EXISTS sync_partitions(
  partition TEXT PRIMARY KEY,
  max_commit_seq INTEGER NOT NULL DEFAULT 0,
  horizon_seq INTEGER NOT NULL DEFAULT 0
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
CREATE INDEX IF NOT EXISTS sync_commits_by_time
  ON sync_commits(partition, created_at_ms);
CREATE TABLE IF NOT EXISTS sync_changes(
  partition TEXT NOT NULL, commit_seq INTEGER NOT NULL, idx INTEGER NOT NULL,
  tbl TEXT NOT NULL, row_id TEXT NOT NULL, op INTEGER NOT NULL,
  row_version INTEGER, scopes TEXT NOT NULL, payload BLOB,
  PRIMARY KEY(partition, commit_seq, idx)
);
CREATE INDEX IF NOT EXISTS sync_changes_by_table
  ON sync_changes(partition, commit_seq, tbl, idx);
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
CREATE TABLE IF NOT EXISTS sync_blob_refs(
  partition TEXT NOT NULL, tbl TEXT NOT NULL, row_id TEXT NOT NULL,
  blob_id TEXT NOT NULL,
  PRIMARY KEY(partition, tbl, row_id, blob_id)
);
CREATE INDEX IF NOT EXISTS sync_blob_refs_by_blob
  ON sync_blob_refs(partition, blob_id);
`;

/** Split the DDL into individual statements (D1 applies them one by one). */
export function sqliteDdlStatements(): string[] {
  return SQLITE_DDL.split(';')
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0);
}

/** `?,?,…` for an `IN (…)` clause of `count` positional parameters. */
export function placeholders(count: number): string {
  return new Array(count).fill('?').join(',');
}

// -- value (de)serialization, shared by both SQLite storages ----------------

/** Runtime-neutral base64 (no `Buffer` — Workers-safe) for push results. */
function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function base64ToBytes(text: string): Uint8Array {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
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

/** Serialize a push result to the JSON `TEXT` stored in `sync_push_results`. */
export function serializePushResult(result: StoredPushResult): string {
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
          serverRow: bytesToBase64(record.serverRow),
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

export function deserializePushResult(text: string): StoredPushResult {
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
        serverRow: base64ToBytes(record.serverRow ?? ''),
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

/** Row-record shape the SQLite `SELECT`s in both storages return. */
export interface SqliteRowRecord {
  row_id: string;
  server_version: number;
  scopes: string;
  payload: Uint8Array;
}

export interface SqliteChangeRecord {
  tbl: string;
  row_id: string;
  op: number;
  row_version: number | null;
  scopes: string;
  payload: Uint8Array | null;
}

/** `bun:sqlite` returns `Uint8Array`; D1 returns `ArrayBuffer` for BLOBs. */
export function asUint8Array(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (Array.isArray(value)) return new Uint8Array(value);
  throw new Error(`expected a BLOB column, got ${typeof value}`);
}

export function toStoredRow(record: SqliteRowRecord): StoredRow {
  return {
    rowId: record.row_id,
    serverVersion: record.server_version,
    scopes: JSON.parse(record.scopes) as Record<string, string>,
    payload: asUint8Array(record.payload),
  };
}

export function toStoredChange(record: SqliteChangeRecord): StoredChange {
  return {
    table: record.tbl,
    rowId: record.row_id,
    op: record.op === 1 ? 'upsert' : 'delete',
    ...(record.row_version !== null ? { rowVersion: record.row_version } : {}),
    scopes: JSON.parse(record.scopes) as Record<string, string>,
    ...(record.payload !== null
      ? { payload: asUint8Array(record.payload) }
      : {}),
  };
}

/**
 * One result row of `commitWindowPageSql` (candidate LEFT JOIN commit meta
 * LEFT JOIN changes): meta/change columns are NULL when the joined row
 * vanished (see the builder's LEFT JOIN contract). `payload` is a BLOB —
 * `bun:sqlite` hands back `Uint8Array`, D1 `ArrayBuffer`; `toStoredChange`
 * normalizes via `asUint8Array`.
 */
export interface SqliteCommitWindowRecord {
  commit_seq: number;
  actor_id: string | null;
  created_at_ms: number | null;
  tbl: string | null;
  row_id: string | null;
  op: number | null;
  row_version: number | null;
  scopes: string | null;
  payload: Uint8Array | null;
}

/**
 * Fold one `commitWindowPageSql` page into commits, preserving the exact
 * semantics of the old per-candidate loop:
 *
 *   - rows arrive ordered (commit_seq, idx); consecutive rows with the same
 *     `commit_seq` are one candidate commit;
 *   - every candidate advances the cursor (`lastSeq`) — including vanished
 *     commits (NULL meta) and commits whose changes all fail the exact
 *     multi-variable scope verification (`matchesEffective`);
 *   - a commit is emitted only with its matching changes, in `idx` order;
 *   - stops after the commit that accumulates at least `remaining` matching
 *     changes (never splitting a commit).
 *
 * `candidateCount` counts the processed candidates so the caller can detect
 * a short page (window exhausted) exactly as it did with the old candidate
 * query.
 */
export function collectCommitWindowPage(
  records: readonly SqliteCommitWindowRecord[],
  scopeFilter: ScopeMap,
  remaining: number,
): {
  commits: StoredCommit[];
  delivered: number;
  lastSeq: number;
  candidateCount: number;
} {
  const commits: StoredCommit[] = [];
  let delivered = 0;
  let lastSeq = 0;
  let candidateCount = 0;
  let i = 0;
  while (i < records.length) {
    const head = records[i];
    if (head === undefined) break;
    const seq = head.commit_seq;
    candidateCount += 1;
    lastSeq = seq;
    const changes: StoredChange[] = [];
    for (; i < records.length; i++) {
      const record = records[i];
      if (record === undefined || record.commit_seq !== seq) break;
      // NULL tbl: a candidate with no change rows for the table (LEFT JOIN
      // contract) — it still advanced the cursor above.
      if (
        record.tbl === null ||
        record.row_id === null ||
        record.op === null ||
        record.scopes === null
      ) {
        continue;
      }
      const change = toStoredChange({
        tbl: record.tbl,
        row_id: record.row_id,
        op: record.op,
        row_version: record.row_version,
        scopes: record.scopes,
        payload: record.payload,
      });
      if (matchesEffective(change.scopes, scopeFilter)) changes.push(change);
    }
    // NULL meta: the commit vanished — cursor advanced, nothing emitted.
    if (head.actor_id === null || head.created_at_ms === null) continue;
    if (changes.length === 0) continue;
    commits.push({
      commitSeq: seq,
      createdAtMs: head.created_at_ms,
      actorId: head.actor_id,
      changes,
    });
    delivered += changes.length;
    if (delivered >= remaining) break;
  }
  return { commits, delivered, lastSeq, candidateCount };
}
