import { SYNCULAR_ERROR_DEFINITIONS } from '@syncular/core';
import type { SyncularGeneratedWorkerRequest } from './generated-bridge';
import type {
  SyncularBootstrapStatus,
  SyncularDiagnosticEvent,
  SyncularErrorCategory,
  SyncularErrorCode,
  SyncularErrorRecommendedAction,
  SyncularLiveQueryEvent,
  SyncularRealtimeConnectionState,
  SyncularRowsChangedEvent,
} from './types';

export const SYNCULAR_WORKER_PROTOCOL_VERSION = 2;

export interface SyncularWorkerErrorPayload {
  code: SyncularErrorCode;
  message: string;
  category?: SyncularErrorCategory;
  retryable?: boolean;
  recommendedAction?: SyncularErrorRecommendedAction;
  name?: string;
  stack?: string;
  details?: unknown;
}

export function createSyncularWorkerErrorPayload(
  code: SyncularErrorCode,
  message?: string,
  options: {
    name?: string;
    stack?: string;
    details?: unknown;
  } = {}
): SyncularWorkerErrorPayload {
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
  SyncularWorkerRealtimeOptions,
  SyncularWorkerRuntimeArtifact,
} from './generated-bridge';
export type SyncularWorkerRequest = SyncularGeneratedWorkerRequest;

interface SyncularWorkerResponseBase {
  id: number;
  protocolVersion: typeof SYNCULAR_WORKER_PROTOCOL_VERSION;
}

interface SyncularWorkerEventBase {
  protocolVersion: typeof SYNCULAR_WORKER_PROTOCOL_VERSION;
}

export type SyncularWorkerResponse =
  | (SyncularWorkerResponseBase & { ok: true; value?: unknown })
  | (SyncularWorkerResponseBase & {
      ok: false;
      error: SyncularWorkerErrorPayload;
    });

export type SyncularWorkerEvent =
  | (SyncularWorkerEventBase & {
      type: 'liveQueryEvents';
      events: Array<SyncularLiveQueryEvent<Record<string, unknown>>>;
    })
  | (SyncularWorkerEventBase &
      SyncularRowsChangedEvent & {
        type: 'rowsChanged';
      })
  | (SyncularWorkerEventBase & {
      type: 'bootstrapChanged';
      bootstrap: SyncularBootstrapStatus;
    })
  | (SyncularWorkerEventBase & {
      type: 'realtimeState';
      state: SyncularRealtimeConnectionState;
    })
  | (SyncularWorkerEventBase & {
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
  | (SyncularWorkerEventBase & {
      type: 'diagnostic';
      event: SyncularDiagnosticEvent;
    });

export type SyncularWorkerOutboundMessage =
  | SyncularWorkerResponse
  | SyncularWorkerEvent;
