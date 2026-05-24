import { SYNCULAR_ERROR_DEFINITIONS } from '@syncular/core';
import { SyncularClientError } from './errors';
import type {
  SyncularBlobLimits,
  SyncularBlobStoreOptions,
  SyncularDiagnosticEvent,
  SyncularDiagnosticSink,
} from './types';

export const DEFAULT_SYNCULAR_BROWSER_MAX_BLOB_PAYLOAD_BYTES = 64 * 1024 * 1024;

export type SyncularBlobLimitOperation = 'store' | 'retrieve';

export type SyncularBlobLimitInput = Blob | File | Uint8Array;

export function resolveSyncularBlobLimits(
  limits: SyncularBlobLimits | undefined
): Required<SyncularBlobLimits> {
  return {
    maxPayloadBytes: normalizeLimit(
      limits?.maxPayloadBytes,
      DEFAULT_SYNCULAR_BROWSER_MAX_BLOB_PAYLOAD_BYTES
    ),
  };
}

export function syncularBlobInputSize(data: SyncularBlobLimitInput): number {
  if (data instanceof Uint8Array) return data.byteLength;
  const maybeSized = data as { size?: unknown };
  return typeof maybeSized.size === 'number' ? maybeSized.size : 0;
}

export function assertSyncularBlobPayloadLimit(args: {
  operation: SyncularBlobLimitOperation;
  size: number;
  limits: SyncularBlobLimits | undefined;
  options?: SyncularBlobStoreOptions;
  refHash?: string;
  diagnostics?: SyncularDiagnosticSink;
}): void {
  const limits = resolveSyncularBlobLimits(args.limits);
  if (args.size <= limits.maxPayloadBytes) return;
  const error = createSyncularBlobTooLargeError({
    operation: args.operation,
    size: args.size,
    maxPayloadBytes: limits.maxPayloadBytes,
    options: args.options,
    refHash: args.refHash,
  });
  args.diagnostics?.(createSyncularBlobLimitDiagnostic(error));
  throw error;
}

function createSyncularBlobTooLargeError(args: {
  operation: SyncularBlobLimitOperation;
  size: number;
  maxPayloadBytes: number;
  options?: SyncularBlobStoreOptions;
  refHash?: string;
}): SyncularClientError {
  const definition = SYNCULAR_ERROR_DEFINITIONS['blob.too_large'];
  return new SyncularClientError({
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

function createSyncularBlobLimitDiagnostic(
  error: SyncularClientError
): SyncularDiagnosticEvent {
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
