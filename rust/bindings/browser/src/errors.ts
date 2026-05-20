import type {
  SyncularV2ErrorCategory,
  SyncularV2ErrorCode,
  SyncularV2ErrorRecommendedAction,
} from './types';

export interface SyncularV2ErrorEnvelope {
  code: SyncularV2ErrorCode;
  message: string;
  category: SyncularV2ErrorCategory;
  retryable: boolean;
  recommendedAction: SyncularV2ErrorRecommendedAction;
  details?: Record<string, unknown>;
}

export class SyncularV2ClientError extends Error {
  readonly code: SyncularV2ErrorCode;
  readonly category: SyncularV2ErrorCategory;
  readonly retryable: boolean;
  readonly recommendedAction: SyncularV2ErrorRecommendedAction;
  readonly details: Record<string, unknown> | undefined;

  constructor(envelope: SyncularV2ErrorEnvelope, options?: ErrorOptions) {
    super(envelope.message, options);
    this.name = 'SyncularV2ClientError';
    this.code = envelope.code;
    this.category = envelope.category;
    this.retryable = envelope.retryable;
    this.recommendedAction = envelope.recommendedAction;
    this.details = envelope.details;
  }
}

export function toSyncularV2ClientError(error: unknown): Error {
  if (error instanceof SyncularV2ClientError) return error;
  const message = syncularV2ErrorMessage(error);
  const details = syncularV2ErrorDetails(error);
  const classification = classifySyncularV2Error(error, message, details);
  if (!classification) {
    return error instanceof Error ? error : new Error(message);
  }
  return new SyncularV2ClientError(
    {
      ...classification,
      message,
      ...(details ? { details } : {}),
    },
    error instanceof Error ? { cause: error } : undefined
  );
}

export function syncularV2ErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function syncularV2ErrorDetails(
  error: unknown
): Record<string, unknown> | undefined {
  if (error instanceof SyncularV2ClientError) return error.details;
  if (!(error instanceof Error)) return undefined;
  const details: Record<string, unknown> = {
    ...(httpStatusFromMessage(error.message) ?? {}),
    ...(error.message.includes('full snapshot resync required')
      ? { resyncRequired: true }
      : {}),
    ...(syncularKindFromError(error)
      ? { syncularKind: syncularKindFromError(error) }
      : {}),
    ...(syncularDebugFromError(error)
      ? { syncularDebug: syncularDebugFromError(error) }
      : {}),
  };
  return Object.keys(details).length > 0 ? details : undefined;
}

export function classifySyncularV2Error(
  error: unknown,
  message = syncularV2ErrorMessage(error),
  details: Record<string, unknown> | undefined = syncularV2ErrorDetails(error)
): Omit<SyncularV2ErrorEnvelope, 'message' | 'details'> | null {
  const status =
    details &&
    'status' in details &&
    (details.status === 401 || details.status === 403)
      ? details.status
      : httpStatusFromMessage(message)?.status;
  if (status) {
    return {
      code: 'sync.auth_required',
      category: 'auth-required',
      retryable: true,
      recommendedAction: 'refreshAuth',
    };
  }

  const syncularKind =
    details && typeof details.syncularKind === 'string'
      ? details.syncularKind
      : syncularKindFromError(error);
  const debug =
    details && typeof details.syncularDebug === 'string'
      ? details.syncularDebug
      : syncularDebugFromError(error);
  const haystack = `${message}\n${debug ?? ''}`;

  if (syncularKind === 'Schema' || /\bschema version\b/i.test(haystack)) {
    return {
      code: 'sync.schema_mismatch',
      category: 'schema-mismatch',
      retryable: false,
      recommendedAction: 'regenerateClient',
    };
  }

  if (
    syncularKind === 'Protocol' &&
    /(hash mismatch|sha256 mismatch|byte length mismatch|manifest .*mismatch|integrity|chain root|commit root|verified root)/i.test(
      haystack
    )
  ) {
    return {
      code: 'sync.integrity_rejected',
      category: 'integrity-rejected',
      retryable: false,
      recommendedAction: 'forceResync',
    };
  }

  return null;
}

export function syncularV2ErrorStatus(error: unknown): 401 | 403 | undefined {
  const details =
    error instanceof SyncularV2ClientError ? error.details : undefined;
  if (
    details &&
    'status' in details &&
    (details.status === 401 || details.status === 403)
  ) {
    return details.status;
  }
  return httpStatusFromMessage(syncularV2ErrorMessage(error))?.status;
}

function httpStatusFromMessage(
  message: string
): { status: 401 | 403 } | undefined {
  const match = /\bHTTP (401|403)\b/.exec(message);
  if (!match) return undefined;
  return { status: match[1] === '401' ? 401 : 403 };
}

function syncularKindFromError(error: unknown): string | undefined {
  return error instanceof Error &&
    typeof (error as Error & { syncularKind?: unknown }).syncularKind ===
      'string'
    ? (error as Error & { syncularKind: string }).syncularKind
    : undefined;
}

function syncularDebugFromError(error: unknown): string | undefined {
  return error instanceof Error &&
    typeof (error as Error & { syncularDebug?: unknown }).syncularDebug ===
      'string'
    ? (error as Error & { syncularDebug: string }).syncularDebug
    : undefined;
}
