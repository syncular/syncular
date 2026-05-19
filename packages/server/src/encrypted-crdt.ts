import type {
  BinarySnapshotColumn,
  BinarySnapshotRowsEncoder,
  ScopePattern,
  ScopeValues,
  StoredScopes,
  SyncOperation,
} from '@syncular/core';
import { BinarySnapshotTableWriter } from '@syncular/core';
import { sql } from 'kysely';
import { parseScopes } from './dialect/helpers';
import type { DbExecutor } from './dialect/types';
import type {
  ApplyOperationResult,
  EmittedChange,
  ServerApplyOperationContext,
  ServerSnapshotContext,
  ServerTableHandler,
  SyncServerAuth,
} from './handlers/types';
import type { SyncCoreDb } from './schema';

export const SYNC_CRDT_UPDATES_TABLE = 'sync_crdt_updates';
export const SYNC_CRDT_CHECKPOINTS_TABLE = 'sync_crdt_checkpoints';

type SystemTableName =
  | typeof SYNC_CRDT_UPDATES_TABLE
  | typeof SYNC_CRDT_CHECKPOINTS_TABLE;

type RequiredStringField =
  | 'stream_id'
  | 'app_table'
  | 'row_id'
  | 'field_name'
  | 'key_id'
  | 'ciphertext';

export interface EncryptedCrdtSystemHandlersOptions<
  DB extends SyncCoreDb = SyncCoreDb,
  Auth extends SyncServerAuth = SyncServerAuth,
> {
  scopePatterns?: ScopePattern[];
  resolveScopes: (ctx: {
    db: DbExecutor<DB>;
    actorId: string;
    auth: Auth;
  }) => Promise<ScopeValues> | ScopeValues;
  authorizeUpdate?: (args: {
    ctx: ServerApplyOperationContext<DB, Auth>;
    row: EncryptedCrdtUpdateRow;
  }) => Promise<boolean> | boolean;
  authorizeCheckpoint?: (args: {
    ctx: ServerApplyOperationContext<DB, Auth>;
    row: EncryptedCrdtCheckpointRow;
  }) => Promise<boolean> | boolean;
}

export interface EncryptedCrdtUpdateRow {
  partition_id: string;
  stream_id: string;
  app_table: string;
  row_id: string;
  field_name: string;
  update_id: string;
  actor_id: string | null;
  client_id: string | null;
  key_id: string;
  ciphertext: string;
  scopes: StoredScopes;
}

export interface EncryptedCrdtCheckpointRow {
  partition_id: string;
  stream_id: string;
  app_table: string;
  row_id: string;
  field_name: string;
  checkpoint_id: string;
  covers_seq: number;
  actor_id: string | null;
  client_id: string | null;
  key_id: string;
  ciphertext: string;
  scopes: StoredScopes;
}

export interface EncryptedCrdtPruneOptions {
  partitionId?: string;
  streamId?: string;
  pruneCoveredUpdates?: boolean;
  maxCheckpointsPerStream?: number;
}

export interface EncryptedCrdtPruneReport {
  updatesDeleted: number;
  checkpointsDeleted: number;
}

const CRDT_UPDATE_BINARY_COLUMNS = [
  { name: 'seq', type: 'integer' },
  { name: 'partition_id', type: 'string' },
  { name: 'stream_id', type: 'string' },
  { name: 'app_table', type: 'string' },
  { name: 'row_id', type: 'string' },
  { name: 'field_name', type: 'string' },
  { name: 'update_id', type: 'string' },
  { name: 'actor_id', type: 'string', nullable: true },
  { name: 'client_id', type: 'string', nullable: true },
  { name: 'key_id', type: 'string' },
  { name: 'ciphertext', type: 'string' },
  { name: 'scopes', type: 'json' },
] satisfies readonly BinarySnapshotColumn[];

