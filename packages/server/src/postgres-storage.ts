/**
 * Postgres server storage — the production database path (TODO §4.1).
 *
 * Semantics mirror `SqliteServerStorage` exactly (both run the shared
 * storage contract in `test/storage-contract.ts`); the difference is that
 * scope fanout MUST survive contact with Postgres. v1's production wound was
 * scan-before-LIMIT here, so (REVISE B2, performance-by-construction):
 *
 *   - both the commit log and the current-row table carry a (table, var,
 *     value) inverted scope index;
 *   - `readCommitWindow`/`scanRows` select candidates through that index
 *     (`sync_change_scopes` / `sync_row_scopes`), ordered + LIMITed at the
 *     index, then verify the full multi-variable match against the stored
 *     scope map — never a log or table scan;
 *   - the candidate indexes are *covering* for their selection: the ordered
 *     column (`commit_seq` / `row_id`) sits in the index key after
 *     (tbl, var, value), so the planner does an index range scan and returns
 *     already-ordered candidates without a heap sort. `test/postgres-explain
 *     .test.ts` asserts an `Index` node (never `Seq Scan`) so the regression
 *     cannot silently return.
 *
 * Storage is written against the `PgExecutor` seam (zero runtime deps); the
 * production driver (Bun.sql / node-postgres) and the test driver (pglite)
 * are wired by the host. See `pg-executor.ts` and the server README.
 *
 * ## commitSeq allocation under concurrency
 *
 * Per-partition `commitSeq` is a dense, gap-free counter (§2.1), allocated
 * inside the push transaction by `UPDATE sync_partitions SET
 * max_commit_seq = max_commit_seq + 1 … RETURNING`. The `UPDATE` takes a
 * row-level write lock on the partition row for the duration of the
 * transaction, so two concurrent pushes to the same partition serialize on
 * that row: the second blocks until the first commits, then reads the
 * advanced counter. This keeps the sequence dense (a Postgres `SEQUENCE`
 * would leave gaps on rollback, which the pull-window arithmetic in §4.5
 * does not tolerate). Cross-partition pushes never contend.
 */
import type { PushOperationResult } from '@syncular/core';
import { syncError } from './errors';
import {
  asBytes,
  asNumber,
  type PgExecutor,
  type PgQueryable,
} from './pg-executor';
import {
  deleteRowSql,
  SCHEMA_META_DDL_POSTGRES,
  schemaDdl,
  selectRowScopesSql,
  selectRowSql,
  upsertSql,
  upsertValues,
} from './relational-rows';
import type { CompiledSchema, CompiledTable } from './schema';
import { matchesEffective } from './scopes';
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
  StoredChange,
  StoredCommit,
  StoredPushResult,
  StoredRow,
} from './storage';

/**
 * Schema DDL. Applied by `PostgresServerStorage.migrate()` (idempotent).
 *
 * Covering index design (the reason this file exists):
 *   - `sync_change_scopes_pk (partition, tbl, var, value, commit_seq)` — the
 *     candidate scan for `readCommitWindow` ranges on the (partition, tbl,
 *     var, value IN …) prefix and returns `commit_seq` already ascending;
 *   - `sync_row_scopes_pk (partition, tbl, var, value, row_id)` — same shape
 *     for `scanRows`, ordered by `row_id`.
 * Both are the PRIMARY KEY, so they are the clustering/covering index for
 * their table. No secondary index is needed for the hot path.
 *
 * Blob reference index (§5.9.4) — parity with the SQLite dialect's
 * `sync_blob_refs`:
 *   - PRIMARY KEY `(partition, tbl, row_id, blob_id)` — the by-row prefix
 *     lets `setBlobRefs` replace a row's set with a single ranged DELETE and
 *     the delete path clear it by (partition, tbl, row_id);
 *   - the secondary `sync_blob_refs_by_blob (partition, blob_id)` index
 *     drives `listRowsReferencingBlob` (the download-authorization candidate
 *     set, §5.9.5) as an index range, never a scan. `postgres-explain
 *     .test.ts` asserts an `Index` node here too.
 */
