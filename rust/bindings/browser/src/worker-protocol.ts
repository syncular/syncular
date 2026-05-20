import type { SyncOperation } from '@syncular/core';
import type {
  SyncularApplyYjsEnvelopeToPayloadArgs,
  SyncularApplyYjsTextUpdatesArgs,
  SyncularBuildYjsTextUpdateArgs,
  SyncularV2AuthHeaders,
  SyncularV2BlobStoreOptions,
  SyncularV2BootstrapStatus,
  SyncularV2ClientConfig,
  SyncularV2ConflictResolution,
  SyncularV2CrdtFieldCompactionRequest,
  SyncularV2CrdtFieldRequest,
  SyncularV2CrdtFieldTextRequest,
  SyncularV2CrdtFieldYjsUpdateRequest,
  SyncularV2DiagnosticEvent,
  SyncularV2EncryptedCrdtConfig,
  SyncularV2EncryptionHelperMethod,
  SyncularV2ErrorCategory,
  SyncularV2ErrorCode,
  SyncularV2ErrorRecommendedAction,
  SyncularV2FieldEncryptionConfig,
  SyncularV2LiveQueryEvent,
  SyncularV2RealtimeConnectionState,
  SyncularV2RealtimeOptions,
  SyncularV2RowsChangedEvent,
  SyncularV2RuntimeInfo,
  SyncularV2StorageCompactionOptions,
  SyncularV2SubscriptionSpec,
  SyncularV2SyncAttempt,
  SyncularV2TransportStats,
} from './types';

export const SYNCULAR_V2_WORKER_PROTOCOL_VERSION = 1;

export interface SyncularV2WorkerErrorPayload {
  code:
    | 'closed'
    | 'not_open'
    | 'protocol_mismatch'
    | 'request_timeout'
    | 'worker_error'
    | 'worker_failed'
    | SyncularV2ErrorCode;
  message: string;
  category?: SyncularV2ErrorCategory;
  retryable?: boolean;
  recommendedAction?: SyncularV2ErrorRecommendedAction;
  name?: string;
  stack?: string;
  details?: unknown;
}

export type SyncularV2WorkerRealtimeOptions = Omit<
  SyncularV2RealtimeOptions,
  'enabled' | 'getParams'
> & {
  params?: Record<string, string>;
};

export interface SyncularV2WorkerRuntimeArtifact {
  name?: string;
  wasmGlueUrl?: string;
  wasmUrl?: string;
  features?: string[];
}

interface SyncularV2WorkerResponseBase {
  id: number;
  protocolVersion: typeof SYNCULAR_V2_WORKER_PROTOCOL_VERSION;
}

interface SyncularV2WorkerEventBase {
  protocolVersion: typeof SYNCULAR_V2_WORKER_PROTOCOL_VERSION;
}

