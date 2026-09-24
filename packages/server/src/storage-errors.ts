/**
 * Privacy-safe storage failures which the push protocol is allowed to turn
 * into durable application-write rejections. Database-specific errors remain
 * attached only as an internal cause and never cross the protocol boundary.
 */
export class StorageConstraintError extends Error {
  override readonly name = 'StorageConstraintError';
  readonly opIndex: number | undefined;

  constructor(cause: unknown, opIndex?: number) {
    super('application row violates a relational constraint', { cause });
    this.opIndex = opIndex;
  }
}

/** Stable, privacy-safe failures for trusted server storage queries. */
export type StorageQueryErrorCode =
  | 'sync.storage.schema_migration_pending'
  | 'sync.storage.schema_migration_conflict'
  | 'sync.storage.schema_changed'
  | 'sync.storage.invalid_migration_budget'
  | 'sync.storage.scan_requires_scope'
  | 'sync.storage.index_not_found'
  | 'sync.storage.index_not_materialized'
  | 'sync.storage.index_value_count_mismatch'
  | 'sync.storage.invalid_limit'
  | 'sync.storage.prune_epoch_mismatch'
  | 'sync.storage.partition_unregistered'
  | 'sync.storage.invalid_prune_cursor'
  | 'sync.storage.checkpoint_not_declared'
  | 'sync.storage.checkpoint_unsupported'
  | 'sync.storage.checkpoint_fence_missing'
  | 'sync.storage.checkpoint_incomplete'
  | 'sync.storage.stored_layout_mismatch'
  | 'sync.storage.physical_layout_mismatch'
  | 'sync.storage.transaction_query_unsupported'
  | 'sync.storage.query_over_staged_writes';

const STORAGE_QUERY_MESSAGES: Readonly<Record<StorageQueryErrorCode, string>> =
  {
    'sync.storage.schema_migration_pending':
      'schema migration requires another invocation',
    'sync.storage.schema_migration_conflict':
      'another schema migration target is already pending',
    'sync.storage.schema_changed':
      'storage schema is not ready for this operation',
    'sync.storage.invalid_migration_budget':
      'migration statement budget must be an integer from 10 through 1000',
    'sync.storage.prune_epoch_mismatch':
      'partition log epoch changed; recompute retention inputs',
    'sync.storage.partition_unregistered':
      'pruning requires a registered partition',
    'sync.storage.invalid_prune_cursor':
      'pruning requires a non-negative safe integer cursor and a non-empty log epoch',
    'sync.storage.checkpoint_not_declared':
      'checkpoint claim requires a declared, not yet activated row',
    'sync.storage.checkpoint_unsupported':
      'this storage backend cannot declare backfill checkpoints',
    'sync.storage.checkpoint_fence_missing':
      'checkpoint activation requires the writer fence raised at declaration',
    'sync.storage.checkpoint_incomplete':
      'a declared backfill checkpoint is not activated and this caller did not declare it',
    'sync.storage.stored_layout_mismatch':
      'stored schema layouts disagree with the configured schema at the same version',
    'sync.storage.physical_layout_mismatch':
      'a synced table does not match the storage layout the running code reads and writes',
    'sync.storage.transaction_query_unsupported':
      'this storage transaction cannot run registered queries',
    'sync.storage.query_over_staged_writes':
      'registered query reads a table this transaction has buffered writes for',
    'sync.storage.scan_requires_scope':
      'scope-indexed row scans require at least one scope variable',
    'sync.storage.index_not_found':
      'trusted row lookup requires a declared relational index',
    'sync.storage.index_not_materialized':
      'trusted row lookup requires a materialized relational table',
    'sync.storage.index_value_count_mismatch':
      'trusted row lookup requires one exact value per index column',
    'sync.storage.invalid_limit':
      'trusted row lookup limit must be an integer from 1 through 1,000',
  };

/**
 * Host-only query error. Messages never include identifiers, values, SQL,
 * paths, or row data; callers branch on `code`, never message text. The
 * schema-readiness codes name the offending table and column in `details`.
 */
export class StorageQueryError extends Error {
  override readonly name = 'StorageQueryError';
  readonly code: StorageQueryErrorCode;
  readonly details: Readonly<Record<string, string>> | undefined;

  constructor(
    code: StorageQueryErrorCode,
    details?: Readonly<Record<string, string>>,
  ) {
    super(STORAGE_QUERY_MESSAGES[code]);
    this.code = code;
    this.details = details;
  }
}

interface DriverError {
  readonly code?: unknown;
  readonly errno?: unknown;
  readonly errcode?: unknown;
  readonly message?: unknown;
}

function driverError(error: unknown): DriverError | undefined {
  return typeof error === 'object' && error !== null
    ? (error as DriverError)
    : undefined;
}

/** SQLite primary/extended constraint result codes (`SQLITE_CONSTRAINT*`). */
export function isSqliteConstraintError(error: unknown): boolean {
  const candidate = driverError(error);
  const code = candidate?.code;
  if (
    typeof code === 'string' &&
    (code === 'SQLITE_CONSTRAINT' || code.startsWith('SQLITE_CONSTRAINT_'))
  ) {
    return true;
  }
  const errno = candidate?.errno;
  if (typeof errno === 'number' && (errno & 0xff) === 19) return true;
  const errcode = candidate?.errcode;
  return typeof errcode === 'number' && (errcode & 0xff) === 19;
}

/** PostgreSQL SQLSTATE class 23: integrity constraint violation. */
export function isPostgresConstraintError(error: unknown): boolean {
  const code = driverError(error)?.code;
  return typeof code === 'string' && /^23[0-9A-Z]{3}$/.test(code);
}

/**
 * D1 may preserve SQLite's structured code or expose only a bounded platform
 * prefix. The text fallback is adapter-private classification only: no part of
 * the original message is copied to the public StorageConstraintError.
 */
export function isD1ConstraintError(error: unknown): boolean {
  if (isSqliteConstraintError(error)) return true;
  const message = driverError(error)?.message;
  return (
    typeof message === 'string' &&
    /^(?:D1(?:_EXEC)?_ERROR:\s*)?(?:UNIQUE|NOT NULL|CHECK|FOREIGN KEY) constraint failed\b/i.test(
      message,
    )
  );
}
