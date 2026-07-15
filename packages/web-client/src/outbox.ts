/**
 * The durable outbox (SPEC.md §7.1) with encode-at-send (the §0 binary-push
 * outbox rule): local mutations are persisted in a schema-agnostic JSON
 * form and encoded with the *current* generated row codec only when a push
 * request is built — a commit recorded under schema N replays after an
 * upgrade to N+1 by re-encoding.
 */
import {
  encodeRow,
  type PushCommitFrame,
  type PushOperation,
  type ScopeMap,
} from '@syncular/core';
import type { ClientDatabase } from './database';
import type { EncryptionConfig } from './encryption';
import { ClientSyncError } from './errors';
import {
  type CompiledClientSchema,
  type CompiledClientTable,
  type JsonRowValue,
  jsonToRowValue,
} from './schema';

export interface OutboxOperation {
  readonly table: string;
  readonly rowId: string;
  readonly op: 'upsert' | 'delete';
  /** Optimistic-concurrency token (§6.2); absent = last-write-wins. */
  readonly baseVersion?: number;
  /** Full-row values keyed by column name; present iff `op` is `upsert`. */
  readonly values?: Readonly<Record<string, JsonRowValue>>;
  /**
   * Local-only normalized columns intentionally supplied to `patch()`.
   * Absent for full-row mutate/upsert because intent is then unknown.
   */
  readonly changedFields?: readonly string[];
}

export interface OutboxCommit {
  readonly seq: number;
  readonly clientCommitId: string;
  readonly createdAtMs: number;
  readonly operations: readonly OutboxOperation[];
}

/** Protected local rollback image; never encoded or exposed in outcomes. */
export interface OutboxBeforeImage {
  readonly opIndex: number;
  readonly existed: boolean;
  readonly syncVersion?: number;
  readonly values?: Readonly<Record<string, JsonRowValue>>;
}

export function appendOutboxCommit(
  db: ClientDatabase,
  clientCommitId: string,
  operations: readonly OutboxOperation[],
  nowMs: number,
  beforeImages: readonly OutboxBeforeImage[] = [],
): void {
  if (operations.length === 0) {
    throw new ClientSyncError(
      'sync.empty_commit',
      'a local commit must carry at least one operation (§6.1)',
    );
  }
  db.exec(
    `INSERT INTO _syncular_outbox(client_commit_id, created_at_ms, operations)
     VALUES (?, ?, ?)`,
    [clientCommitId, nowMs, JSON.stringify(operations)],
  );
  for (const image of beforeImages) {
    db.exec(
      `INSERT INTO _syncular_outbox_before_images(
         client_commit_id, op_index, existed, sync_version, values_json
       ) VALUES (?, ?, ?, ?, ?)`,
      [
        clientCommitId,
        image.opIndex,
        image.existed ? 1 : 0,
        image.syncVersion ?? null,
        image.values === undefined ? null : JSON.stringify(image.values),
      ],
    );
  }
}

/** Pending commits in FIFO creation order (§7.1). */
export function listOutbox(db: ClientDatabase): OutboxCommit[] {
  return db
    .query(
      `SELECT seq, client_commit_id, created_at_ms, operations
       FROM _syncular_outbox ORDER BY seq ASC`,
    )
    .map((row) => ({
      seq: row.seq as number,
      clientCommitId: row.client_commit_id as string,
      createdAtMs: row.created_at_ms as number,
      operations: JSON.parse(row.operations as string) as OutboxOperation[],
    }));
}

export function deleteOutboxCommit(
  db: ClientDatabase,
  clientCommitId: string,
): void {
  db.exec(
    'DELETE FROM _syncular_outbox_before_images WHERE client_commit_id = ?',
    [clientCommitId],
  );
  db.exec('DELETE FROM _syncular_outbox WHERE client_commit_id = ?', [
    clientCommitId,
  ]);
}

export function listOutboxBeforeImages(
  db: ClientDatabase,
  clientCommitId: string,
): OutboxBeforeImage[] {
  return db
    .query(
      `SELECT op_index, existed, sync_version, values_json
         FROM _syncular_outbox_before_images
        WHERE client_commit_id = ? ORDER BY op_index`,
      [clientCommitId],
    )
    .map((row) => ({
      opIndex: row.op_index as number,
      existed: row.existed === 1,
      ...(typeof row.sync_version === 'number'
        ? { syncVersion: row.sync_version }
        : {}),
      ...(typeof row.values_json === 'string'
        ? {
            values: JSON.parse(row.values_json) as Readonly<
              Record<string, JsonRowValue>
            >,
          }
        : {}),
    }));
}

