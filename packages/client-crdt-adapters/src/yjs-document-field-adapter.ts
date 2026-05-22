import type {
  SyncularChangedRow,
  SyncularCrdtDocumentSnapshot,
  SyncularCrdtFieldCompactionReceipt,
  SyncularCrdtFieldDescriptor,
  SyncularCrdtFieldMaterialization,
  SyncularCrdtFieldRequest,
  SyncularCrdtFieldWriteReceipt,
  SyncularCrdtFieldYjsUpdateRequest,
  SyncularCrdtUpdateLogEntry,
  SyncularRowsChangedEvent,
  SyncularYjsUpdateEnvelope,
} from '@syncular/client';

export interface SyncularCrdtFieldHost {
  openCrdtField(
    request: SyncularCrdtFieldRequest
  ): Promise<SyncularCrdtFieldDescriptor>;
  applyCrdtFieldYjsUpdate(
    request: SyncularCrdtFieldYjsUpdateRequest
  ): Promise<SyncularCrdtFieldWriteReceipt>;
  enqueueCrdtFieldYjsUpdate?(
    request: SyncularCrdtFieldYjsUpdateRequest
  ): Promise<string>;
  materializeCrdtField(
    request: SyncularCrdtFieldRequest
  ): Promise<SyncularCrdtFieldMaterialization>;
  crdtDocumentSnapshot?(
    request: SyncularCrdtFieldRequest
  ): Promise<SyncularCrdtDocumentSnapshot>;
  crdtUpdateLog?(
    request: SyncularCrdtFieldRequest & { limit?: number }
  ): Promise<SyncularCrdtUpdateLogEntry[]>;
  snapshotCrdtFieldStateVector(
    request: SyncularCrdtFieldRequest
  ): Promise<{ stateVectorBase64: string }>;
  compactCrdtField(request: {
    table: string;
    rowId: string;
    field: string;
    minUncheckpointedUpdates?: number;
  }): Promise<SyncularCrdtFieldCompactionReceipt>;
}

export interface SyncularCrdtProjectionHost extends SyncularCrdtFieldHost {
  addRowsChangedListener(
    listener: (event: SyncularRowsChangedEvent) => void
  ): () => void;
}

export interface YjsDocumentBinding {
  subscribeLocalUpdates(listener: (update: Uint8Array) => void): () => void;
  applyRemoteUpdate?: (update: Uint8Array) => void;
  replaceDocumentState?: (
    state: Uint8Array,
    receipt: YjsDocumentRestoreReceipt
  ) => void;
  replaceMaterializedValue?: (value: unknown) => void;
}

export interface YjsDocumentFieldAdapterOptions {
  flushDelayMs?: number;
  maxPendingUpdates?: number;
  restoreOnStart?: boolean;
  updateId?: () => string;
  onBackpressure?: (event: YjsDocumentFieldBackpressureEvent) => void;
  onFlushStart?: (event: YjsDocumentFieldFlushEvent) => void;
  onFlushSuccess?: (event: YjsDocumentFieldFlushEvent) => void;
  onFlushError?: (error: unknown) => void;
}

export interface YjsDocumentFieldBackpressureEvent {
  pendingUpdates: number;
  maxPendingUpdates: number;
}

export interface YjsDocumentFieldFlushEvent {
  pendingUpdates: number;
}

export interface YjsDocumentFieldAdapter {
  open(): Promise<SyncularCrdtFieldDescriptor>;
  start(): Promise<() => Promise<void>>;
  flush(): Promise<void>;
  pendingUpdateCount(): number;
  restoreFromPersistedState(): Promise<YjsDocumentRestoreReceipt>;
  refreshMaterializedValue(): Promise<SyncularCrdtFieldMaterialization>;
  snapshotStateVector(): Promise<string>;
  applyRemoteUpdate(update: SyncularYjsUpdateEnvelope): void;
  compact(
    minUncheckpointedUpdates?: number
  ): Promise<SyncularCrdtFieldCompactionReceipt>;
}

export interface YjsDocumentRestoreReceipt {
  field: SyncularCrdtFieldRequest;
  descriptor: SyncularCrdtFieldDescriptor;
  materialization: SyncularCrdtFieldMaterialization;
  documentSnapshot?: SyncularCrdtDocumentSnapshot;
  stateBase64?: string | null;
  stateVectorBase64: string;
  restoredState: boolean;
}

