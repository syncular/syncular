import type {
  SyncularV2CrdtFieldCompactionReceipt,
  SyncularV2CrdtFieldDescriptor,
  SyncularV2CrdtFieldMaterialization,
  SyncularV2CrdtFieldRequest,
  SyncularV2CrdtFieldWriteReceipt,
  SyncularV2CrdtFieldYjsUpdateRequest,
  SyncularYjsUpdateEnvelope,
} from '../../bindings/browser/src';

export interface SyncularCrdtFieldHost {
  openCrdtField(
    request: SyncularV2CrdtFieldRequest
  ): Promise<SyncularV2CrdtFieldDescriptor>;
  applyCrdtFieldYjsUpdate(
    request: SyncularV2CrdtFieldYjsUpdateRequest
  ): Promise<SyncularV2CrdtFieldWriteReceipt>;
  enqueueCrdtFieldYjsUpdate?(
    request: SyncularV2CrdtFieldYjsUpdateRequest
  ): Promise<string>;
  materializeCrdtField(
    request: SyncularV2CrdtFieldRequest
  ): Promise<SyncularV2CrdtFieldMaterialization>;
  snapshotCrdtFieldStateVector(
    request: SyncularV2CrdtFieldRequest
  ): Promise<{ stateVectorBase64: string }>;
  compactCrdtField(request: {
    table: string;
    rowId: string;
    field: string;
    minUncheckpointedUpdates?: number;
  }): Promise<SyncularV2CrdtFieldCompactionReceipt>;
}

export interface YjsDocumentBinding {
  subscribeLocalUpdates(listener: (update: Uint8Array) => void): () => void;
  applyRemoteUpdate?: (update: Uint8Array) => void;
  replaceMaterializedValue?: (value: unknown) => void;
}

export interface YjsDocumentFieldAdapterOptions {
  flushDelayMs?: number;
  maxPendingUpdates?: number;
  updateId?: () => string;
  onBackpressure?: (event: YjsDocumentFieldBackpressureEvent) => void;
  onFlushError?: (error: unknown) => void;
}

export interface YjsDocumentFieldBackpressureEvent {
  pendingUpdates: number;
  maxPendingUpdates: number;
}

export interface YjsDocumentFieldAdapter {
  open(): Promise<SyncularV2CrdtFieldDescriptor>;
  start(): Promise<() => Promise<void>>;
  flush(): Promise<void>;
  pendingUpdateCount(): number;
  refreshMaterializedValue(): Promise<SyncularV2CrdtFieldMaterialization>;
  snapshotStateVector(): Promise<string>;
  applyRemoteUpdate(update: SyncularYjsUpdateEnvelope): void;
  compact(
    minUncheckpointedUpdates?: number
  ): Promise<SyncularV2CrdtFieldCompactionReceipt>;
}

export function createYjsDocumentFieldAdapter(
  host: SyncularCrdtFieldHost,
  field: SyncularV2CrdtFieldRequest,
  binding: YjsDocumentBinding,
  options: YjsDocumentFieldAdapterOptions = {}
): YjsDocumentFieldAdapter {
  const flushDelayMs = options.flushDelayMs ?? 16;
  const maxPendingUpdates = options.maxPendingUpdates ?? 1024;
  const updateId = options.updateId ?? randomUpdateId;
  const pending: SyncularYjsUpdateEnvelope[] = [];
  let flushTimer: ReturnType<typeof setTimeout> | undefined;
  let activeFlush: Promise<void> | undefined;

  const scheduleFlush = () => {
    if (flushTimer != null) return;
    flushTimer = setTimeout(() => {
      flushTimer = undefined;
      void adapter.flush().catch((error) => {
        options.onFlushError?.(error);
      });
    }, flushDelayMs);
  };

  const adapter: YjsDocumentFieldAdapter = {
    open() {
      return host.openCrdtField(field);
    },

    async start() {
      await adapter.open();
      const unsubscribe = binding.subscribeLocalUpdates((update) => {
        if (pending.length >= maxPendingUpdates) {
          options.onBackpressure?.({
            pendingUpdates: pending.length,
            maxPendingUpdates,
          });
          throw new Error(
            `Syncular CRDT adapter pending update limit exceeded (${maxPendingUpdates})`
          );
        }
        pending.push({
          updateId: updateId(),
          updateBase64: bytesToBase64(update),
        });
        scheduleFlush();
      });

      return async () => {
        if (flushTimer != null) {
          clearTimeout(flushTimer);
          flushTimer = undefined;
        }
        unsubscribe();
        await adapter.flush();
      };
    },

    flush() {
      activeFlush ??= (async () => {
        while (pending.length > 0) {
          const update = pending[0];
          if (update == null) continue;
          if (host.enqueueCrdtFieldYjsUpdate) {
            await host.enqueueCrdtFieldYjsUpdate({ ...field, update });
          } else {
            await host.applyCrdtFieldYjsUpdate({ ...field, update });
          }
          pending.shift();
        }
      })().finally(() => {
        activeFlush = undefined;
      });
      return activeFlush;
    },

    pendingUpdateCount() {
      return pending.length;
    },

    async refreshMaterializedValue() {
      const materialized = await host.materializeCrdtField(field);
      binding.replaceMaterializedValue?.(materialized.value);
      return materialized;
    },

    async snapshotStateVector() {
      const snapshot = await host.snapshotCrdtFieldStateVector(field);
      return snapshot.stateVectorBase64;
    },

    applyRemoteUpdate(update) {
      binding.applyRemoteUpdate?.(base64ToBytes(update.updateBase64));
    },

    compact(minUncheckpointedUpdates = 100) {
      return host.compactCrdtField({ ...field, minUncheckpointedUpdates });
    },
  };

  return adapter;
}

export function bytesToBase64(bytes: Uint8Array): string {
  const maybeBuffer = (
    globalThis as {
      Buffer?: {
        from(input: Uint8Array): { toString(encoding: 'base64'): string };
      };
    }
  ).Buffer;
  if (maybeBuffer != null) return maybeBuffer.from(bytes).toString('base64');

  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export function base64ToBytes(value: string): Uint8Array {
  const maybeBuffer = (
    globalThis as {
      Buffer?: {
        from(input: string, encoding: 'base64'): Uint8Array;
      };
    }
  ).Buffer;
  if (maybeBuffer != null) return maybeBuffer.from(value, 'base64');

  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function randomUpdateId(): string {
  return (
    globalThis.crypto?.randomUUID?.() ?? `yjs-${Date.now()}-${Math.random()}`
  );
}
