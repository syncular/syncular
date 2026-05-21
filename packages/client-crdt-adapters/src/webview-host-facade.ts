import type {
  SyncularV2ChangedRow,
  SyncularV2CrdtDocumentSnapshot,
  SyncularV2CrdtFieldCompactionReceipt,
  SyncularV2CrdtFieldDescriptor,
  SyncularV2CrdtFieldMaterialization,
  SyncularV2CrdtFieldRequest,
  SyncularV2CrdtFieldWriteReceipt,
  SyncularV2CrdtFieldYjsUpdateRequest,
  SyncularV2CrdtUpdateLogEntry,
  SyncularV2RowsChangedEvent,
} from '@syncular/client';
import type { SyncularCrdtProjectionHost } from './yjs-document-field-adapter';

export const SYNCULAR_CRDT_WEBVIEW_PROTOCOL = 'syncular.crdt.host.v1';
export const SYNCULAR_CRDT_WEBVIEW_REQUEST = 'syncular.crdt.host.request';
export const SYNCULAR_CRDT_WEBVIEW_RESPONSE = 'syncular.crdt.host.response';
export const SYNCULAR_CRDT_WEBVIEW_ROWS_CHANGED =
  'syncular.crdt.host.rowsChanged';

export interface SyncularCrdtWebViewTransport {
  postMessage(message: SyncularCrdtHostMessage): void;
  addMessageListener(listener: (message: unknown) => void): () => void;
}

export interface SyncularCrdtJsonTransportOptions {
  postJsonMessage(message: string): void;
  addJsonMessageListener(listener: (message: string) => void): () => void;
  onInvalidMessage?: (error: unknown, message: string) => void;
}

export interface SyncularCrdtWebViewHostOptions {
  transport: SyncularCrdtWebViewTransport;
  requestId?: () => string;
  timeoutMs?: number;
}

export interface SyncularCrdtWebViewHostResponderOptions {
  transport: SyncularCrdtWebViewTransport;
  host: SyncularCrdtProjectionHost;
  publishRowsChanged?: boolean;
}

export interface SyncularCrdtWebViewHost {
  host: SyncularCrdtProjectionHost;
  close(): void;
}

export interface SyncularCrdtWebViewHostResponder {
  close(): void;
}

export interface SyncularCrdtHostErrorPayload {
  message: string;
  name?: string;
  code?: string;
  details?: unknown;
}

export interface SyncularCrdtHostMethodMap {
  openCrdtField: {
    request: SyncularV2CrdtFieldRequest;
    response: SyncularV2CrdtFieldDescriptor;
  };
  applyCrdtFieldYjsUpdate: {
    request: SyncularV2CrdtFieldYjsUpdateRequest;
    response: SyncularV2CrdtFieldWriteReceipt;
  };
  enqueueCrdtFieldYjsUpdate: {
    request: SyncularV2CrdtFieldYjsUpdateRequest;
    response: string;
  };
  materializeCrdtField: {
    request: SyncularV2CrdtFieldRequest;
    response: SyncularV2CrdtFieldMaterialization;
  };
  crdtDocumentSnapshot: {
    request: SyncularV2CrdtFieldRequest;
    response: SyncularV2CrdtDocumentSnapshot;
  };
  crdtUpdateLog: {
    request: SyncularV2CrdtFieldRequest & { limit?: number };
    response: SyncularV2CrdtUpdateLogEntry[];
  };
  snapshotCrdtFieldStateVector: {
    request: SyncularV2CrdtFieldRequest;
    response: { stateVectorBase64: string };
  };
  compactCrdtField: {
    request: SyncularV2CrdtFieldRequest & {
      minUncheckpointedUpdates?: number;
    };
    response: SyncularV2CrdtFieldCompactionReceipt;
  };
}

export type SyncularCrdtHostMethod = keyof SyncularCrdtHostMethodMap;

export type SyncularCrdtHostRequestMessage = {
  [Method in SyncularCrdtHostMethod]: {
    protocol: typeof SYNCULAR_CRDT_WEBVIEW_PROTOCOL;
    type: typeof SYNCULAR_CRDT_WEBVIEW_REQUEST;
    id: string;
    method: Method;
    request: SyncularCrdtHostMethodMap[Method]['request'];
  };
}[SyncularCrdtHostMethod];

