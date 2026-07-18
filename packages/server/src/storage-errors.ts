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
  | 'sync.storage.scan_requires_scope'
  | 'sync.storage.index_not_found'
  | 'sync.storage.index_not_materialized'
  | 'sync.storage.index_value_count_mismatch'
  | 'sync.storage.invalid_limit';

const STORAGE_QUERY_MESSAGES: Readonly<Record<StorageQueryErrorCode, string>> =
  {
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
 * paths, or row data; callers branch on `code`, never message text.
 */
export class StorageQueryError extends Error {
  override readonly name = 'StorageQueryError';
  readonly code: StorageQueryErrorCode;

  constructor(code: StorageQueryErrorCode) {
    super(STORAGE_QUERY_MESSAGES[code]);
    this.code = code;
  }
}

interface DriverError {
  readonly code?: unknown;
  readonly errno?: unknown;
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
  return typeof errno === 'number' && (errno & 0xff) === 19;
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