export type SyncularCrdtProjectionReason =
  | 'local-write'
  | 'remote-apply'
  | 'compaction'
  | 'manual'
  | 'startup';

export interface SyncularCrdtProjectionCause {
  reason: SyncularCrdtProjectionReason;
  source: SyncularRowsChangedEvent['source'] | 'manual' | 'startup';
  changedRow?: SyncularChangedRow;
}

export interface SyncularCrdtProjectionEvent {
  field: SyncularCrdtFieldRequest;
  descriptor: SyncularCrdtFieldDescriptor;
  materialization: SyncularCrdtFieldMaterialization;
  documentSnapshot?: SyncularCrdtDocumentSnapshot;
  updateLog?: SyncularCrdtUpdateLogEntry[];
  latestUpdate?: SyncularCrdtUpdateLogEntry;
  reason: SyncularCrdtProjectionReason;
  source: SyncularCrdtProjectionCause['source'];
  operation?: SyncularChangedRow['operation'];
  commitId?: string | null;
  commitSeq?: number | null;
  serverVersion?: number | null;
  stateVectorBase64: string;
  changedRow?: SyncularChangedRow;
}

export interface SyncularCrdtProjectionDefinition<TProjection> {
  derive(
    materialization: SyncularCrdtFieldMaterialization,
    event: SyncularCrdtProjectionEvent
  ): TProjection | Promise<TProjection>;
  apply(
    projection: TProjection,
    event: SyncularCrdtProjectionEvent
  ): void | Promise<void>;
}

export interface SyncularCrdtProjectionMaterializerOptions<TProjection> {
  materializeOnStart?: boolean;
  updateLogLimit?: number;
  onMaterialized?: (
    projection: TProjection,
    event: SyncularCrdtProjectionEvent
  ) => void;
  onError?: (error: unknown, event?: SyncularCrdtProjectionEvent) => void;
}

export interface SyncularCrdtProjectionMaterializer<_TProjection> {
  start(): Promise<() => Promise<void>>;
  stop(): Promise<void>;
  flush(): Promise<void>;
  materialize(
    cause?: Partial<SyncularCrdtProjectionCause>
  ): Promise<SyncularCrdtProjectionEvent>;
}

export interface RichEditorCrdtAdapterOptions<TProjection> {
  field?: YjsDocumentFieldAdapterOptions;
  projections?: SyncularCrdtProjectionMaterializerOptions<TProjection>;
}

export interface RichEditorCrdtAdapter<_TProjection> {
  document: YjsDocumentFieldAdapter;
  projections: SyncularCrdtProjectionMaterializer<_TProjection>;
  start(): Promise<() => Promise<void>>;
  stop(): Promise<void>;
  flush(): Promise<void>;
  restoreFromPersistedState(): Promise<YjsDocumentRestoreReceipt>;
  compact(
    minUncheckpointedUpdates?: number
  ): Promise<SyncularCrdtFieldCompactionReceipt>;
}

export type YjsEditorBackpressureState = 'open' | 'blocked' | 'recovering';

export interface YjsEditorBackpressureEvent {
  state: YjsEditorBackpressureState;
  pendingUpdates: number;
  maxPendingUpdates?: number;
  retryAttempt: number;
  nextRetryDelayMs?: number;
  error?: unknown;
}

export interface YjsEditorBackpressureControllerOptions {
  retryDelayMs?: number;
  maxRetryDelayMs?: number;
  autoRetry?: boolean;
  setEditorReadOnly?: (
    readOnly: boolean,
    event: YjsEditorBackpressureEvent
  ) => void;
  showSavingBlocked?: (event: YjsEditorBackpressureEvent) => void;
  clearSavingBlocked?: (event: YjsEditorBackpressureEvent) => void;
  onStateChange?: (event: YjsEditorBackpressureEvent) => void;
  onRetryError?: (error: unknown, event: YjsEditorBackpressureEvent) => void;
}

