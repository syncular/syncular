import type {
  ErrorResponse,
  SyncularErrorCategory,
  SyncularErrorRecommendedAction,
} from './schemas/common';

export const SYNCULAR_ERROR_DEFINITIONS = {
  'sync.auth_required': {
    category: 'auth-required',
    retryable: true,
    recommendedAction: 'refreshAuth',
    message: 'Authentication is required.',
  },
  'sync.forbidden': {
    category: 'forbidden',
    retryable: false,
    recommendedAction: 'checkPermissions',
    message: 'The authenticated actor is not allowed to access this resource.',
  },
  'sync.invalid_request': {
    category: 'invalid-request',
    retryable: false,
    recommendedAction: 'fixRequest',
    message: 'The sync request is invalid.',
  },
  'sync.invalid_client_id': {
    category: 'invalid-request',
    retryable: false,
    recommendedAction: 'resetClientId',
    message: 'The client id cannot be used for this actor.',
  },
  'sync.invalid_subscription': {
    category: 'invalid-request',
    retryable: false,
    recommendedAction: 'fixRequest',
    message: 'The subscription is invalid.',
  },
  'sync.too_many_operations': {
    category: 'invalid-request',
    retryable: false,
    recommendedAction: 'splitBatch',
    message: 'The push contains too many operations.',
  },
  'sync.not_found': {
    category: 'not-found',
    retryable: false,
    recommendedAction: 'forceResync',
    message: 'The requested sync resource was not found.',
  },
  'sync.rate_limited': {
    category: 'rate-limited',
    retryable: true,
    recommendedAction: 'retryLater',
    message: 'The request was rate limited.',
  },
  'sync.schema_mismatch': {
    category: 'schema-mismatch',
    retryable: false,
    recommendedAction: 'regenerateClient',
    message: 'The generated client schema is not compatible with this server.',
  },
  'sync.integrity_rejected': {
    category: 'integrity-rejected',
    retryable: false,
    recommendedAction: 'forceResync',
    message: 'Sync data failed integrity verification.',
  },
  'sync.websocket_not_configured': {
    category: 'server',
    retryable: false,
    recommendedAction: 'inspectServer',
    message: 'The realtime websocket route is not configured.',
  },
  'sync.websocket_connection_limit': {
    category: 'rate-limited',
    retryable: true,
    recommendedAction: 'retryLater',
    message: 'The realtime websocket connection limit was reached.',
  },
  'sync.transport_failed': {
    category: 'transport',
    retryable: true,
    recommendedAction: 'retryLater',
    message: 'The sync transport failed.',
  },
  'runtime.busy': {
    category: 'rate-limited',
    retryable: true,
    recommendedAction: 'retryLater',
    message: 'The Syncular runtime is busy.',
  },
  'runtime.config_invalid': {
    category: 'invalid-request',
    retryable: false,
    recommendedAction: 'fixRequest',
    message: 'The Syncular runtime configuration is invalid.',
  },
  'runtime.codegen_mismatch': {
    category: 'schema-mismatch',
    retryable: false,
    recommendedAction: 'regenerateClient',
    message: 'The generated client code is not compatible with the runtime.',
  },
  'runtime.internal': {
    category: 'internal',
    retryable: false,
    recommendedAction: 'inspectServer',
    message: 'The Syncular runtime failed internally.',
  },
  'storage.failed': {
    category: 'storage',
    retryable: false,
    recommendedAction: 'inspectStorage',
    message: 'The local Syncular storage operation failed.',
  },
  'blob.invalid_request': {
    category: 'blob',
    retryable: false,
    recommendedAction: 'fixRequest',
    message: 'The blob request is invalid.',
  },
  'blob.too_large': {
    category: 'blob',
    retryable: false,
    recommendedAction: 'fixRequest',
    message: 'The blob is too large.',
  },
  'blob.not_found': {
    category: 'blob',
    retryable: false,
    recommendedAction: 'fixRequest',
    message: 'The blob was not found.',
  },
  'blob.forbidden': {
    category: 'forbidden',
    retryable: false,
    recommendedAction: 'checkPermissions',
    message: 'The authenticated actor is not allowed to access this blob.',
  },
  'blob.invalid_token': {
    category: 'auth-required',
    retryable: true,
    recommendedAction: 'refreshAuth',
    message: 'The blob token is invalid or expired.',
  },
  'blob.upload_failed': {
    category: 'blob',
    retryable: true,
    recommendedAction: 'retryLater',
    message: 'The blob upload failed.',
  },
  'blob.hash_mismatch': {
    category: 'integrity-rejected',
    retryable: false,
    recommendedAction: 'fixRequest',
    message: 'The blob content hash does not match.',
  },
  'blob.size_mismatch': {
    category: 'blob',
    retryable: false,
    recommendedAction: 'fixRequest',
    message: 'The blob size does not match.',
  },
} as const satisfies Record<
  string,
  {
    category: SyncularErrorCategory;
    retryable: boolean;
    recommendedAction: SyncularErrorRecommendedAction;
    message: string;
  }
>;

export type SyncularErrorCode = keyof typeof SYNCULAR_ERROR_DEFINITIONS;

export interface CreateSyncularErrorResponseOptions {
  message?: string;
  details?: Record<string, unknown>;
}

export function createSyncularErrorResponse(
  code: SyncularErrorCode,
  options: CreateSyncularErrorResponseOptions = {}
): ErrorResponse & {
  code: SyncularErrorCode;
  category: SyncularErrorCategory;
  retryable: boolean;
  recommendedAction: SyncularErrorRecommendedAction;
} {
  const definition = SYNCULAR_ERROR_DEFINITIONS[code];
  return {
    error: code,
    code,
    message: options.message ?? definition.message,
    category: definition.category,
    retryable: definition.retryable,
    recommendedAction: definition.recommendedAction,
    ...(options.details ? { details: options.details } : {}),
  };
}