export type SyncularCrdtHostResponseMessage =
  | {
      protocol: typeof SYNCULAR_CRDT_WEBVIEW_PROTOCOL;
      type: typeof SYNCULAR_CRDT_WEBVIEW_RESPONSE;
      id: string;
      ok: true;
      response: unknown;
    }
  | {
      protocol: typeof SYNCULAR_CRDT_WEBVIEW_PROTOCOL;
      type: typeof SYNCULAR_CRDT_WEBVIEW_RESPONSE;
      id: string;
      ok: false;
      error: SyncularCrdtHostErrorPayload;
    };

export interface SyncularCrdtHostRowsChangedMessage {
  protocol: typeof SYNCULAR_CRDT_WEBVIEW_PROTOCOL;
  type: typeof SYNCULAR_CRDT_WEBVIEW_ROWS_CHANGED;
  event: SyncularV2RowsChangedEvent;
}

export type SyncularCrdtHostMessage =
  | SyncularCrdtHostRequestMessage
  | SyncularCrdtHostResponseMessage
  | SyncularCrdtHostRowsChangedMessage;

export interface SyncularNativeRowsChangedEventLike {
  kind: string;
  tables?: string[];
  changedRows?: SyncularV2ChangedRow[];
  payload_json?: {
    source?: string | null;
    changedRows?: SyncularV2ChangedRow[];
  };
}

export function createSyncularCrdtJsonTransport(
  options: SyncularCrdtJsonTransportOptions
): SyncularCrdtWebViewTransport {
  return {
    postMessage(message) {
      options.postJsonMessage(JSON.stringify(message));
    },
    addMessageListener(listener) {
      return options.addJsonMessageListener((message) => {
        try {
          const parsed = JSON.parse(message);
          if (isSyncularCrdtHostMessage(parsed)) {
            listener(parsed);
          }
        } catch (error) {
          options.onInvalidMessage?.(error, message);
        }
      });
    },
  };
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
  timer: ReturnType<typeof setTimeout> | undefined;
}

