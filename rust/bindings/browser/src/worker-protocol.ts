import { SYNCULAR_ERROR_DEFINITIONS } from '@syncular/core';
import type { SyncularV2GeneratedWorkerRequest } from './generated-bridge';
import type {
  SyncularV2BootstrapStatus,
  SyncularV2DiagnosticEvent,
  SyncularV2ErrorCategory,
  SyncularV2ErrorCode,
  SyncularV2ErrorRecommendedAction,
  SyncularV2LiveQueryEvent,
  SyncularV2RealtimeConnectionState,
  SyncularV2RowsChangedEvent,
  SyncularV2RuntimeInfo,
  SyncularV2TransportStats,
} from './types';

export const SYNCULAR_V2_WORKER_PROTOCOL_VERSION = 2;

export interface SyncularV2WorkerErrorPayload {
  code: SyncularV2ErrorCode;
  message: string;
  category?: SyncularV2ErrorCategory;
  retryable?: boolean;
  recommendedAction?: SyncularV2ErrorRecommendedAction;
  name?: string;
  stack?: string;
  details?: unknown;
}

export function createSyncularV2WorkerErrorPayload(
  code: SyncularV2ErrorCode,
  message?: string,
  options: {
    name?: string;
    stack?: string;
    details?: unknown;
  } = {}
): SyncularV2WorkerErrorPayload {
  const definition = SYNCULAR_ERROR_DEFINITIONS[code];
  return {
    code,
    message: message ?? definition.message,
    category: definition.category,
    retryable: definition.retryable,
    recommendedAction: definition.recommendedAction,
    ...(options.name ? { name: options.name } : {}),
    ...(options.stack ? { stack: options.stack } : {}),
    ...(options.details !== undefined ? { details: options.details } : {}),
  };
}

export type {
  SyncularV2WorkerRealtimeOptions,
  SyncularV2WorkerRuntimeArtifact,
} from './generated-bridge';
export type SyncularV2WorkerRequest = SyncularV2GeneratedWorkerRequest;

interface SyncularV2WorkerResponseBase {
  id: number;
  protocolVersion: typeof SYNCULAR_V2_WORKER_PROTOCOL_VERSION;
}

interface SyncularV2WorkerEventBase {
  protocolVersion: typeof SYNCULAR_V2_WORKER_PROTOCOL_VERSION;
}

export type SyncularV2WorkerResponse =
  | (SyncularV2WorkerResponseBase & { ok: true; value?: unknown })
  | (SyncularV2WorkerResponseBase & {
      ok: false;
      error: SyncularV2WorkerErrorPayload;
    });

export type SyncularV2WorkerEvent =
  | (SyncularV2WorkerEventBase & {
      type: 'liveQueryEvents';
      events: Array<SyncularV2LiveQueryEvent<Record<string, unknown>>>;
    })
  | (SyncularV2WorkerEventBase &
      SyncularV2RowsChangedEvent & {
        type: 'rowsChanged';
      })
  | (SyncularV2WorkerEventBase & {
      type: 'bootstrapChanged';
      bootstrap: SyncularV2BootstrapStatus;
    })
  | (SyncularV2WorkerEventBase & {
      type: 'realtimeState';
      state: SyncularV2RealtimeConnectionState;
    })
  | (SyncularV2WorkerEventBase & {
      type: 'presenceEvent';
      action: 'join' | 'leave' | 'update' | 'snapshot';
      scopeKey: string;
      clientId?: string;
      actorId?: string;
      metadata?: Record<string, unknown>;
      entries?: Array<{
        clientId: string;
        actorId: string;
        joinedAt: number;
        metadata?: Record<string, unknown>;
      }>;
    })
  | (SyncularV2WorkerEventBase & {
      type: 'diagnostic';
      event: SyncularV2DiagnosticEvent;
    });

export type SyncularV2WorkerOutboundMessage =
  | SyncularV2WorkerResponse
  | SyncularV2WorkerEvent;

export type SyncularV2WorkerRuntimeInfoResponse = SyncularV2RuntimeInfo;
export type SyncularV2WorkerTransportStatsResponse = SyncularV2TransportStats;