const CRDT_CHECKPOINT_BINARY_COLUMNS = [
  { name: 'seq', type: 'integer' },
  { name: 'partition_id', type: 'string' },
  { name: 'stream_id', type: 'string' },
  { name: 'app_table', type: 'string' },
  { name: 'row_id', type: 'string' },
  { name: 'field_name', type: 'string' },
  { name: 'checkpoint_id', type: 'string' },
  { name: 'covers_seq', type: 'integer' },
  { name: 'actor_id', type: 'string', nullable: true },
  { name: 'client_id', type: 'string', nullable: true },
  { name: 'key_id', type: 'string' },
  { name: 'ciphertext', type: 'string' },
  { name: 'scopes', type: 'json' },
] satisfies readonly BinarySnapshotColumn[];

const CRDT_UPDATE_BINARY_ENCODER: BinarySnapshotRowsEncoder = (rows) =>
  encodeEncryptedCrdtUpdateRows(rows);

const CRDT_CHECKPOINT_BINARY_ENCODER: BinarySnapshotRowsEncoder = (rows) =>
  encodeEncryptedCrdtCheckpointRows(rows);

export function encryptedCrdtStreamId(args: {
  table: string;
  rowId: string;
  field: string;
}): string {
  return `${escapeStreamPart(args.table)}:${escapeStreamPart(args.rowId)}:${escapeStreamPart(args.field)}`;
}

export function createEncryptedCrdtSystemHandlers<
  DB extends SyncCoreDb = SyncCoreDb,
  Auth extends SyncServerAuth = SyncServerAuth,
>(
  options: EncryptedCrdtSystemHandlersOptions<DB, Auth>
): ServerTableHandler<DB, Auth>[] {
  return [
    createEncryptedCrdtUpdateHandler(options),
    createEncryptedCrdtCheckpointHandler(options),
  ];
}

export async function pruneEncryptedCrdtSystemRows<DB extends SyncCoreDb>(
  db: DbExecutor<DB>,
  options: EncryptedCrdtPruneOptions = {}
): Promise<EncryptedCrdtPruneReport> {
  const partitionId = options.partitionId ?? 'default';
  const streamFilter = options.streamId
    ? sql`and stream_id = ${options.streamId}`
    : sql``;
  const updateStreamFilter = options.streamId
    ? sql`and sync_crdt_updates.stream_id = ${options.streamId}`
    : sql``;
  const checkpointStreamFilter = options.streamId
    ? sql`and sync_crdt_checkpoints.stream_id = ${options.streamId}`
    : sql``;

  let updatesDeleted = 0;
  if (options.pruneCoveredUpdates !== false) {
    const deleted = await sql`
      delete from sync_crdt_updates
      where partition_id = ${partitionId}
        ${updateStreamFilter}
        and exists (
          select 1
          from sync_crdt_checkpoints
          where sync_crdt_checkpoints.partition_id = sync_crdt_updates.partition_id
            and sync_crdt_checkpoints.stream_id = sync_crdt_updates.stream_id
            and sync_crdt_checkpoints.key_id = sync_crdt_updates.key_id
            and sync_crdt_checkpoints.covers_seq >= sync_crdt_updates.seq
        )
    `.execute(db);
    updatesDeleted = affectedRows(deleted);
  }

  let checkpointsDeleted = 0;
  if (options.maxCheckpointsPerStream != null) {
    if (
      !Number.isInteger(options.maxCheckpointsPerStream) ||
      options.maxCheckpointsPerStream < 1
    ) {
      throw new Error('maxCheckpointsPerStream must be an integer >= 1');
    }
    const deleted = await sql`
      delete from sync_crdt_checkpoints
      where checkpoint_id in (
        select checkpoint_id
        from (
          select
            checkpoint_id,
            row_number() over (
              partition by partition_id, stream_id, key_id
              order by covers_seq desc, seq desc
            ) as checkpoint_rank
          from sync_crdt_checkpoints
          where partition_id = ${partitionId}
            ${streamFilter}
        ) ranked
        where checkpoint_rank > ${options.maxCheckpointsPerStream}
      )
        and partition_id = ${partitionId}
        ${checkpointStreamFilter}
    `.execute(db);
    checkpointsDeleted = affectedRows(deleted);
  }

  return { updatesDeleted, checkpointsDeleted };
}

