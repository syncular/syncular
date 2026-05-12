import type { SyncOperation } from '@syncular/core';
import type {
  SyncularApplyYjsEnvelopeToPayloadArgs,
  SyncularApplyYjsTextUpdatesArgs,
  SyncularBuildYjsTextUpdateArgs,
  SyncularV2AuthHeaders,
  SyncularV2BlobStoreOptions,
  SyncularV2ClientConfig,
  SyncularV2DiagnosticEvent,
  SyncularV2EncryptedCrdtConfig,
  SyncularV2EncryptionHelperMethod,
  SyncularV2FieldEncryptionConfig,
  SyncularV2LiveQueryEvent,
  SyncularV2RealtimeConnectionState,
  SyncularV2RealtimeOptions,
  SyncularV2RuntimeInfo,
  SyncularV2StorageCompactionOptions,
  SyncularV2SubscriptionSpec,
} from './types';

export const SYNCULAR_V2_WORKER_PROTOCOL_VERSION = 1;

export interface SyncularV2WorkerErrorPayload {
  code:
    | 'closed'
    | 'not_open'
    | 'protocol_mismatch'
    | 'request_timeout'
    | 'worker_error'
    | 'worker_failed';
  message: string;
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
      type: 'executeSql';
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
      type: 'applyLocalOperation';
      operation: SyncOperation;
      localRow?: unknown | null;
    }
  | {
      id: number;
      protocolVersion: typeof SYNCULAR_V2_WORKER_PROTOCOL_VERSION;
      type: 'applyLocalOperationsBatch' | 'applyLocalOperationsCommit';
      operations: Array<{
        operation: SyncOperation;
        localRow?: unknown | null;
      }>;
    }
  | {
      id: number;
      protocolVersion: typeof SYNCULAR_V2_WORKER_PROTOCOL_VERSION;
      type: 'syncPull' | 'syncPush' | 'syncOnce';
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
  | (SyncularV2WorkerEventBase & {
      type: 'realtimeState';
      state: SyncularV2RealtimeConnectionState;
    })
  | (SyncularV2WorkerEventBase & {
      type: 'diagnostic';
      event: SyncularV2DiagnosticEvent;
    });

export type SyncularV2WorkerOutboundMessage =
  | SyncularV2WorkerResponse
  | SyncularV2WorkerEvent;

export type SyncularV2WorkerRuntimeInfoResponse = SyncularV2RuntimeInfo;
