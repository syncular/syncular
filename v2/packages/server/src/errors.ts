/**
 * Server-side protocol errors (SPEC.md §10).
 *
 * Every request-level failure raised by the server core is a `SyncError`
 * carrying the fixed catalog metadata of §10.2 (`category`, `retryable`,
 * `recommendedAction`) plus an HTTP status for transport adapters. The
 * catalog is closed: creating a `SyncError` with an unknown code throws.
 */

export interface ErrorCatalogEntry {
  readonly category: string;
  readonly retryable: boolean;
  readonly recommendedAction: string;
  readonly httpStatus: number;
}

/** The §10.2 wire catalog (21 sync.* + 4 blob.* codes), keyed by stable code. */
export const ERROR_CATALOG: Readonly<Record<string, ErrorCatalogEntry>> = {
  'sync.auth_required': {
    category: 'auth-required',
    retryable: true,
    recommendedAction: 'refreshAuth',
    httpStatus: 401,
  },
  'sync.forbidden': {
    category: 'forbidden',
    retryable: false,
    recommendedAction: 'checkPermissions',
    httpStatus: 403,
  },
  'sync.invalid_request': {
    category: 'invalid-request',
    retryable: false,
    recommendedAction: 'fixRequest',
    httpStatus: 400,
  },
  'sync.invalid_client_id': {
    category: 'invalid-request',
    retryable: false,
    recommendedAction: 'resetClientId',
    httpStatus: 400,
  },
  'sync.invalid_subscription': {
    category: 'invalid-request',
    retryable: false,
    recommendedAction: 'fixRequest',
    httpStatus: 400,
  },
  'sync.empty_commit': {
    category: 'invalid-request',
    retryable: false,
    recommendedAction: 'fixRequest',
    httpStatus: 400,
  },
  'sync.unknown_table': {
    category: 'schema-mismatch',
    retryable: false,
    recommendedAction: 'regenerateClient',
    httpStatus: 400,
  },
  'sync.row_missing': {
    category: 'not-found',
    retryable: false,
    recommendedAction: 'forceResync',
    httpStatus: 404,
  },
  'sync.version_conflict': {
    category: 'conflict',
    retryable: false,
    recommendedAction: 'resolveConflict',
    httpStatus: 409,
  },
  'sync.constraint_violation': {
    category: 'invalid-request',
    retryable: false,
    recommendedAction: 'fixRequest',
    httpStatus: 400,
  },
  'sync.missing_scopes': {
    category: 'internal',
    retryable: false,
    recommendedAction: 'inspectServer',
    httpStatus: 500,
  },
  'sync.idempotency_cache_miss': {
    category: 'internal',
    retryable: true,
    recommendedAction: 'retryLater',
    httpStatus: 500,
  },
  'sync.too_many_operations': {
    category: 'invalid-request',
    retryable: false,
    recommendedAction: 'splitBatch',
    httpStatus: 400,
  },
  'sync.not_found': {
    category: 'not-found',
    retryable: false,
    recommendedAction: 'forceResync',
    httpStatus: 404,
  },
  'sync.segment_expired': {
    category: 'not-found',
    retryable: true,
    recommendedAction: 'retryLater',
    httpStatus: 404,
  },
  'sync.cursor_expired': {
    category: 'reset-required',
    retryable: false,
    recommendedAction: 'rebootstrap',
    httpStatus: 400,
  },
  'sync.scope_revoked': {
    category: 'scope-revoked',
    retryable: false,
    recommendedAction: 'checkPermissions',
    httpStatus: 403,
  },
  'sync.rate_limited': {
    category: 'rate-limited',
    retryable: true,
    recommendedAction: 'retryLater',
    httpStatus: 429,
  },
  'sync.schema_mismatch': {
    category: 'schema-mismatch',
    retryable: false,
    recommendedAction: 'regenerateClient',
    httpStatus: 400,
  },
  'sync.client_schema_unsupported': {
    category: 'schema-mismatch',
    retryable: false,
    recommendedAction: 'upgradeClient',
    httpStatus: 400,
  },
  'sync.websocket_connection_limit': {
    category: 'rate-limited',
    retryable: true,
    recommendedAction: 'retryLater',
    httpStatus: 429,
  },
  // §5.9 blobs — the closed blob.* set (§10.2).
  'blob.not_found': {
    category: 'not-found',
    retryable: false,
    recommendedAction: 'fixRequest',
    httpStatus: 404,
  },
  'blob.forbidden': {
    category: 'forbidden',
    retryable: false,
    recommendedAction: 'checkPermissions',
    httpStatus: 403,
  },
  'blob.hash_mismatch': {
    category: 'invalid-request',
    retryable: false,
    recommendedAction: 'fixRequest',
    httpStatus: 400,
  },
  'blob.too_large': {
    category: 'invalid-request',
    retryable: false,
    recommendedAction: 'fixRequest',
    httpStatus: 413,
  },
};

export class SyncError extends Error {
  override readonly name = 'SyncError';
  readonly code: string;
  readonly category: string;
  readonly retryable: boolean;
  readonly recommendedAction: string;
  readonly httpStatus: number;
  readonly details?: string;

  constructor(code: string, message?: string, details?: string) {
    const entry = ERROR_CATALOG[code];
    if (entry === undefined) {
      throw new Error(`unknown error code ${code} (not in the §10.2 catalog)`);
    }
    super(message ?? code);
    this.code = code;
    this.category = entry.category;
    this.retryable = entry.retryable;
    this.recommendedAction = entry.recommendedAction;
    this.httpStatus = entry.httpStatus;
    if (details !== undefined) this.details = details;
  }
}

export function syncError(
  code: string,
  message?: string,
  details?: string,
): SyncError {
  return new SyncError(code, message, details);
}

/** The §10.1 JSON error shape, for HTTP-level error bodies (§1.1). */
export function errorBody(error: SyncError): {
  code: string;
  category: string;
  retryable: boolean;
  recommendedAction: string;
  message: string;
  details?: unknown;
} {
  return {
    code: error.code,
    category: error.category,
    retryable: error.retryable,
    recommendedAction: error.recommendedAction,
    message: error.message,
    ...(error.details !== undefined
      ? { details: JSON.parse(error.details) as unknown }
      : {}),
  };
}
