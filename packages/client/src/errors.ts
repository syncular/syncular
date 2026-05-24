import { SYNCULAR_ERROR_DEFINITIONS } from '@syncular/core';
import type {
  SyncularErrorCategory,
  SyncularErrorCode,
  SyncularErrorRecommendedAction,
} from './types';

export interface SyncularErrorEnvelope {
  code: SyncularErrorCode;
  message: string;
  category: SyncularErrorCategory;
  retryable: boolean;
  recommendedAction: SyncularErrorRecommendedAction;
  details?: Record<string, unknown>;
}

export class SyncularClientError extends Error {
  readonly code: SyncularErrorCode;
  readonly category: SyncularErrorCategory;
  readonly retryable: boolean;
  readonly recommendedAction: SyncularErrorRecommendedAction;
  readonly details: Record<string, unknown> | undefined;

  constructor(envelope: SyncularErrorEnvelope, options?: ErrorOptions) {
    super(envelope.message, options);
    this.name = 'SyncularClientError';
    this.code = envelope.code;
    this.category = envelope.category;
    this.retryable = envelope.retryable;
    this.recommendedAction = envelope.recommendedAction;
    this.details = envelope.details;
  }
}

export function toSyncularClientError(error: unknown): Error {
  if (error instanceof SyncularClientError) return error;
  const message = syncularErrorMessage(error);
  const details = syncularErrorDetails(error);
  const classification = classifySyncularError(error, message, details);
  if (!classification) {
    return error instanceof Error ? error : new Error(message);
  }
  return new SyncularClientError(
    {
      ...classification,
      message,
      ...(details ? { details } : {}),
    },
    error instanceof Error ? { cause: error } : undefined
  );
}

export function syncularErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function syncularErrorDetails(
  error: unknown
): Record<string, unknown> | undefined {
  if (error instanceof SyncularClientError) return error.details;
  if (!(error instanceof Error)) return undefined;
  const serverError = syncularServerErrorFromMessage(error.message);
  const details: Record<string, unknown> = {
    ...(httpStatusFromMessage(error.message) ?? {}),
    ...(serverError
      ? {
          serverErrorCode: serverError.code,
          serverErrorCategory: serverError.category,
          serverRetryable: serverError.retryable,
          serverRecommendedAction: serverError.recommendedAction,
        }
      : {}),
    ...(serverError?.details ? { serverDetails: serverError.details } : {}),
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

export function classifySyncularError(
  error: unknown,
  message = syncularErrorMessage(error),
  details: Record<string, unknown> | undefined = syncularErrorDetails(error)
): Omit<SyncularErrorEnvelope, 'message' | 'details'> | null {
  const serverError = syncularServerErrorFromMessage(message);
  if (serverError) {
    return {
      code: serverError.code,
      category: serverError.category,
      retryable: serverError.retryable,
      recommendedAction: serverError.recommendedAction,
    };
  }

  const status =
    details &&
    'status' in details &&
    (details.status === 401 || details.status === 403)
      ? details.status
      : httpStatusFromMessage(message)?.status;
  if (status === 401) {
    return {
      code: 'sync.auth_required',
      category: 'auth-required',
      retryable: true,
      recommendedAction: 'refreshAuth',
    };
  }
  if (status === 403) {
    return {
      code: 'sync.forbidden',
      category: 'forbidden',
      retryable: false,
      recommendedAction: 'checkPermissions',
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

  if (/\boffline\b|network is unreachable/i.test(haystack)) {
    return {
      code: 'sync.offline',
      category: 'offline',
      retryable: true,
      recommendedAction: 'retryLater',
    };
  }

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

export function isSyncularOfflineError(error: unknown): boolean {
  if (error instanceof SyncularClientError) {
    return error.code === 'sync.offline' || error.category === 'offline';
  }
  if (error && typeof error === 'object') {
    const record = error as Record<string, unknown>;
    if (record.code === 'sync.offline' || record.category === 'offline') {
      return true;
    }
  }
  const classification = classifySyncularError(error);
  return (
    classification?.code === 'sync.offline' ||
    classification?.category === 'offline'
  );
}

export function syncularErrorStatus(error: unknown): 401 | 403 | undefined {
  const details =
    error instanceof SyncularClientError ? error.details : undefined;
  if (
    details &&
    'status' in details &&
    (details.status === 401 || details.status === 403)
  ) {
    return details.status;
  }
  return httpStatusFromMessage(syncularErrorMessage(error))?.status;
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

function syncularServerErrorFromMessage(
  message: string
): Omit<SyncularErrorEnvelope, 'message'> | null {
  const match = /\bHTTP \d{3}\b: (\{.*\})\s*$/s.exec(message);
  if (!match) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(match[1] ?? '');
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;

  const record = parsed as Record<string, unknown>;
  const rawCode =
    typeof record.code === 'string'
      ? record.code
      : typeof record.error === 'string'
        ? record.error
        : null;
  if (!rawCode || !(rawCode in SYNCULAR_ERROR_DEFINITIONS)) return null;

  const definition =
    SYNCULAR_ERROR_DEFINITIONS[
      rawCode as keyof typeof SYNCULAR_ERROR_DEFINITIONS
    ];
  return {
    code: rawCode as SyncularErrorCode,
    category:
      typeof record.category === 'string'
        ? (record.category as SyncularErrorCategory)
        : definition.category,
    retryable:
      typeof record.retryable === 'boolean'
        ? record.retryable
        : definition.retryable,
    recommendedAction:
      typeof record.recommendedAction === 'string'
        ? (record.recommendedAction as SyncularErrorRecommendedAction)
        : definition.recommendedAction,
    ...(record.details && typeof record.details === 'object'
      ? { details: record.details as Record<string, unknown> }
      : {}),
  };
}