export function replaceOutboxBeforeImages(
  db: ClientDatabase,
  clientCommitId: string,
  replacements: readonly OutboxBeforeImage[],
): void {
  for (const image of replacements) {
    db.exec(
      `DELETE FROM _syncular_outbox_before_images
        WHERE client_commit_id = ? AND op_index = ?`,
      [clientCommitId, image.opIndex],
    );
    db.exec(
      `INSERT INTO _syncular_outbox_before_images(
         client_commit_id, op_index, existed, sync_version, values_json
       ) VALUES (?, ?, ?, ?, ?)`,
      [
        clientCommitId,
        image.opIndex,
        image.existed ? 1 : 0,
        image.syncVersion ?? null,
        image.values === undefined ? null : JSON.stringify(image.values),
      ],
    );
  }
}

/**
 * §7.4.4: after a schema bump, a persisted upsert may name a column the new
 * schema no longer has. The value has nowhere to go and there is no
 * migration — surface it as `sync.outbox_incompatible` (client-local, §10.3)
 * so the caller can drop the commit through the rejection channel.
 */
export class OutboxEncodeError extends ClientSyncError {
  constructor(message: string) {
    super('sync.outbox_incompatible', message, false);
  }
}

function orderedValues(
  table: CompiledClientTable,
  values: Readonly<Record<string, JsonRowValue>>,
) {
  // Any persisted key that is not a column of the CURRENT schema means the
  // bump removed (or renamed) it — the commit cannot be expressed now.
  for (const key of Object.keys(values)) {
    if (!table.columnIndex.has(key)) {
      throw new OutboxEncodeError(
        `outbox commit references column ${JSON.stringify(key)} on ${JSON.stringify(table.name)}, which the current schema no longer has (§7.4.4)`,
      );
    }
  }
  return table.columns.map((column) => {
    const value = values[column.name];
    if (value === undefined) return null;
    return jsonToRowValue(value);
  });
}

/**
 * Encode one outbox commit as a `PUSH_COMMIT` frame with the current
 * schema's row codec (§6.1). When `encryption` is configured, encrypted
 * columns (§5.11) are encrypted here — the encode-at-send seam — before the
 * row codec serializes them as ciphertext-envelope `bytes`. Async because
 * WebCrypto is async.
 */
export async function encodeOutboxCommit(
  schema: CompiledClientSchema,
  commit: OutboxCommit,
  encryption?: EncryptionConfig,
): Promise<PushCommitFrame> {
  const operations: PushOperation[] = [];
  for (const op of commit.operations) {
    if (op.op === 'delete') {
      operations.push({
        table: op.table,
        rowId: op.rowId,
        op: 'delete',
        ...(op.baseVersion !== undefined
          ? { baseVersion: op.baseVersion }
          : {}),
      });
      continue;
    }
    const table = schema.tables.get(op.table);
    if (table === undefined) {
      // §7.4.4: the bump removed this table — the commit cannot be encoded.
      throw new OutboxEncodeError(
        `outbox commit ${commit.clientCommitId} targets table ${JSON.stringify(op.table)}, which the current schema no longer has (§7.4.4)`,
      );
    }
    if (op.values === undefined) {
      throw new ClientSyncError(
        'sync.invalid_request',
        `outbox upsert on ${op.table}/${op.rowId} has no values`,
      );
    }
    let values = orderedValues(table, op.values);
    if (encryption !== undefined && table.hasEncryptedColumns) {
      // Lazy: opt-in E2EE never enters an encryption-free app's bundle.
      const { encryptRowValues } = await import('./encryption');
      values = await encryptRowValues(encryption, table, op.rowId, values);
    }
    operations.push({
      table: op.table,
      rowId: op.rowId,
      op: 'upsert',
      ...(op.baseVersion !== undefined ? { baseVersion: op.baseVersion } : {}),
      payload: encodeRow(table.columns, values),
    });
  }
  return {
    type: 'PUSH_COMMIT',
    clientCommitId: commit.clientCommitId,
    operations,
  };
}

/**
 * §3.3: drop pending commits that write into a revoked scope instead of
 * replaying them into guaranteed rejections. A whole commit is dropped when
 * any of its upserts provably lands in the revoked effective scopes —
 * commits are atomic and their content is pinned by the idempotency key,
 * so ops are never removed individually. Returns dropped commit ids.
 */
export function dropOutboxCommitsInScope(
  db: ClientDatabase,
  table: CompiledClientTable,
  effective: ScopeMap,
): string[] {
  const entries = Object.entries(effective);
  if (entries.length === 0) return [];
  const dropped: string[] = [];
  for (const commit of listOutbox(db)) {
    const inScope = commit.operations.some((op) => {
      if (op.table !== table.name || op.values === undefined) return false;
      return entries.every(([variable, values]) => {
        const column = table.scopeColumnByVariable.get(variable);
        if (column === undefined) return false;
        const value = op.values?.[column];
        return typeof value === 'string' && values.includes(value);
      });
    });
    if (inScope) {
      deleteOutboxCommit(db, commit.clientCommitId);
      dropped.push(commit.clientCommitId);
    }
  }
  return dropped;
}