function createEncryptedCrdtUpdateHandler<
  DB extends SyncCoreDb,
  Auth extends SyncServerAuth,
>(
  options: EncryptedCrdtSystemHandlersOptions<DB, Auth>
): ServerTableHandler<DB, Auth> {
  return {
    table: SYNC_CRDT_UPDATES_TABLE,
    primaryKeyColumn: 'update_id',
    snapshotBinaryColumns: CRDT_UPDATE_BINARY_COLUMNS,
    snapshotBinaryEncoder: CRDT_UPDATE_BINARY_ENCODER,
    scopePatterns: options.scopePatterns ?? [],
    resolveScopes: async (ctx) => options.resolveScopes(ctx),
    extractScopes: (row) => parseScopes(row.scopes),
    snapshot: (ctx, _params) =>
      snapshotSystemTable(ctx, SYNC_CRDT_UPDATES_TABLE, 'update_id'),
    async applyOperation(ctx, op, opIndex) {
      if (op.table !== SYNC_CRDT_UPDATES_TABLE) {
        return errorResult(
          opIndex,
          `UNKNOWN_TABLE:${op.table}`,
          'UNKNOWN_TABLE'
        );
      }
      if (op.op !== 'upsert') {
        return errorResult(
          opIndex,
          'Encrypted CRDT updates are append-only',
          'UNSUPPORTED_OPERATION'
        );
      }

      const payload = payloadRecord(op);
      const row = updateRowFromPayload(ctx, op, payload);
      if (options.authorizeUpdate) {
        const allowed = await options.authorizeUpdate({ ctx, row });
        if (!allowed) return errorResult(opIndex, 'Forbidden', 'FORBIDDEN');
      }

      const inserted = await insertSystemRow(
        ctx.trx,
        SYNC_CRDT_UPDATES_TABLE,
        'update_id',
        row.update_id,
        { ...row }
      );
      if (!inserted) {
        return { result: { opIndex, status: 'applied' }, emittedChanges: [] };
      }

      return appliedResult(opIndex, SYNC_CRDT_UPDATES_TABLE, row.update_id, {
        ...row,
        seq: inserted.seq,
      });
    },
  };
}

function createEncryptedCrdtCheckpointHandler<
  DB extends SyncCoreDb,
  Auth extends SyncServerAuth,
>(
  options: EncryptedCrdtSystemHandlersOptions<DB, Auth>
): ServerTableHandler<DB, Auth> {
  return {
    table: SYNC_CRDT_CHECKPOINTS_TABLE,
    primaryKeyColumn: 'checkpoint_id',
    snapshotBinaryColumns: CRDT_CHECKPOINT_BINARY_COLUMNS,
    snapshotBinaryEncoder: CRDT_CHECKPOINT_BINARY_ENCODER,
    scopePatterns: options.scopePatterns ?? [],
    resolveScopes: async (ctx) => options.resolveScopes(ctx),
    extractScopes: (row) => parseScopes(row.scopes),
    snapshot: (ctx, _params) =>
      snapshotSystemTable(ctx, SYNC_CRDT_CHECKPOINTS_TABLE, 'checkpoint_id'),
    async applyOperation(ctx, op, opIndex) {
      if (op.table !== SYNC_CRDT_CHECKPOINTS_TABLE) {
        return errorResult(
          opIndex,
          `UNKNOWN_TABLE:${op.table}`,
          'UNKNOWN_TABLE'
        );
      }
      if (op.op !== 'upsert') {
        return errorResult(
          opIndex,
          'Encrypted CRDT checkpoints are append-only',
          'UNSUPPORTED_OPERATION'
        );
      }

      const payload = payloadRecord(op);
      const row = checkpointRowFromPayload(ctx, op, payload);
      if (options.authorizeCheckpoint) {
        const allowed = await options.authorizeCheckpoint({ ctx, row });
        if (!allowed) return errorResult(opIndex, 'Forbidden', 'FORBIDDEN');
      }

      const inserted = await insertSystemRow(
        ctx.trx,
        SYNC_CRDT_CHECKPOINTS_TABLE,
        'checkpoint_id',
        row.checkpoint_id,
        { ...row }
      );
      if (!inserted) {
        return { result: { opIndex, status: 'applied' }, emittedChanges: [] };
      }

      return appliedResult(
        opIndex,
        SYNC_CRDT_CHECKPOINTS_TABLE,
        row.checkpoint_id,
        { ...row, seq: inserted.seq }
      );
    },
  };
}