export interface YjsEditorBackpressureController {
  readonly fieldOptions: Pick<
    YjsDocumentFieldAdapterOptions,
    'onBackpressure' | 'onFlushError' | 'onFlushStart' | 'onFlushSuccess'
  >;
  attach(
    adapter: Pick<YjsDocumentFieldAdapter, 'flush' | 'pendingUpdateCount'>
  ): void;
  detach(): void;
  state(): YjsEditorBackpressureState;
  retryNow(): Promise<void>;
  stop(): void;
}

export function createYjsDocumentFieldAdapter(
  host: SyncularCrdtFieldHost,
  field: SyncularCrdtFieldRequest,
  binding: YjsDocumentBinding,
  options: YjsDocumentFieldAdapterOptions = {}
): YjsDocumentFieldAdapter {
  const flushDelayMs = options.flushDelayMs ?? 16;
  const maxPendingUpdates = options.maxPendingUpdates ?? 1024;
  const updateId = options.updateId ?? randomUpdateId;
  const pending: SyncularYjsUpdateEnvelope[] = [];
  let flushTimer: ReturnType<typeof setTimeout> | undefined;
  let activeFlush: Promise<void> | undefined;
  let descriptor: SyncularCrdtFieldDescriptor | undefined;

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
      return host.openCrdtField(field).then((nextDescriptor) => {
        descriptor = nextDescriptor;
        return nextDescriptor;
      });
    },

    async start() {
      await adapter.open();
      if (options.restoreOnStart) {
        await adapter.restoreFromPersistedState();
      }
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
        options.onFlushStart?.({ pendingUpdates: pending.length });
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
        options.onFlushSuccess?.({ pendingUpdates: pending.length });
      })().finally(() => {
        activeFlush = undefined;
      });
      return activeFlush;
    },

    pendingUpdateCount() {
      return pending.length;
    },

    async restoreFromPersistedState() {
      const currentDescriptor = descriptor ?? (await adapter.open());
      const [materialized, documentSnapshot] = await Promise.all([
        host.materializeCrdtField(field),
        host.crdtDocumentSnapshot?.(field),
      ]);
      const stateBase64 =
        documentSnapshot?.stateBase64 ?? materialized.stateBase64 ?? null;
      const receipt: YjsDocumentRestoreReceipt = {
        field,
        descriptor: currentDescriptor,
        materialization: materialized,
        documentSnapshot,
        stateBase64,
        stateVectorBase64:
          documentSnapshot?.stateVectorBase64 ?? materialized.stateVectorBase64,
        restoredState: stateBase64 != null && stateBase64 !== '',
      };
      if (stateBase64 != null && stateBase64 !== '') {
        binding.replaceDocumentState?.(base64ToBytes(stateBase64), receipt);
      }
      binding.replaceMaterializedValue?.(materialized.value);
      return receipt;
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

export function createYjsEditorBackpressureController(
  options: YjsEditorBackpressureControllerOptions = {}
): YjsEditorBackpressureController {
  const retryDelayMs = options.retryDelayMs ?? 750;
  const maxRetryDelayMs = options.maxRetryDelayMs ?? 8_000;
  const autoRetry = options.autoRetry ?? true;
  let adapter:
    | Pick<YjsDocumentFieldAdapter, 'flush' | 'pendingUpdateCount'>
    | undefined;
  let currentState: YjsEditorBackpressureState = 'open';
  let retryAttempt = 0;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  let lastEvent: YjsEditorBackpressureEvent = {
    state: 'open',
    pendingUpdates: 0,
    retryAttempt: 0,
  };

  const clearRetryTimer = () => {
    if (retryTimer != null) {
      clearTimeout(retryTimer);
      retryTimer = undefined;
    }
  };

  const publish = (
    state: YjsEditorBackpressureState,
    event: Partial<YjsEditorBackpressureEvent> = {}
  ): YjsEditorBackpressureEvent => {
    currentState = state;
    lastEvent = {
      ...lastEvent,
      ...event,
      state,
      retryAttempt,
      pendingUpdates:
        event.pendingUpdates ?? adapter?.pendingUpdateCount() ?? 0,
    };
    options.onStateChange?.(lastEvent);
    return lastEvent;
  };

  const block = (event: Partial<YjsEditorBackpressureEvent>) => {
    const nextEvent = publish('blocked', event);
    options.setEditorReadOnly?.(true, nextEvent);
    options.showSavingBlocked?.(nextEvent);
    scheduleRetry(nextEvent);
  };

  const unblock = (event: Partial<YjsEditorBackpressureEvent> = {}) => {
    clearRetryTimer();
    retryAttempt = 0;
    const nextEvent = publish('open', event);
    options.clearSavingBlocked?.(nextEvent);
    options.setEditorReadOnly?.(false, nextEvent);
  };

  const scheduleRetry = (event: YjsEditorBackpressureEvent) => {
    if (!autoRetry || adapter == null || retryTimer != null) return;
    const nextRetryDelayMs = Math.min(
      maxRetryDelayMs,
      retryDelayMs * 2 ** retryAttempt
    );
    lastEvent = { ...event, nextRetryDelayMs };
    retryTimer = setTimeout(() => {
      retryTimer = undefined;
      void controller.retryNow();
    }, nextRetryDelayMs);
  };

  const controller: YjsEditorBackpressureController = {
    fieldOptions: {
      onBackpressure(event) {
        retryAttempt = 0;
        block({
          pendingUpdates: event.pendingUpdates,
          maxPendingUpdates: event.maxPendingUpdates,
        });
      },

      onFlushStart(event) {
        if (currentState === 'blocked') {
          publish('recovering', { pendingUpdates: event.pendingUpdates });
        }
      },

      onFlushSuccess(event) {
        if (event.pendingUpdates === 0 && currentState !== 'open') {
          unblock({ pendingUpdates: 0 });
        }
      },

      onFlushError(error) {
        retryAttempt += 1;
        const event = publish(
          currentState === 'open' ? 'blocked' : currentState,
          {
            error,
          }
        );
        options.onRetryError?.(error, event);
        scheduleRetry(event);
      },
    },

    attach(nextAdapter) {
      adapter = nextAdapter;
    },

    detach() {
      adapter = undefined;
      clearRetryTimer();
    },

    state() {
      return currentState;
    },

    async retryNow() {
      clearRetryTimer();
      if (adapter == null) return;
      publish('recovering');
      try {
        await adapter.flush();
        if (adapter.pendingUpdateCount() === 0) {
          unblock({ pendingUpdates: 0 });
        } else {
          retryAttempt += 1;
          block({ pendingUpdates: adapter.pendingUpdateCount() });
        }
      } catch (error) {
        retryAttempt += 1;
        const event = publish('blocked', { error });
        options.onRetryError?.(error, event);
        scheduleRetry(event);
      }
    },

    stop() {
      clearRetryTimer();
      retryAttempt = 0;
      if (currentState !== 'open') {
        unblock({ pendingUpdates: adapter?.pendingUpdateCount() ?? 0 });
      }
    },
  };

  return controller;
}

export function createRichEditorCrdtAdapter<TProjection>(
  host: SyncularCrdtProjectionHost,
  field: SyncularCrdtFieldRequest,
  binding: YjsDocumentBinding,
  projection: SyncularCrdtProjectionDefinition<TProjection>,
  options: RichEditorCrdtAdapterOptions<TProjection> = {}
): RichEditorCrdtAdapter<TProjection> {
  const document = createYjsDocumentFieldAdapter(host, field, binding, {
    restoreOnStart: true,
    ...options.field,
  });
  const projections = createCrdtFieldProjectionMaterializer(
    host,
    field,
    projection,
    {
      materializeOnStart: true,
      ...options.projections,
    }
  );
  let stopDocument: (() => Promise<void>) | undefined;
  let stopProjections: (() => Promise<void>) | undefined;

  const adapter: RichEditorCrdtAdapter<TProjection> = {
    document,
    projections,

    async start() {
      stopDocument = await document.start();
      stopProjections = await projections.start();
      return () => adapter.stop();
    },

    async stop() {
      const currentStopDocument = stopDocument;
      const currentStopProjections = stopProjections;
      stopProjections = undefined;
      stopDocument = undefined;
      await currentStopDocument?.();
      await currentStopProjections?.();
    },

    async flush() {
      await document.flush();
      await projections.flush();
    },

    restoreFromPersistedState() {
      return document.restoreFromPersistedState();
    },

    compact(minUncheckpointedUpdates) {
      return document.compact(minUncheckpointedUpdates);
    },
  };

  return adapter;
}

export function createCrdtFieldProjectionMaterializer<TProjection>(
  host: SyncularCrdtProjectionHost,
  field: SyncularCrdtFieldRequest,
  projection: SyncularCrdtProjectionDefinition<TProjection>,
  options: SyncularCrdtProjectionMaterializerOptions<TProjection> = {}
): SyncularCrdtProjectionMaterializer<TProjection> {
  let descriptor: SyncularCrdtFieldDescriptor | undefined;
  let unsubscribeRowsChanged: (() => void) | undefined;
  let queue = Promise.resolve();

  const open = async () => {
    descriptor ??= await host.openCrdtField(field);
    return descriptor;
  };

  const runMaterialization = async (
    cause: SyncularCrdtProjectionCause
  ): Promise<SyncularCrdtProjectionEvent> => {
    const currentDescriptor = await open();
    const updateLogLimit = Math.max(0, options.updateLogLimit ?? 0);
    const [materialization, documentSnapshot, updateLog] = await Promise.all([
      host.materializeCrdtField(field),
      host.crdtDocumentSnapshot?.(field),
      updateLogLimit > 0
        ? host.crdtUpdateLog?.({ ...field, limit: updateLogLimit })
        : undefined,
    ]);
    const stateVectorBase64 =
      documentSnapshot?.stateVectorBase64 ?? materialization.stateVectorBase64;
    const event: SyncularCrdtProjectionEvent = {
      field,
      descriptor: currentDescriptor,
      materialization,
      documentSnapshot,
      updateLog,
      latestUpdate: updateLog?.[0],
      reason: cause.reason,
      source: cause.source,
      operation: cause.changedRow?.operation,
      commitId: cause.changedRow?.commitId,
      commitSeq: cause.changedRow?.commitSeq,
      serverVersion: cause.changedRow?.serverVersion,
      stateVectorBase64,
      changedRow: cause.changedRow,
    };

    try {
      const nextProjection = await projection.derive(materialization, event);
      await projection.apply(nextProjection, event);
      options.onMaterialized?.(nextProjection, event);
      return event;
    } catch (error) {
      options.onError?.(error, event);
      throw error;
    }
  };

  const enqueueMaterialization = (cause: SyncularCrdtProjectionCause) => {
    queue = queue
      .then(() => runMaterialization(cause))
      .then(
        () => undefined,
        () => undefined
      );
  };

  const materializer: SyncularCrdtProjectionMaterializer<TProjection> = {
    async start() {
      const currentDescriptor = await open();
      unsubscribeRowsChanged = host.addRowsChangedListener((event) => {
        const changedRow = event.changedRows.find((row) =>
          crdtChangedRowMatchesField(row, field, currentDescriptor)
        );
        if (changedRow == null) return;
        enqueueMaterialization({
          reason: projectionReasonForRowsChanged(event, changedRow),
          source: event.source,
          changedRow,
        });
      });
      if (options.materializeOnStart) {
        enqueueMaterialization({ reason: 'startup', source: 'startup' });
      }
      return () => materializer.stop();
    },

    async stop() {
      unsubscribeRowsChanged?.();
      unsubscribeRowsChanged = undefined;
      await materializer.flush();
    },

    flush() {
      return queue;
    },

    materialize(cause = {}) {
      return runMaterialization({
        reason: cause.reason ?? 'manual',
        source: cause.source ?? 'manual',
        changedRow: cause.changedRow,
      });
    },
  };

  return materializer;
}

export function crdtChangedRowMatchesField(
  row: SyncularChangedRow,
  field: SyncularCrdtFieldRequest,
  descriptor: SyncularCrdtFieldDescriptor
): boolean {
  if (row.table !== field.table || row.rowId !== field.rowId) return false;
  return (
    row.crdtFields.includes(descriptor.stateColumn) ||
    row.changedFields.includes(descriptor.stateColumn) ||
    row.changedFields.includes(field.field)
  );
}

export function projectionReasonForRowsChanged(
  event: SyncularRowsChangedEvent,
  row: SyncularChangedRow
): SyncularCrdtProjectionReason {
  if (row.operation === 'compact') return 'compaction';
  if (event.source === 'remotePull') return 'remote-apply';
  return 'local-write';
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