export function createSyncularCrdtWebViewHost(
  options: SyncularCrdtWebViewHostOptions
): SyncularCrdtWebViewHost {
  const timeoutMs = options.timeoutMs ?? 15_000;
  const nextRequestId = options.requestId ?? randomRequestId;
  const pending = new Map<string, PendingRequest>();
  const rowsChangedListeners = new Set<
    (event: SyncularV2RowsChangedEvent) => void
  >();
  let closed = false;

  const unsubscribe = options.transport.addMessageListener((message) => {
    if (!isSyncularCrdtHostMessage(message)) return;
    if (message.type === SYNCULAR_CRDT_WEBVIEW_RESPONSE) {
      const request = pending.get(message.id);
      if (!request) return;
      pending.delete(message.id);
      if (request.timer != null) clearTimeout(request.timer);
      if (message.ok) {
        request.resolve(message.response);
      } else {
        request.reject(errorFromPayload(message.error));
      }
      return;
    }

    if (message.type === SYNCULAR_CRDT_WEBVIEW_ROWS_CHANGED) {
      for (const listener of rowsChangedListeners) listener(message.event);
    }
  });

  const request = <Method extends SyncularCrdtHostMethod>(
    method: Method,
    payload: SyncularCrdtHostMethodMap[Method]['request']
  ): Promise<SyncularCrdtHostMethodMap[Method]['response']> => {
    if (closed) {
      return Promise.reject(new Error('Syncular CRDT WebView host is closed'));
    }
    const id = nextRequestId();
    const message: SyncularCrdtHostRequestMessage = {
      protocol: SYNCULAR_CRDT_WEBVIEW_PROTOCOL,
      type: SYNCULAR_CRDT_WEBVIEW_REQUEST,
      id,
      method,
      request: payload,
    } as SyncularCrdtHostRequestMessage;

    return new Promise<unknown>((resolve, reject) => {
      const timer =
        timeoutMs > 0
          ? setTimeout(() => {
              pending.delete(id);
              reject(
                new Error(
                  `Syncular CRDT WebView host request timed out: ${method}`
                )
              );
            }, timeoutMs)
          : undefined;
      pending.set(id, { resolve, reject, timer });
      try {
        options.transport.postMessage(message);
      } catch (error) {
        pending.delete(id);
        if (timer != null) clearTimeout(timer);
        reject(error);
      }
    }) as Promise<SyncularCrdtHostMethodMap[Method]['response']>;
  };

  return {
    host: {
      openCrdtField(field) {
        return request('openCrdtField', field);
      },
      applyCrdtFieldYjsUpdate(update) {
        return request('applyCrdtFieldYjsUpdate', update);
      },
      enqueueCrdtFieldYjsUpdate(update) {
        return request('enqueueCrdtFieldYjsUpdate', update);
      },
      materializeCrdtField(field) {
        return request('materializeCrdtField', field);
      },
      crdtDocumentSnapshot(field) {
        return request('crdtDocumentSnapshot', field);
      },
      crdtUpdateLog(field) {
        return request('crdtUpdateLog', field);
      },
      snapshotCrdtFieldStateVector(field) {
        return request('snapshotCrdtFieldStateVector', field);
      },
      compactCrdtField(field) {
        return request('compactCrdtField', field);
      },
      addRowsChangedListener(listener) {
        rowsChangedListeners.add(listener);
        return () => {
          rowsChangedListeners.delete(listener);
        };
      },
    },
    close() {
      if (closed) return;
      closed = true;
      unsubscribe();
      rowsChangedListeners.clear();
      for (const [id, pendingRequest] of pending) {
        pending.delete(id);
        if (pendingRequest.timer != null) clearTimeout(pendingRequest.timer);
        pendingRequest.reject(
          new Error('Syncular CRDT WebView host closed before response')
        );
      }
    },
  };
}

export function createSyncularCrdtWebViewHostResponder(
  options: SyncularCrdtWebViewHostResponderOptions
): SyncularCrdtWebViewHostResponder {
  let closed = false;
  const unsubscribeRequests = options.transport.addMessageListener(
    (message) => {
      if (!isSyncularCrdtHostMessage(message)) return;
      if (message.type !== SYNCULAR_CRDT_WEBVIEW_REQUEST) return;
      void createSyncularCrdtHostResponseMessage(options.host, message).then(
        (response) => {
          options.transport.postMessage(response);
        }
      );
    }
  );
  const unsubscribeRowsChanged =
    options.publishRowsChanged === false
      ? undefined
      : options.host.addRowsChangedListener((event) => {
          if (closed) return;
          options.transport.postMessage(
            createSyncularCrdtRowsChangedMessage(event)
          );
        });

  return {
    close() {
      if (closed) return;
      closed = true;
      unsubscribeRequests();
      unsubscribeRowsChanged?.();
    },
  };
}

export async function createSyncularCrdtHostResponseMessage(
  host: SyncularCrdtProjectionHost,
  message: SyncularCrdtHostRequestMessage
): Promise<SyncularCrdtHostResponseMessage> {
  try {
    const response = await dispatchSyncularCrdtHostRequest(host, message);
    return {
      protocol: SYNCULAR_CRDT_WEBVIEW_PROTOCOL,
      type: SYNCULAR_CRDT_WEBVIEW_RESPONSE,
      id: message.id,
      ok: true,
      response,
    };
  } catch (error) {
    return {
      protocol: SYNCULAR_CRDT_WEBVIEW_PROTOCOL,
      type: SYNCULAR_CRDT_WEBVIEW_RESPONSE,
      id: message.id,
      ok: false,
      error: errorPayload(error),
    };
  }
}

export function createSyncularCrdtRowsChangedMessage(
  event: SyncularV2RowsChangedEvent
): SyncularCrdtHostRowsChangedMessage {
  return {
    protocol: SYNCULAR_CRDT_WEBVIEW_PROTOCOL,
    type: SYNCULAR_CRDT_WEBVIEW_ROWS_CHANGED,
    event,
  };
}