async function snapshotSystemTable<
  DB extends SyncCoreDb,
  Auth extends SyncServerAuth,
>(
  ctx: ServerSnapshotContext<DB, string, Auth>,
  table: SystemTableName,
  cursorColumn: 'update_id' | 'checkpoint_id'
): Promise<{ rows: unknown[]; nextCursor: string | null }> {
  const partitionId = ctx.auth.partitionId ?? 'default';
  const cursor = ctx.cursor;
  const rows = await sql<Record<string, unknown>>`
    select *
    from ${sql.table(table)}
    where partition_id = ${partitionId}
      and (${cursor} is null or ${sql.ref(cursorColumn)} > ${cursor})
    order by ${sql.ref(cursorColumn)} asc
    limit ${ctx.limit + 1}
  `.execute(ctx.db);

  const matched = rows.rows
    .filter((row) => scopesMatch(parseScopes(row.scopes), ctx.scopeValues))
    .slice(0, ctx.limit);

  return {
    rows: matched.map(normalizeSystemRowForProtocol),
    nextCursor:
      matched.length === ctx.limit
        ? String(matched[matched.length - 1]?.[cursorColumn] ?? '')
        : null,
  };
}

async function insertSystemRow<DB extends SyncCoreDb>(
  trx: DbExecutor<DB>,
  table: SystemTableName,
  identityColumn: 'update_id' | 'checkpoint_id',
  identity: string,
  row: Record<string, unknown>
): Promise<{ seq: number } | null> {
  const insertable = {
    ...row,
    scopes: JSON.stringify(scopesField(row.scopes)),
  };
  const result = await (trx.insertInto(table) as never as any)
    .values(insertable)
    .onConflict((oc: any) =>
      oc.columns(['partition_id', identityColumn]).doNothing()
    )
    .returning(['seq', identityColumn])
    .executeTakeFirst();
  if (result) return { seq: Number(result.seq) };

  const existing = await sql<{ identity: string }>`
    select ${sql.ref(identityColumn)} as identity
    from ${sql.table(table)}
    where partition_id = ${String(row.partition_id)}
      and ${sql.ref(identityColumn)} = ${identity}
    limit 1
  `.execute(trx);
  if (existing.rows.length > 0) return null;
  throw new Error(`Encrypted CRDT insert did not return ${identityColumn}`);
}

function updateRowFromPayload<
  DB extends SyncCoreDb,
  Auth extends SyncServerAuth,
>(
  ctx: ServerApplyOperationContext<DB, Auth>,
  op: SyncOperation,
  payload: Record<string, unknown>
): EncryptedCrdtUpdateRow {
  return {
    partition_id: ctx.auth.partitionId ?? 'default',
    stream_id: stringField(payload, 'stream_id'),
    app_table: stringField(payload, 'app_table'),
    row_id: stringField(payload, 'row_id'),
    field_name: stringField(payload, 'field_name'),
    update_id: stringField(payload, 'update_id', op.row_id),
    actor_id: ctx.actorId,
    client_id: ctx.clientId,
    key_id: stringField(payload, 'key_id'),
    ciphertext: stringField(payload, 'ciphertext'),
    scopes: scopesField(payload.scopes),
  };
}

function checkpointRowFromPayload<
  DB extends SyncCoreDb,
  Auth extends SyncServerAuth,