export const POSTGRES_DDL = `
CREATE TABLE IF NOT EXISTS sync_partitions(
  partition TEXT PRIMARY KEY,
  max_commit_seq BIGINT NOT NULL DEFAULT 0,
  horizon_seq BIGINT NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS sync_row_scopes(
  partition TEXT NOT NULL, tbl TEXT NOT NULL,
  var TEXT NOT NULL, value TEXT NOT NULL, row_id TEXT NOT NULL,
  PRIMARY KEY(partition, tbl, var, value, row_id)
);
CREATE TABLE IF NOT EXISTS sync_commits(
  partition TEXT NOT NULL, commit_seq BIGINT NOT NULL,
  client_id TEXT NOT NULL, client_commit_id TEXT NOT NULL,
  actor_id TEXT NOT NULL, created_at_ms BIGINT NOT NULL,
  PRIMARY KEY(partition, commit_seq)
);
CREATE INDEX IF NOT EXISTS sync_commits_by_time
  ON sync_commits(partition, created_at_ms);
CREATE TABLE IF NOT EXISTS sync_changes(
  partition TEXT NOT NULL, commit_seq BIGINT NOT NULL, idx INTEGER NOT NULL,
  tbl TEXT NOT NULL, row_id TEXT NOT NULL, op SMALLINT NOT NULL,
  row_version BIGINT, scopes JSONB NOT NULL, payload BYTEA,
  PRIMARY KEY(partition, commit_seq, idx)
);
CREATE INDEX IF NOT EXISTS sync_changes_by_table
  ON sync_changes(partition, commit_seq, tbl, idx);
CREATE TABLE IF NOT EXISTS sync_change_scopes(
  partition TEXT NOT NULL, tbl TEXT NOT NULL,
  var TEXT NOT NULL, value TEXT NOT NULL, commit_seq BIGINT NOT NULL,
  PRIMARY KEY(partition, tbl, var, value, commit_seq)
);
CREATE TABLE IF NOT EXISTS sync_push_results(
  partition TEXT NOT NULL, client_id TEXT NOT NULL,
  client_commit_id TEXT NOT NULL, result JSONB NOT NULL,
  PRIMARY KEY(partition, client_id, client_commit_id)
);
CREATE TABLE IF NOT EXISTS sync_clients(
  partition TEXT NOT NULL, client_id TEXT NOT NULL, actor_id TEXT NOT NULL,
  cursor BIGINT NOT NULL, subscriptions JSONB NOT NULL,
  updated_at_ms BIGINT NOT NULL,
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

interface SerializedResult {
  opIndex: number;
  status: string;
  code?: string;
  message?: string;
  serverVersion?: number;
  serverRow?: string;
  retryable?: boolean;
}

function toBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64');
}

function fromBase64(text: string): Uint8Array {
  return new Uint8Array(Buffer.from(text, 'base64'));
}

/**
 * Serialize a push result to a JSON-able object (stored in a JSONB column).
 * `serverRow` bytes are base64-encoded — JSONB cannot hold raw bytes.
 */
function serializePushResult(result: StoredPushResult): unknown {
  return {
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
  };
}

function deserializePushResult(value: unknown): StoredPushResult {
  const parsed = value as {
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

/**
 * Some drivers return a JSONB column already parsed (pglite, node-postgres);
 * accept a string too for defensiveness.
 */
function asJson<T>(value: unknown): T {
  if (typeof value === 'string') return JSON.parse(value) as T;
  return value as T;
}

interface RowRecord {
  row_id: string;
  server_version: unknown;
  scopes: unknown;
  payload: unknown;
}

interface ChangeRecord {
  tbl: string;
  row_id: string;
  op: unknown;
  row_version: unknown;
  scopes: unknown;
  payload: unknown;
}

function toStoredRow(record: RowRecord): StoredRow {
  return {
    rowId: record.row_id,
    serverVersion: asNumber(record.server_version),
    scopes: asJson<Record<string, string>>(record.scopes),
    payload: asBytes(record.payload),
  };
}

function toStoredChange(record: ChangeRecord): StoredChange {
  return {
    table: record.tbl,
    rowId: record.row_id,
    op: asNumber(record.op) === 1 ? 'upsert' : 'delete',
    ...(record.row_version !== null && record.row_version !== undefined
      ? { rowVersion: asNumber(record.row_version) }
      : {}),
    scopes: asJson<Record<string, string>>(record.scopes),
    ...(record.payload !== null && record.payload !== undefined
      ? { payload: asBytes(record.payload) }
      : {}),
  };
}

/** Positional placeholders `$start … $(start+count-1)`. */
function placeholders(start: number, count: number): string {
  const out: string[] = [];
  for (let i = 0; i < count; i++) out.push(`$${start + i}`);
  return out.join(',');
}

/** Shared read/write query logic, parameterized by the queryable in scope. */
async function getRowOn(
  q: PgQueryable,
  compiled: CompiledTable,
  partition: string,
  rowId: string,
): Promise<StoredRow | undefined> {
  const { rows } = await q.query<RowRecord>(
    selectRowSql(compiled, 'postgres'),
    [partition, rowId],
  );
  const record = rows[0];
  return record === undefined ? undefined : toStoredRow(record);
}

async function writeRowOn(
  q: PgQueryable,
  compiled: CompiledTable,
  partition: string,
  row: StoredRow,
): Promise<void> {
  await q.query(
    upsertSql(compiled, 'postgres'),
    upsertValues(compiled, partition, row, 'postgres'),
  );
  await q.query(
    'DELETE FROM sync_row_scopes WHERE partition=$1 AND tbl=$2 AND row_id=$3',
    [partition, compiled.name, row.rowId],
  );
  for (const [variable, value] of Object.entries(row.scopes)) {
    await q.query(
      `INSERT INTO sync_row_scopes(partition, tbl, var, value, row_id)
       VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`,
      [partition, compiled.name, variable, value, row.rowId],
    );
  }
}

class PostgresTransaction implements StorageTransaction {
  #client: PgQueryable;
  #partition: string;
  #resolveTable: (name: string) => CompiledTable;
  #open = true;
  /** Resolves/rejects the `transaction(fn)` wrapper (see `begin`). */
  #resolve: () => void;
  #reject: (error: unknown) => void;

  constructor(
    client: PgQueryable,
    partition: string,
    resolveTable: (name: string) => CompiledTable,
    resolve: () => void,
    reject: (error: unknown) => void,
  ) {
    this.#client = client;
    this.#partition = partition;
    this.#resolveTable = resolveTable;
    this.#resolve = resolve;
    this.#reject = reject;
  }

  #assertOpen(): void {
    if (!this.#open) throw new Error('transaction already finished');
  }

  getRow(table: string, rowId: string): Promise<StoredRow | undefined> {
    this.#assertOpen();
    return getRowOn(
      this.#client,
      this.#resolveTable(table),
      this.#partition,
      rowId,
    );
  }

  async upsertRow(table: string, row: StoredRow): Promise<void> {
    this.#assertOpen();
    await writeRowOn(
      this.#client,
      this.#resolveTable(table),
      this.#partition,
      row,
    );
  }

  async deleteRow(table: string, rowId: string): Promise<void> {
    this.#assertOpen();
    await this.#client.query(
      deleteRowSql(this.#resolveTable(table), 'postgres'),
      [this.#partition, rowId],
    );
    await this.#client.query(
      'DELETE FROM sync_row_scopes WHERE partition=$1 AND tbl=$2 AND row_id=$3',
      [this.#partition, table, rowId],
    );
    // §5.9.4: a deleted row references no blobs.
    await this.#client.query(
      'DELETE FROM sync_blob_refs WHERE partition=$1 AND tbl=$2 AND row_id=$3',
      [this.#partition, table, rowId],
    );
  }

  async setBlobRefs(
    table: string,
    rowId: string,
    blobIds: readonly string[],
  ): Promise<void> {
    this.#assertOpen();
    // Replace the row's reference set atomically inside the commit tx (§5.9.4).
    await this.#client.query(
      'DELETE FROM sync_blob_refs WHERE partition=$1 AND tbl=$2 AND row_id=$3',
      [this.#partition, table, rowId],
    );
    for (const blobId of blobIds) {
      await this.#client.query(
        `INSERT INTO sync_blob_refs(partition, tbl, row_id, blob_id)
         VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING`,
        [this.#partition, table, rowId, blobId],
      );
    }
  }

  async appendCommit(commit: NewCommit): Promise<number> {
    this.#assertOpen();
    const q = this.#client;
    const p = this.#partition;
    // Allocate the next dense commitSeq under a per-partition row lock: the
    // UPDATE … RETURNING serializes concurrent pushes to this partition and
    // never leaves a gap on rollback (see the file header).
    const { rows } = await q.query<{ max_commit_seq: unknown }>(
      `INSERT INTO sync_partitions(partition, max_commit_seq) VALUES ($1, 1)
       ON CONFLICT (partition) DO UPDATE
         SET max_commit_seq = sync_partitions.max_commit_seq + 1
       RETURNING max_commit_seq`,
      [p],
    );
    const commitSeq = asNumber(rows[0]?.max_commit_seq);
    await q.query(
      `INSERT INTO sync_commits(partition, commit_seq, client_id, client_commit_id, actor_id, created_at_ms)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [
        p,
        commitSeq,
        commit.clientId,
        commit.clientCommitId,
        commit.actorId,
        commit.createdAtMs,
      ],
    );
    for (let idx = 0; idx < commit.changes.length; idx++) {
      const change = commit.changes[idx];
      if (change === undefined) continue;
      await q.query(
        `INSERT INTO sync_changes(partition, commit_seq, idx, tbl, row_id, op, row_version, scopes, payload)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
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
        await q.query(
          `INSERT INTO sync_change_scopes(partition, tbl, var, value, commit_seq)
           VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`,
          [p, change.table, variable, value, commitSeq],
        );
      }
    }
    return commitSeq;
  }

  async putPushResult(
    clientId: string,
    clientCommitId: string,
    result: StoredPushResult,
  ): Promise<void> {
    this.#assertOpen();
    await this.#client.query(
      `INSERT INTO sync_push_results(partition, client_id, client_commit_id, result)
       VALUES ($1,$2,$3,$4)
       ON CONFLICT (partition, client_id, client_commit_id) DO UPDATE
         SET result=EXCLUDED.result`,
      [
        this.#partition,
        clientId,
        clientCommitId,
        JSON.stringify(serializePushResult(result)),
      ],
    );
  }

  async commit(): Promise<void> {
    this.#assertOpen();
    this.#open = false;
    // Signal the transaction wrapper to COMMIT; wait for it to actually land.
    this.#resolve();
    await this.#done;
  }

  async rollback(): Promise<void> {
    if (!this.#open) return;
    this.#open = false;
    this.#reject(new RollbackSignal());
    // Swallow — a rollback is a normal outcome, not an error to the caller.
    await this.#done.catch(() => {});
  }

  /** Set by `begin`: resolves when BEGIN…COMMIT/ROLLBACK has fully landed. */
  #done!: Promise<void>;
  _attachDone(done: Promise<void>): void {
    this.#done = done;
  }
}

/** Internal marker: a caller-requested rollback, not a real failure. */
class RollbackSignal extends Error {
  constructor() {
    super('rollback');
    this.name = 'RollbackSignal';
  }
}

export class PostgresServerStorage implements ServerStorage {
  readonly #exec: PgExecutor;
  /** Set by `ensureSchema`: app-table lookup for the relational row store. */
  #tables: ReadonlyMap<string, CompiledTable> | undefined;
  #schemaVersion: number | undefined;

  constructor(exec: PgExecutor) {
    this.#exec = exec;
  }

  /** Apply the schema DDL (idempotent). Call once before use. */
  async migrate(): Promise<void> {
    // Split on the statement boundary so drivers that reject multi-statement
    // query strings (node-postgres extended protocol) still apply each DDL.
    const statements = POSTGRES_DDL.split(';')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    for (const statement of statements) {
      await this.#exec.query(statement);
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
    // Memoized fast path: same instance, same schema version.
    if (this.#schemaVersion === schema.version) return;
    await this.migrate();
    await this.#exec.query(SCHEMA_META_DDL_POSTGRES);
    const marker = await this.#exec.query<{ schema_version: unknown }>(
      'SELECT schema_version FROM sync_schema_meta WHERE id=1',
    );
    const stored =
      marker.rows[0] === undefined
        ? undefined
        : asNumber(marker.rows[0].schema_version);
    if (stored !== undefined && stored > schema.version) {
      throw new Error(
        `stored schema version ${stored} is newer than the configured schema (${schema.version}) — refusing to run an older server against a migrated database`,
      );
    }
    if (stored === undefined || stored < schema.version) {
      // Introspect existing app tables, then apply the migration subset
      // (CREATE TABLE / ADD COLUMN / CREATE INDEX) inside one transaction
      // (Postgres DDL is transactional — a failed bump leaves no half-state).
      await this.#exec.transaction(async (client) => {
        const existing = new Map<string, ReadonlySet<string>>();
        for (const table of schema.tables.values()) {
          const { rows } = await client.query<{ column_name: string }>(
            `SELECT column_name FROM information_schema.columns
             WHERE table_schema = current_schema() AND table_name = $1`,
            [table.name],
          );
          if (rows.length > 0) {
            existing.set(table.name, new Set(rows.map((r) => r.column_name)));
          }
        }
        for (const statement of schemaDdl(schema, existing, 'postgres')) {
          await client.query(statement);
        }
        await client.query(
          `INSERT INTO sync_schema_meta(id, schema_version) VALUES (1, $1)
           ON CONFLICT (id) DO UPDATE SET schema_version=EXCLUDED.schema_version`,
          [schema.version],
        );
      });
    }
    this.#tables = schema.tables;
    this.#schemaVersion = schema.version;
  }

  /**
   * Open a real Postgres transaction. The push handler drives the returned
   * `StorageTransaction` imperatively (getRow/upsert/…/commit), but the
   * driver seam models a transaction as a callback scope. We bridge the two:
   * `transaction(fn)` blocks inside `fn` on a promise that the imperative
   * `commit()`/`rollback()` resolves/rejects, so BEGIN…COMMIT wraps exactly
   * the handler's writes on one pinned connection.
   */
  async begin(partition: string): Promise<StorageTransaction> {
    let resolveReady!: (tx: PostgresTransaction) => void;
    const ready = new Promise<PostgresTransaction>((r) => {
      resolveReady = r;
    });
    let resolveScope!: () => void;
    let rejectScope!: (error: unknown) => void;
    const scope = new Promise<void>((res, rej) => {
      resolveScope = res;
      rejectScope = rej;
    });
    const done = this.#exec
      .transaction(async (client) => {
        const tx = new PostgresTransaction(
          client,
          partition,
          (name) => this.table(name),
          resolveScope,
          rejectScope,
        );
        resolveReady(tx);
        // Hold the transaction open until commit()/rollback() settles `scope`.
        await scope;
      })
      .catch((error: unknown) => {
        if (error instanceof RollbackSignal) return;
        throw error;
      });
    const tx = await ready;
    tx._attachDone(done);
    return tx;
  }

  async getMaxCommitSeq(partition: string): Promise<number> {
    const { rows } = await this.#exec.query<{ max_commit_seq: unknown }>(
      'SELECT max_commit_seq FROM sync_partitions WHERE partition=$1',
      [partition],
    );
    return rows[0] === undefined ? 0 : asNumber(rows[0].max_commit_seq);
  }

  async getHorizonSeq(partition: string): Promise<number> {
    const { rows } = await this.#exec.query<{ horizon_seq: unknown }>(
      'SELECT horizon_seq FROM sync_partitions WHERE partition=$1',
      [partition],
    );
    return rows[0] === undefined ? 0 : asNumber(rows[0].horizon_seq);
  }

  async setHorizonSeq(partition: string, seq: number): Promise<void> {
    await this.#exec.query(
      `INSERT INTO sync_partitions(partition, horizon_seq) VALUES ($1,$2)
       ON CONFLICT (partition) DO UPDATE SET horizon_seq=EXCLUDED.horizon_seq`,
      [partition, seq],
    );
  }

  async pruneCommitsThrough(partition: string, seq: number): Promise<number> {
    const removed = await this.#exec.query(
      'DELETE FROM sync_commits WHERE partition=$1 AND commit_seq<=$2',
      [partition, seq],
    );
    await this.#exec.query(
      'DELETE FROM sync_changes WHERE partition=$1 AND commit_seq<=$2',
      [partition, seq],
    );
    await this.#exec.query(
      'DELETE FROM sync_change_scopes WHERE partition=$1 AND commit_seq<=$2',
      [partition, seq],
    );
    return removed.rowCount;
  }

  async getCommitSeqBefore(
    partition: string,
    createdBeforeMs: number,
  ): Promise<number> {
    const { rows } = await this.#exec.query<{ seq: unknown }>(
      'SELECT max(commit_seq) AS seq FROM sync_commits WHERE partition=$1 AND created_at_ms<$2',
      [partition, createdBeforeMs],
    );
    const seq = rows[0]?.seq;
    return seq === null || seq === undefined ? 0 : asNumber(seq);
  }

  getRow(
    partition: string,
    table: string,
    rowId: string,
  ): Promise<StoredRow | undefined> {
    return getRowOn(this.#exec, this.table(table), partition, rowId);
  }

  async getPushResult(
    partition: string,
    clientId: string,
    clientCommitId: string,
  ): Promise<StoredPushResult | undefined> {
    const { rows } = await this.#exec.query<{ result: unknown }>(
      'SELECT result FROM sync_push_results WHERE partition=$1 AND client_id=$2 AND client_commit_id=$3',
      [partition, clientId, clientCommitId],
    );
    if (rows[0] === undefined) return undefined;
    try {
      return deserializePushResult(asJson(rows[0].result));
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
      // Candidate selection via the inverted index (one variable): the
      // (partition, tbl, var, value, commit_seq) PK makes this an index range
      // scan returning commit_seq already ascending (see postgres-explain
      // .test.ts). Exact multi-variable verification happens below.
      const params: unknown[] = [partition, query.table, firstVariable];
      const valuePlaceholders = placeholders(4, firstValues.length);
      params.push(...firstValues);
      const afterParam = params.length + 1;
      const throughParam = params.length + 2;
      const limitParam = params.length + 3;
      params.push(afterSeq, query.throughSeq, batchSize);
      const { rows: candidates } = await this.#exec.query<{
        commit_seq: unknown;
      }>(
        `SELECT DISTINCT commit_seq FROM sync_change_scopes
         WHERE partition=$1 AND tbl=$2 AND var=$3 AND value IN (${valuePlaceholders})
           AND commit_seq>$${afterParam} AND commit_seq<=$${throughParam}
         ORDER BY commit_seq LIMIT $${limitParam}`,
        params,
      );
      if (candidates.length === 0) break;
      for (const candidate of candidates) {
        const commitSeq = asNumber(candidate.commit_seq);
        afterSeq = commitSeq;
        const { rows: metaRows } = await this.#exec.query<{
          actor_id: string;
          created_at_ms: unknown;
        }>(
          'SELECT actor_id, created_at_ms FROM sync_commits WHERE partition=$1 AND commit_seq=$2',
          [partition, commitSeq],
        );
        const meta = metaRows[0];
        if (meta === undefined) continue;
        const { rows: changeRecords } = await this.#exec.query<ChangeRecord>(
          'SELECT tbl, row_id, op, row_version, scopes, payload FROM sync_changes WHERE partition=$1 AND commit_seq=$2 AND tbl=$3 ORDER BY idx',
          [partition, commitSeq, query.table],
        );
        const changes = changeRecords
          .map(toStoredChange)
          .filter((change) =>
            matchesEffective(change.scopes, query.scopeFilter),
          );
        if (changes.length === 0) continue;
        commits.push({
          commitSeq,
          createdAtMs: asNumber(meta.created_at_ms),
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
      const params: unknown[] = [partition, query.table, firstVariable];
      const valuePlaceholders = placeholders(4, firstValues.length);
      params.push(...firstValues);
      const afterParam = params.length + 1;
      const limitParam = params.length + 2;
      params.push(afterRowId, batchSize);
      const { rows: candidates } = await this.#exec.query<{ row_id: string }>(
        `SELECT DISTINCT row_id FROM sync_row_scopes
         WHERE partition=$1 AND tbl=$2 AND var=$3 AND value IN (${valuePlaceholders})
           AND row_id>$${afterParam}
         ORDER BY row_id LIMIT $${limitParam}`,
        params,
      );
      if (candidates.length === 0) break;
      for (const candidate of candidates) {
        afterRowId = candidate.row_id;
        const stored = await getRowOn(
          this.#exec,
          this.table(query.table),
          partition,
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
    const { rows } = await this.#exec.query<{
      client_id: string;
      actor_id: string;
      cursor: unknown;
      subscriptions: unknown;
      updated_at_ms: unknown;
    }>(
      'SELECT client_id, actor_id, cursor, subscriptions, updated_at_ms FROM sync_clients WHERE partition=$1 AND client_id=$2',
      [partition, clientId],
    );
    const record = rows[0];
    if (record === undefined) return undefined;
    return {
      clientId: record.client_id,
      actorId: record.actor_id,
      cursor: asNumber(record.cursor),
      updatedAtMs: asNumber(record.updated_at_ms),
      subscriptions: asJson<ClientSubscription[]>(record.subscriptions),
    };
  }

  async putClientRecord(
    partition: string,
    record: ClientRecord,
  ): Promise<void> {
    await this.#exec.query(
      `INSERT INTO sync_clients(partition, client_id, actor_id, cursor, subscriptions, updated_at_ms)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (partition, client_id) DO UPDATE
         SET actor_id=EXCLUDED.actor_id, cursor=EXCLUDED.cursor,
             subscriptions=EXCLUDED.subscriptions,
             updated_at_ms=EXCLUDED.updated_at_ms`,
      [
        partition,
        record.clientId,
        record.actorId,
        record.cursor,
        JSON.stringify(record.subscriptions),
        record.updatedAtMs,
      ],
    );
  }

  async listClientCursors(partition: string): Promise<ClientCursorInfo[]> {
    const { rows } = await this.#exec.query<{
      client_id: string;
      cursor: unknown;
      updated_at_ms: unknown;
    }>(
      'SELECT client_id, cursor, updated_at_ms FROM sync_clients WHERE partition=$1',
      [partition],
    );
    return rows.map((r) => ({
      clientId: r.client_id,
      cursor: asNumber(r.cursor),
      updatedAtMs: asNumber(r.updated_at_ms),
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
    const { rows: refs } = await this.#exec.query<{
      tbl: string;
      row_id: string;
    }>(
      'SELECT tbl, row_id FROM sync_blob_refs WHERE partition=$1 AND blob_id=$2',
      [partition, blobId],
    );
    const out: {
      table: string;
      rowId: string;
      scopes: Record<string, string>;
    }[] = [];
    for (const ref of refs) {
      const compiled = this.#tables?.get(ref.tbl);
      if (compiled === undefined) continue; // table no longer in the schema
      const { rows } = await this.#exec.query<{ scopes: unknown }>(
        selectRowScopesSql(compiled, 'postgres'),
        [partition, ref.row_id],
      );
      const row = rows[0];
      if (row === undefined) continue;
      out.push({
        table: ref.tbl,
        rowId: ref.row_id,
        scopes: asJson<Record<string, string>>(row.scopes),
      });
    }
    return out;
  }

  async listReferencedBlobIds(partition: string): Promise<string[]> {
    const { rows } = await this.#exec.query<{ blob_id: string }>(
      'SELECT DISTINCT blob_id FROM sync_blob_refs WHERE partition=$1',
      [partition],
    );
    return rows.map((r) => r.blob_id);
  }

  // -- admin/console read surface (TODO §2.5) --------------------------------

  async listClientRecords(partition: string): Promise<ClientRecord[]> {
    const { rows } = await this.#exec.query<{
      client_id: string;
      actor_id: string;
      cursor: unknown;
      subscriptions: unknown;
      updated_at_ms: unknown;
    }>(
      'SELECT client_id, actor_id, cursor, subscriptions, updated_at_ms FROM sync_clients WHERE partition=$1 ORDER BY updated_at_ms DESC',
      [partition],
    );
    return rows.map((r) => ({
      clientId: r.client_id,
      actorId: r.actor_id,
      cursor: asNumber(r.cursor),
      updatedAtMs: asNumber(r.updated_at_ms),
      subscriptions: (typeof r.subscriptions === 'string'
        ? JSON.parse(r.subscriptions)
        : r.subscriptions) as ClientSubscription[],
    }));
  }

  async listCommitMetadata(
    partition: string,
    query: CommitMetadataQuery,
  ): Promise<CommitMetadata[]> {
    const { rows } = query.table
      ? await this.#exec.query<{
          commit_seq: unknown;
          client_id: string;
          client_commit_id: string;
          actor_id: string;
          created_at_ms: unknown;
        }>(
          `SELECT c.commit_seq, c.client_id, c.client_commit_id, c.actor_id, c.created_at_ms
           FROM sync_commits c
           WHERE c.partition=$1 AND c.commit_seq>$2
             AND EXISTS (SELECT 1 FROM sync_changes ch
               WHERE ch.partition=c.partition AND ch.commit_seq=c.commit_seq AND ch.tbl=$3)
           ORDER BY c.commit_seq DESC LIMIT $4`,
          [partition, query.afterSeq, query.table, query.limit],
        )
      : await this.#exec.query<{
          commit_seq: unknown;
          client_id: string;
          client_commit_id: string;
          actor_id: string;
          created_at_ms: unknown;
        }>(
          `SELECT commit_seq, client_id, client_commit_id, actor_id, created_at_ms
           FROM sync_commits
           WHERE partition=$1 AND commit_seq>$2
           ORDER BY commit_seq DESC LIMIT $3`,
          [partition, query.afterSeq, query.limit],
        );
    const out: CommitMetadata[] = [];
    for (const row of rows) {
      const commitSeq = asNumber(row.commit_seq);
      const changes = await this.#exec.query<{ tbl: string; n: unknown }>(
        'SELECT tbl, count(*) AS n FROM sync_changes WHERE partition=$1 AND commit_seq=$2 GROUP BY tbl',
        [partition, commitSeq],
      );
      out.push({
        commitSeq,
        clientId: row.client_id,
        clientCommitId: row.client_commit_id,
        actorId: row.actor_id,
        createdAtMs: asNumber(row.created_at_ms),
        changeCount: changes.rows.reduce((sum, c) => sum + asNumber(c.n), 0),
        tables: changes.rows.map((c) => c.tbl),
      });
    }
    return out;
  }

  async scopeActivity(
    partition: string,
    query: ScopeActivityQuery,
  ): Promise<ScopeCommitActivity[]> {
    const { rows } = await this.#exec.query<{
      commit_seq: unknown;
      tbl: string;
    }>(
      `SELECT DISTINCT commit_seq, tbl FROM sync_change_scopes
       WHERE partition=$1 AND var=$2 AND value=$3
       ORDER BY commit_seq DESC LIMIT $4`,
      [partition, query.variable, query.value, query.limit],
    );
    const out: ScopeCommitActivity[] = [];
    for (const row of rows) {
      const commitSeq = asNumber(row.commit_seq);
      const meta = await this.#exec.query<{
        actor_id: string;
        created_at_ms: unknown;
      }>(
        'SELECT actor_id, created_at_ms FROM sync_commits WHERE partition=$1 AND commit_seq=$2',
        [partition, commitSeq],
      );
      const metaRow = meta.rows[0];
      if (metaRow === undefined) continue;
      const count = await this.#exec.query<{ n: unknown }>(
        'SELECT count(*) AS n FROM sync_changes WHERE partition=$1 AND commit_seq=$2 AND tbl=$3',
        [partition, commitSeq, row.tbl],
      );
      out.push({
        commitSeq,
        table: row.tbl,
        createdAtMs: asNumber(metaRow.created_at_ms),
        actorId: metaRow.actor_id,
        changeCount:
          count.rows[0] === undefined ? 0 : asNumber(count.rows[0].n),
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
    const { rows } = await this.#exec.query<{
      server_version: unknown;
      scopes: unknown;
    }>(selectRowScopesSql(this.table(table), 'postgres'), [partition, rowId]);
    const row = rows[0];
    if (row === undefined) return undefined;
    return {
      serverVersion: asNumber(row.server_version),
      scopes: (typeof row.scopes === 'string'
        ? JSON.parse(row.scopes)
        : row.scopes) as Record<string, string>,
    };
  }
}