export function syncularCrdtRowsChangedMessageFromNativeEvent(
  event: unknown
): SyncularCrdtHostRowsChangedMessage | undefined {
  if (!isNativeRowsChangedEventLike(event)) return undefined;
  const changedRows =
    event.changedRows ?? event.payload_json?.changedRows ?? [];
  const changedTables =
    event.tables && event.tables.length > 0
      ? event.tables
      : Array.from(new Set(changedRows.map((row) => row.table)));
  return createSyncularCrdtRowsChangedMessage({
    source: event.payload_json?.source ?? 'native',
    changedTables,
    changedRows,
  });
}

export function syncularCrdtRowsChangedMessageFromNativeEventJson(
  eventJson: string
): SyncularCrdtHostRowsChangedMessage | undefined {
  return syncularCrdtRowsChangedMessageFromNativeEvent(JSON.parse(eventJson));
}

export function isSyncularCrdtHostMessage(
  message: unknown
): message is SyncularCrdtHostMessage {
  if (!isRecord(message)) return false;
  if (message.protocol !== SYNCULAR_CRDT_WEBVIEW_PROTOCOL) return false;
  return (
    message.type === SYNCULAR_CRDT_WEBVIEW_REQUEST ||
    message.type === SYNCULAR_CRDT_WEBVIEW_RESPONSE ||
    message.type === SYNCULAR_CRDT_WEBVIEW_ROWS_CHANGED
  );
}

export function dispatchSyncularCrdtHostRequest(
  host: SyncularCrdtProjectionHost,
  message: SyncularCrdtHostRequestMessage
): Promise<unknown> {
  switch (message.method) {
    case 'openCrdtField':
      return host.openCrdtField(message.request);
    case 'applyCrdtFieldYjsUpdate':
      return host.applyCrdtFieldYjsUpdate(message.request);
    case 'enqueueCrdtFieldYjsUpdate':
      if (host.enqueueCrdtFieldYjsUpdate) {
        return host.enqueueCrdtFieldYjsUpdate(message.request);
      }
      return host.applyCrdtFieldYjsUpdate(message.request).then((receipt) => {
        return receipt.clientCommitId;
      });
    case 'materializeCrdtField':
      return host.materializeCrdtField(message.request);
    case 'crdtDocumentSnapshot':
      if (!host.crdtDocumentSnapshot) {
        throw new Error('Host does not expose crdtDocumentSnapshot');
      }
      return host.crdtDocumentSnapshot(message.request);
    case 'crdtUpdateLog':
      if (!host.crdtUpdateLog) {
        throw new Error('Host does not expose crdtUpdateLog');
      }
      return host.crdtUpdateLog(message.request);
    case 'snapshotCrdtFieldStateVector':
      return host.snapshotCrdtFieldStateVector(message.request);
    case 'compactCrdtField':
      return host.compactCrdtField(message.request);
    default:
      return assertNever(message);
  }
}

function errorPayload(error: unknown): SyncularCrdtHostErrorPayload {
  if (error instanceof Error) {
    return {
      message: error.message,
      name: error.name,
    };
  }
  return {
    message: String(error),
  };
}

function errorFromPayload(payload: SyncularCrdtHostErrorPayload): Error {
  const error = new Error(payload.message);
  error.name = payload.name ?? 'Error';
  return error;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isNativeRowsChangedEventLike(
  event: unknown
): event is SyncularNativeRowsChangedEventLike {
  if (!isRecord(event)) return false;
  if (event.kind !== 'RowsChanged') return false;
  return (
    Array.isArray(event.tables) ||
    Array.isArray(event.changedRows) ||
    (isRecord(event.payload_json) &&
      Array.isArray(event.payload_json.changedRows))
  );
}

function randomRequestId(): string {
  return `syncular-crdt-${Date.now().toString(36)}-${Math.random()
    .toString(36)
    .slice(2)}`;
}

function assertNever(value: never): never {
  throw new Error(`Unhandled Syncular CRDT WebView method: ${String(value)}`);
}