>(
  ctx: ServerApplyOperationContext<DB, Auth>,
  op: SyncOperation,
  payload: Record<string, unknown>
): EncryptedCrdtCheckpointRow {
  const coversSeq = Number(payload.covers_seq);
  if (!Number.isInteger(coversSeq) || coversSeq < 0) {
    throw new Error(
      'Encrypted CRDT checkpoint covers_seq must be a non-negative integer'
    );
  }
  return {
    partition_id: ctx.auth.partitionId ?? 'default',
    stream_id: stringField(payload, 'stream_id'),
    app_table: stringField(payload, 'app_table'),
    row_id: stringField(payload, 'row_id'),
    field_name: stringField(payload, 'field_name'),
    checkpoint_id: stringField(payload, 'checkpoint_id', op.row_id),
    covers_seq: coversSeq,
    actor_id: ctx.actorId,
    client_id: ctx.clientId,
    key_id: stringField(payload, 'key_id'),
    ciphertext: stringField(payload, 'ciphertext'),
    scopes: scopesField(payload.scopes),
  };
}

function appliedResult(
  opIndex: number,
  table: SystemTableName,
  rowId: string,
  row: Record<string, unknown>
): ApplyOperationResult {
  const emitted: EmittedChange = {
    table,
    row_id: rowId,
    op: 'upsert',
    row_json: normalizeSystemRowForProtocol(row),
    row_version: numberOrNull(row.seq),
    scopes: scopesField(row.scopes),
  };
  return {
    result: { opIndex, status: 'applied' },
    emittedChanges: [emitted],
  };
}

function errorResult(
  opIndex: number,
  error: string,
  code: string
): ApplyOperationResult {
  return {
    result: { opIndex, status: 'error', error, code, retriable: false },
    emittedChanges: [],
  };
}

function payloadRecord(op: SyncOperation): Record<string, unknown> {
  if (
    !op.payload ||
    typeof op.payload !== 'object' ||
    Array.isArray(op.payload)
  ) {
    throw new Error('Encrypted CRDT operation payload must be an object');
  }
  return op.payload as Record<string, unknown>;
}

function stringField(
  payload: Record<string, unknown>,
  field: RequiredStringField | 'update_id' | 'checkpoint_id',
  fallback?: string
): string {
  const value = payload[field] ?? fallback;
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(
      `Encrypted CRDT payload field ${field} must be a non-empty string`
    );
  }
  return value;
}

function scopesField(value: unknown): StoredScopes {
  const parsed = parseScopes(value);
  return parsed;
}

function scopesMatch(
  stored: StoredScopes,
  requested: Record<string, unknown>
): boolean {
  for (const [key, value] of Object.entries(requested)) {
    if (Array.isArray(value)) {
      if (value.length === 0 || !value.includes(stored[key])) return false;
      continue;
    }
    if (stored[key] !== value) return false;
  }
  return true;
}

function normalizeSystemRowForProtocol(
  row: Record<string, unknown>
): Record<string, unknown> {
  return {
    ...row,
    scopes: scopesField(row.scopes),
    seq: numberOrNull(row.seq),
  };
}

