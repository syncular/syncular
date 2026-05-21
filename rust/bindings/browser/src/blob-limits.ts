import { SYNCULAR_ERROR_DEFINITIONS } from '@syncular/core';
import { SyncularV2ClientError } from './errors';
import type {
  SyncularV2BlobLimits,
  SyncularV2BlobStoreOptions,
  SyncularV2DiagnosticEvent,
  SyncularV2DiagnosticSink,
} from './types';

export const DEFAULT_SYNCULAR_V2_BROWSER_MAX_BLOB_PAYLOAD_BYTES =
  64 * 1024 * 1024;

export type SyncularV2BlobLimitOperation = 'store' | 'retrieve';

export type SyncularV2BlobLimitInput = Blob | File | Uint8Array;

export function resolveSyncularV2BlobLimits(
  limits: SyncularV2BlobLimits | undefined
): Required<SyncularV2BlobLimits> {
  return {
    maxPayloadBytes: normalizeLimit(
      limits?.maxPayloadBytes,
      DEFAULT_SYNCULAR_V2_BROWSER_MAX_BLOB_PAYLOAD_BYTES
    ),
  };
}

export function syncularV2BlobInputSize(
  data: SyncularV2BlobLimitInput
): number {
  if (data instanceof Uint8Array) return data.byteLength;
  const maybeSized = data as { size?: unknown };
  return typeof maybeSized.size === 'number' ? maybeSized.size : 0;
}

export function assertSyncularV2BlobPayloadLimit(args: {
  operation: SyncularV2BlobLimitOperation;
  size: number;
  limits: SyncularV2BlobLimits | undefined;
  options?: SyncularV2BlobStoreOptions;
  refHash?: string;
  diagnostics?: SyncularV2DiagnosticSink;
}): void {
  const limits = resolveSyncularV2BlobLimits(args.limits);
  if (args.size <= limits.maxPayloadBytes) return;
  const error = createSyncularV2BlobTooLargeError({
    operation: args.operation,
    size: args.size,
    maxPayloadBytes: limits.maxPayloadBytes,
    options: args.options,
    refHash: args.refHash,
  });
  args.diagnostics?.(createSyncularV2BlobLimitDiagnostic(error));
  throw error;
}

function createSyncularV2BlobTooLargeError(args: {
  operation: SyncularV2BlobLimitOperation;
  size: number;
  maxPayloadBytes: number;
  options?: SyncularV2BlobStoreOptions;
  refHash?: string;
}): SyncularV2ClientError {
  const definition = SYNCULAR_ERROR_DEFINITIONS['blob.too_large'];
  return new SyncularV2ClientError({
    code: 'blob.too_large',
    category: definition.category,
    retryable: definition.retryable,
    recommendedAction: definition.recommendedAction,
    message: `Syncular blob ${args.operation} payload is ${args.size} bytes; max is ${args.maxPayloadBytes} bytes.`,
    details: {
      operation: args.operation,
      size: args.size,
      maxPayloadBytes: args.maxPayloadBytes,
      ...(args.refHash ? { hash: args.refHash } : {}),
      ...(args.options?.mimeType ? { mimeType: args.options.mimeType } : {}),
      ...(args.options?.immediate !== undefined
        ? { immediate: args.options.immediate }
        : {}),
    },
  });
}

function createSyncularV2BlobLimitDiagnostic(
  error: SyncularV2ClientError
): SyncularV2DiagnosticEvent {
  return {
    at: Date.now(),
    level: 'warn',
    source: 'blob',
    code: error.code,
    message: error.message,
    details: error.details,
  };
}

function normalizeLimit(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isFinite(value) || value < 0) return fallback;
  return Math.floor(value);
}