export type SyncularV2WorkerRequest =
  | {
      id: number;
      protocolVersion: typeof SYNCULAR_V2_WORKER_PROTOCOL_VERSION;
      type: 'open';
      config: SyncularV2ClientConfig;
      runtime?: SyncularV2WorkerRuntimeArtifact;
    }
  | {
      id: number;
      protocolVersion: typeof SYNCULAR_V2_WORKER_PROTOCOL_VERSION;
      type: 'setAuthHeaders';
      headers: SyncularV2AuthHeaders;
    }
  | {
      id: number;
      protocolVersion: typeof SYNCULAR_V2_WORKER_PROTOCOL_VERSION;
      type: 'setFieldEncryption';
      config: SyncularV2FieldEncryptionConfig | null;
    }
  | {
      id: number;
      protocolVersion: typeof SYNCULAR_V2_WORKER_PROTOCOL_VERSION;
      type: 'setEncryptedCrdt';
      config: SyncularV2EncryptedCrdtConfig | null;
    }
  | {
      id: number;
      protocolVersion: typeof SYNCULAR_V2_WORKER_PROTOCOL_VERSION;
      type: 'setSubscriptions';
      subscriptions: SyncularV2SubscriptionSpec[];
    }
  | {
      id: number;
      protocolVersion: typeof SYNCULAR_V2_WORKER_PROTOCOL_VERSION;
      type: 'forceSubscriptionsBootstrap';
      subscriptionIds?: string[];
    }
  | {
      id: number;
      protocolVersion: typeof SYNCULAR_V2_WORKER_PROTOCOL_VERSION;
      type: 'startRealtime';
      options: SyncularV2WorkerRealtimeOptions;
    }
  | {
      id: number;
      protocolVersion: typeof SYNCULAR_V2_WORKER_PROTOCOL_VERSION;
      type: 'stopRealtime';
    }
  | {
      id: number;
      protocolVersion: typeof SYNCULAR_V2_WORKER_PROTOCOL_VERSION;
      type: 'sendPresence';
      action: 'join' | 'leave' | 'update';
      scopeKey: string;
      metadata?: Record<string, unknown>;
    }
  | {
      id: number;
      protocolVersion: typeof SYNCULAR_V2_WORKER_PROTOCOL_VERSION;
      type: 'executeSql';
      sql: string;
      params: unknown[];
    }
  | {
      id: number;
      protocolVersion: typeof SYNCULAR_V2_WORKER_PROTOCOL_VERSION;
      type: 'executeUnsafeSql';
      sql: string;
      params: unknown[];
    }
  | {
      id: number;
      protocolVersion: typeof SYNCULAR_V2_WORKER_PROTOCOL_VERSION;
      type: 'subscribeQuery';
      sql: string;
      params: unknown[];
      tables: string[];
    }
  | {
      id: number;
      protocolVersion: typeof SYNCULAR_V2_WORKER_PROTOCOL_VERSION;
      type: 'unsubscribeQuery';
      queryId: string;
    }
  | {
      id: number;
      protocolVersion: typeof SYNCULAR_V2_WORKER_PROTOCOL_VERSION;
      type: 'drainLiveQueryEvents';
    }
  | {
      id: number;
      protocolVersion: typeof SYNCULAR_V2_WORKER_PROTOCOL_VERSION;
      type: 'applyMutation';
      operation: SyncOperation;
      localRow?: unknown | null;
    }
  | {
      id: number;
      protocolVersion: typeof SYNCULAR_V2_WORKER_PROTOCOL_VERSION;
      type: 'applyMutationsBatch' | 'applyMutationsCommit';
      operations: Array<{
        operation: SyncOperation;
        localRow?: unknown | null;
      }>;
    }
  | {
      id: number;
      protocolVersion: typeof SYNCULAR_V2_WORKER_PROTOCOL_VERSION;
      type: 'syncPull' | 'syncPush' | 'syncOnce';
      syncAttempt?: SyncularV2SyncAttempt;
    }
  | {
      id: number;
      protocolVersion: typeof SYNCULAR_V2_WORKER_PROTOCOL_VERSION;
      type: 'transportStats';
    }
  | {
      id: number;
      protocolVersion: typeof SYNCULAR_V2_WORKER_PROTOCOL_VERSION;
      type: 'resetTransportStats';
    }
  | {
      id: number;
      protocolVersion: typeof SYNCULAR_V2_WORKER_PROTOCOL_VERSION;
      type: 'conflictSummaries';
    }
  | {
      id: number;
      protocolVersion: typeof SYNCULAR_V2_WORKER_PROTOCOL_VERSION;
      type: 'retryConflictKeepLocal';
      conflictId: string;
    }
  | {
      id: number;
      protocolVersion: typeof SYNCULAR_V2_WORKER_PROTOCOL_VERSION;
      type: 'resolveConflict';
      conflictId: string;
      resolution: SyncularV2ConflictResolution;
    }
  | {
      id: number;
      protocolVersion: typeof SYNCULAR_V2_WORKER_PROTOCOL_VERSION;
      type: 'listTable';
      table: string;
    }
  | {
      id: number;
      protocolVersion: typeof SYNCULAR_V2_WORKER_PROTOCOL_VERSION;
      type: 'storeBlob';
      data: Uint8Array;
      options?: SyncularV2BlobStoreOptions;
    }
  | {
      id: number;
      protocolVersion: typeof SYNCULAR_V2_WORKER_PROTOCOL_VERSION;
      type: 'retrieveBlob';
      ref: import('@syncular/core').BlobRef;
    }
  | {
      id: number;
      protocolVersion: typeof SYNCULAR_V2_WORKER_PROTOCOL_VERSION;
      type:
        | 'processBlobUploadQueue'
        | 'blobUploadQueueStats'
        | 'blobCacheStats'
        | 'clearBlobCache';
    }
  | {
      id: number;
      protocolVersion: typeof SYNCULAR_V2_WORKER_PROTOCOL_VERSION;
      type: 'isBlobLocal';
      hash: string;
    }
  | {
      id: number;
      protocolVersion: typeof SYNCULAR_V2_WORKER_PROTOCOL_VERSION;
      type: 'pruneBlobCache';
      maxBytes?: number;
    }
  | {
      id: number;
      protocolVersion: typeof SYNCULAR_V2_WORKER_PROTOCOL_VERSION;
      type: 'compactStorage';
      options?: SyncularV2StorageCompactionOptions;
    }
  | {
      id: number;
      protocolVersion: typeof SYNCULAR_V2_WORKER_PROTOCOL_VERSION;
      type: 'generatedSchemaState';
    }
  | {
      id: number;
      protocolVersion: typeof SYNCULAR_V2_WORKER_PROTOCOL_VERSION;
      type: 'buildYjsTextUpdate';
      args: SyncularBuildYjsTextUpdateArgs;
    }
  | {
      id: number;
      protocolVersion: typeof SYNCULAR_V2_WORKER_PROTOCOL_VERSION;
      type: 'applyYjsTextUpdates';
      args: SyncularApplyYjsTextUpdatesArgs;
    }
  | {
      id: number;
      protocolVersion: typeof SYNCULAR_V2_WORKER_PROTOCOL_VERSION;
      type: 'applyYjsEnvelopeToPayload';
      args: SyncularApplyYjsEnvelopeToPayloadArgs;
    }
  | {
      id: number;
      protocolVersion: typeof SYNCULAR_V2_WORKER_PROTOCOL_VERSION;
      type: 'openCrdtField';
      request: SyncularV2CrdtFieldRequest;
    }
  | {
      id: number;
      protocolVersion: typeof SYNCULAR_V2_WORKER_PROTOCOL_VERSION;
      type: 'applyCrdtFieldText';
      request: SyncularV2CrdtFieldTextRequest;
    }
  | {
      id: number;
      protocolVersion: typeof SYNCULAR_V2_WORKER_PROTOCOL_VERSION;
      type: 'applyCrdtFieldYjsUpdate';
      request: SyncularV2CrdtFieldYjsUpdateRequest;
    }
  | {
      id: number;
      protocolVersion: typeof SYNCULAR_V2_WORKER_PROTOCOL_VERSION;
      type: 'materializeCrdtField' | 'snapshotCrdtFieldStateVector';
      request: SyncularV2CrdtFieldRequest;
    }
  | {
      id: number;
      protocolVersion: typeof SYNCULAR_V2_WORKER_PROTOCOL_VERSION;
      type: 'crdtDocumentSnapshot';
      request: SyncularV2CrdtFieldRequest;
    }
  | {
      id: number;
      protocolVersion: typeof SYNCULAR_V2_WORKER_PROTOCOL_VERSION;
      type: 'crdtUpdateLog';
      request: SyncularV2CrdtFieldRequest & { limit?: number };
    }
  | {
      id: number;
      protocolVersion: typeof SYNCULAR_V2_WORKER_PROTOCOL_VERSION;
      type: 'compactCrdtField';
      request: SyncularV2CrdtFieldCompactionRequest;
    }
  | {
      id: number;
      protocolVersion: typeof SYNCULAR_V2_WORKER_PROTOCOL_VERSION;
      type: 'encryptionHelper';
      method: SyncularV2EncryptionHelperMethod;
      args?: unknown;
    }
  | {
      id: number;
      protocolVersion: typeof SYNCULAR_V2_WORKER_PROTOCOL_VERSION;
      type: 'cancel';
      requestId: number;
    }
  | {
      id: number;
      protocolVersion: typeof SYNCULAR_V2_WORKER_PROTOCOL_VERSION;
      type: 'runtimeInfo';
    }
  | {
      id: number;
      protocolVersion: typeof SYNCULAR_V2_WORKER_PROTOCOL_VERSION;
      type: 'close';
    };

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