function numberOrNull(value: unknown): number | null {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function affectedRows(result: {
  numAffectedRows?: bigint | number | string;
}): number {
  return Number(result.numAffectedRows ?? 0);
}

function encodeEncryptedCrdtUpdateRows(rows: readonly unknown[]): Uint8Array {
  const writer = new BinarySnapshotTableWriter(
    SYNC_CRDT_UPDATES_TABLE,
    CRDT_UPDATE_BINARY_COLUMNS,
    rows.length
  );
  for (const value of rows) {
    const row = recordRow(value);
    writer.beginRow();
    writer.writeInteger(
      rowInteger(row, 'seq'),
      'binary snapshot sync_crdt_updates.seq'
    );
    writer.writeString(
      rowString(row, 'partition_id'),
      'binary snapshot sync_crdt_updates.partition_id'
    );
    writer.writeString(
      rowString(row, 'stream_id'),
      'binary snapshot sync_crdt_updates.stream_id'
    );
    writer.writeString(
      rowString(row, 'app_table'),
      'binary snapshot sync_crdt_updates.app_table'
    );
    writer.writeString(
      rowString(row, 'row_id'),
      'binary snapshot sync_crdt_updates.row_id'
    );
    writer.writeString(
      rowString(row, 'field_name'),
      'binary snapshot sync_crdt_updates.field_name'
    );
    writer.writeString(
      rowString(row, 'update_id'),
      'binary snapshot sync_crdt_updates.update_id'
    );
    writeNullableString(
      writer,
      7,
      row.actor_id,
      'binary snapshot sync_crdt_updates.actor_id'
    );
    writeNullableString(
      writer,
      8,
      row.client_id,
      'binary snapshot sync_crdt_updates.client_id'
    );
    writer.writeString(
      rowString(row, 'key_id'),
      'binary snapshot sync_crdt_updates.key_id'
    );
    writer.writeString(
      rowString(row, 'ciphertext'),
      'binary snapshot sync_crdt_updates.ciphertext'
    );
    writer.writeJson(
      scopesField(row.scopes),
      'binary snapshot sync_crdt_updates.scopes'
    );
  }
  return writer.finish();
}

function encodeEncryptedCrdtCheckpointRows(
  rows: readonly unknown[]
): Uint8Array {
  const writer = new BinarySnapshotTableWriter(
    SYNC_CRDT_CHECKPOINTS_TABLE,
    CRDT_CHECKPOINT_BINARY_COLUMNS,
    rows.length
  );
  for (const value of rows) {
    const row = recordRow(value);
    writer.beginRow();
    writer.writeInteger(
      rowInteger(row, 'seq'),
      'binary snapshot sync_crdt_checkpoints.seq'
    );
    writer.writeString(
      rowString(row, 'partition_id'),
      'binary snapshot sync_crdt_checkpoints.partition_id'
    );
    writer.writeString(
      rowString(row, 'stream_id'),
      'binary snapshot sync_crdt_checkpoints.stream_id'
    );
    writer.writeString(
      rowString(row, 'app_table'),
      'binary snapshot sync_crdt_checkpoints.app_table'
    );
    writer.writeString(
      rowString(row, 'row_id'),
      'binary snapshot sync_crdt_checkpoints.row_id'
    );
    writer.writeString(
      rowString(row, 'field_name'),
      'binary snapshot sync_crdt_checkpoints.field_name'
    );
    writer.writeString(
      rowString(row, 'checkpoint_id'),
      'binary snapshot sync_crdt_checkpoints.checkpoint_id'
    );
    writer.writeInteger(
      rowInteger(row, 'covers_seq'),
      'binary snapshot sync_crdt_checkpoints.covers_seq'
    );
    writeNullableString(
      writer,
      8,
      row.actor_id,
      'binary snapshot sync_crdt_checkpoints.actor_id'
    );
    writeNullableString(
      writer,
      9,
      row.client_id,
      'binary snapshot sync_crdt_checkpoints.client_id'
    );
    writer.writeString(
      rowString(row, 'key_id'),
      'binary snapshot sync_crdt_checkpoints.key_id'
    );
    writer.writeString(
      rowString(row, 'ciphertext'),
      'binary snapshot sync_crdt_checkpoints.ciphertext'
    );
    writer.writeJson(
      scopesField(row.scopes),
      'binary snapshot sync_crdt_checkpoints.scopes'
    );
  }
  return writer.finish();
}

function recordRow(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Encrypted CRDT binary rows must be objects');
  }
  return value as Record<string, unknown>;
}

function rowString(row: Record<string, unknown>, field: string): string {
  const value = row[field];
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(
      `Encrypted CRDT binary row field ${field} must be a non-empty string`
    );
  }
  return value;
}

function rowInteger(
  row: Record<string, unknown>,
  field: string
): number | bigint {
  const value = row[field];
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number' && Number.isSafeInteger(value)) return value;
  if (typeof value === 'string' && /^-?\d+$/.test(value)) return BigInt(value);
  throw new Error(
    `Encrypted CRDT binary row field ${field} must be an integer`
  );
}

function writeNullableString(
  writer: BinarySnapshotTableWriter,
  columnIndex: number,
  value: unknown,
  label: string
): void {
  if (value == null) {
    writer.writeNull(columnIndex);
    return;
  }
  if (typeof value !== 'string') {
    throw new Error(`${label} expected string`);
  }
  writer.writeString(value, label);
}

function escapeStreamPart(value: string): string {
  return encodeURIComponent(value);
}
