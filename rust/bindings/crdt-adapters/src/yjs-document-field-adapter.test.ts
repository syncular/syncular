import { describe, expect, it } from 'bun:test';
import type {
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
import {
  base64ToBytes,
  bytesToBase64,
  createCrdtFieldProjectionMaterializer,
  createRichEditorCrdtAdapter,
  createYjsEditorBackpressureController,
  createYjsDocumentFieldAdapter,
  projectionReasonForRowsChanged,
  type SyncularCrdtFieldHost,
  type SyncularCrdtProjectionEvent,
  type SyncularCrdtProjectionHost,
  type YjsDocumentBinding,
  type YjsDocumentRestoreReceipt,
} from './yjs-document-field-adapter';

const field = {
  table: 'tasks',
  rowId: 'task-1',
  field: 'title',
} satisfies SyncularV2CrdtFieldRequest;

function compactionStatsFromSnapshot(
  snapshot: SyncularV2CrdtDocumentSnapshot
): SyncularV2CrdtFieldCompactionReceipt['before'] {
  return {
    pendingUpdates: snapshot.pendingUpdates,
    flushedUpdates: snapshot.flushedUpdates,
    ackedUpdates: snapshot.ackedUpdates,
    logUpdates: snapshot.logUpdates,
    stateVectorBase64: snapshot.stateVectorBase64,
    updatedAt: snapshot.updatedAt,
    compactedAt: snapshot.compactedAt,
  };
}

describe('createYjsDocumentFieldAdapter', () => {
  it('flushes local Yjs updates through the Syncular host', async () => {
    const host = new FakeCrdtFieldHost();
    const binding = createFakeBinding();
    const adapter = createYjsDocumentFieldAdapter(
      host,
      field,
      binding.binding,
      {
        flushDelayMs: 10_000,
        updateId: createDeterministicIds('update'),
      }
    );

    const stop = await adapter.start();

    binding.emit(new Uint8Array([1, 2, 3]));
    binding.emit(new Uint8Array([4, 5]));
    expect(adapter.pendingUpdateCount()).toBe(2);

    await adapter.flush();

    expect(host.appliedUpdates.map((request) => request.update)).toEqual([
      { updateId: 'update-1', updateBase64: 'AQID' },
      { updateId: 'update-2', updateBase64: 'BAU=' },
    ]);
    expect(adapter.pendingUpdateCount()).toBe(0);

    await stop();
  });

  it('prefers queued host writes when the host exposes them', async () => {
    const host = new FakeCrdtFieldHost({ queued: true });
    const binding = createFakeBinding();
    const adapter = createYjsDocumentFieldAdapter(
      host,
      field,
      binding.binding,
      {
        flushDelayMs: 10_000,
        updateId: createDeterministicIds('queued'),
      }
    );

    const stop = await adapter.start();
    binding.emit(new Uint8Array([9]));

    await adapter.flush();

    expect(host.appliedUpdates).toEqual([]);
    expect(host.queuedUpdates.map((request) => request.update)).toEqual([
      { updateId: 'queued-1', updateBase64: 'CQ==' },
    ]);

    await stop();
  });

  it('does not drop a pending update when a host write fails', async () => {
    const host = new FakeCrdtFieldHost();
    const binding = createFakeBinding();
    const errors: unknown[] = [];
    const adapter = createYjsDocumentFieldAdapter(
      host,
      field,
      binding.binding,
      {
        flushDelayMs: 10_000,
        updateId: createDeterministicIds('retry'),
        onFlushError: (error) => errors.push(error),
      }
    );

    const stop = await adapter.start();
    binding.emit(new Uint8Array([7, 8]));
    host.failNextWrite = true;

    await expect(adapter.flush()).rejects.toThrow('write failed');
    expect(adapter.pendingUpdateCount()).toBe(1);

    await adapter.flush();

    expect(adapter.pendingUpdateCount()).toBe(0);
    expect(
      host.appliedUpdates.map((request) => request.update.updateId)
    ).toEqual(['retry-1', 'retry-1']);
    expect(errors).toEqual([]);

    await stop();
  });

  it('flushes pending updates when stopped', async () => {
    const host = new FakeCrdtFieldHost();
    const binding = createFakeBinding();
    const adapter = createYjsDocumentFieldAdapter(
      host,
      field,
      binding.binding,
      {
        flushDelayMs: 10_000,
        updateId: createDeterministicIds('stop'),
      }
    );

    const stop = await adapter.start();
    binding.emit(new Uint8Array([1]));

    await stop();

    expect(host.appliedUpdates).toHaveLength(1);
    expect(adapter.pendingUpdateCount()).toBe(0);
  });

  it('surfaces materialized state and remote update bytes to the app binding', async () => {
    const host = new FakeCrdtFieldHost({
      materialization: {
        value: { type: 'doc', content: [{ type: 'paragraph' }] },
        stateBase64: 'state',
        stateVectorBase64: 'vector',
      },
    });
    const binding = createFakeBinding();
    const adapter = createYjsDocumentFieldAdapter(host, field, binding.binding);

    const materialized = await adapter.refreshMaterializedValue();
    adapter.applyRemoteUpdate({
      updateId: 'remote-1',
      updateBase64: bytesToBase64(new Uint8Array([10, 11])),
    });

    expect(materialized.stateVectorBase64).toBe('vector');
    expect(binding.materializedValues).toEqual([materialized.value]);
    expect(binding.remoteUpdates).toEqual([new Uint8Array([10, 11])]);
  });

  it('restores persisted document state before subscribing to local updates', async () => {
    const host = new FakeCrdtFieldHost({
      materialization: {
        value: { type: 'doc', text: 'Restored title' },
        stateBase64: bytesToBase64(new Uint8Array([1, 2])),
        stateVectorBase64: 'materialized-vector',
      },
      snapshot: {
        documentKey: 'tasks:task-1:title',
        table: 'tasks',
        rowId: 'task-1',
        field: 'title',
        stateColumn: 'title_yjs_state',
        syncMode: 'server-merge',
        stateBase64: bytesToBase64(new Uint8Array([3, 4, 5])),
        stateVectorBase64: 'snapshot-vector',
        pendingUpdates: 0,
        flushedUpdates: 0,
        ackedUpdates: 4,
        logUpdates: 4,
        updatedAt: 123,
        compactedAt: 122,
      },
    });
    const binding = createFakeBinding();
    const adapter = createYjsDocumentFieldAdapter(
      host,
      field,
      binding.binding,
      { restoreOnStart: true }
    );

    const stop = await adapter.start();

    expect(binding.restoredStates).toEqual([new Uint8Array([3, 4, 5])]);
    expect(binding.restoreReceipts[0]?.stateVectorBase64).toBe(
      'snapshot-vector'
    );
    expect(binding.materializedValues).toEqual([
      { type: 'doc', text: 'Restored title' },
    ]);

    await stop();
  });

  it('throws backpressure instead of growing the pending queue without bound', async () => {
    const host = new FakeCrdtFieldHost();
    const binding = createFakeBinding();
    const backpressureEvents: unknown[] = [];
    const adapter = createYjsDocumentFieldAdapter(
      host,
      field,
      binding.binding,
      {
        flushDelayMs: 10_000,
        maxPendingUpdates: 1,
        onBackpressure: (event) => backpressureEvents.push(event),
      }
    );

    const stop = await adapter.start();

    binding.emit(new Uint8Array([1]));
    expect(() => binding.emit(new Uint8Array([2]))).toThrow(
      'pending update limit exceeded'
    );
    expect(adapter.pendingUpdateCount()).toBe(1);
    expect(backpressureEvents).toEqual([
      { pendingUpdates: 1, maxPendingUpdates: 1 },
    ]);

    await stop();
  });

  it('can pause editor input and clear saving-blocked state after queue drain', async () => {
    const host = new FakeCrdtFieldHost();
    const binding = createFakeBinding();
    const readOnlyStates: boolean[] = [];
    const blockedStates: string[] = [];
    const controller = createYjsEditorBackpressureController({
      autoRetry: false,
      setEditorReadOnly(readOnly) {
        readOnlyStates.push(readOnly);
      },
      showSavingBlocked(event) {
        blockedStates.push(event.state);
      },
      clearSavingBlocked(event) {
        blockedStates.push(event.state);
      },
    });
    const adapter = createYjsDocumentFieldAdapter(
      host,
      field,
      binding.binding,
      {
        flushDelayMs: 10_000,
        maxPendingUpdates: 1,
        updateId: createDeterministicIds('backpressure'),
        ...controller.fieldOptions,
      }
    );
    controller.attach(adapter);

    const stop = await adapter.start();

    binding.emit(new Uint8Array([1]));
    expect(() => binding.emit(new Uint8Array([2]))).toThrow(
      'pending update limit exceeded'
    );
    expect(controller.state()).toBe('blocked');
    expect(readOnlyStates).toEqual([true]);
    expect(blockedStates).toEqual(['blocked']);

    await adapter.flush();

    expect(controller.state()).toBe('open');
    expect(readOnlyStates).toEqual([true, false]);
    expect(blockedStates).toEqual(['blocked', 'open']);

    controller.stop();
    await stop();
  });

  it('roundtrips byte arrays through base64', () => {
    const bytes = new Uint8Array([0, 1, 2, 253, 254, 255]);
    expect(base64ToBytes(bytesToBase64(bytes))).toEqual(bytes);
  });
});

describe('createCrdtFieldProjectionMaterializer', () => {
  it('materializes derived projections when a remote CRDT row change arrives', async () => {
    const host = new FakeCrdtFieldHost({
      materialization: {
        value: { type: 'doc', text: 'Remote title' },
        stateBase64: 'state-remote',
        stateVectorBase64: 'vector-remote',
      },
      snapshot: {
        documentKey: 'tasks:task-1:title',
        table: 'tasks',
        rowId: 'task-1',
        field: 'title',
        stateColumn: 'title_yjs_state',
        syncMode: 'server-merge',
        stateBase64: 'state-remote',
        stateVectorBase64: 'snapshot-vector-remote',
        pendingUpdates: 0,
        flushedUpdates: 0,
        ackedUpdates: 3,
        logUpdates: 3,
        updatedAt: 123,
        compactedAt: null,
      },
    });
    const applied: Array<{
      projection: { title: string; searchText: string };
      event: SyncularCrdtProjectionEvent;
    }> = [];
    const materializer = createCrdtFieldProjectionMaterializer(
      host,
      field,
      {
        derive(materialization, event) {
          return {
            title: (materialization.value as { text: string }).text,
            searchText: `${event.field.rowId} ${
              (materialization.value as { text: string }).text
            }`,
          };
        },
        apply(projection, event) {
          applied.push({ projection, event });
        },
      }
    );

    const stop = await materializer.start();
    host.emitRowsChanged({
      source: 'remotePull',
      changedTables: ['tasks'],
      changedRows: [
        {
          table: 'tasks',
          rowId: 'task-1',
          operation: 'update',
          changedFields: ['title_yjs_state'],
          crdtFields: ['title_yjs_state'],
          commitSeq: 42,
          serverVersion: 9001,
        },
      ],
    });
    await materializer.flush();

    expect(applied).toHaveLength(1);
    expect(applied[0]?.projection).toEqual({
      title: 'Remote title',
      searchText: 'task-1 Remote title',
    });
    expect(applied[0]?.event.reason).toBe('remote-apply');
    expect(applied[0]?.event.source).toBe('remotePull');
    expect(applied[0]?.event.operation).toBe('update');
    expect(applied[0]?.event.commitSeq).toBe(42);
    expect(applied[0]?.event.serverVersion).toBe(9001);
    expect(applied[0]?.event.stateVectorBase64).toBe(
      'snapshot-vector-remote'
    );
    expect(applied[0]?.event.documentSnapshot?.ackedUpdates).toBe(3);

    await stop();
  });

  it('can include recent update-log metadata with projection events', async () => {
    const host = new FakeCrdtFieldHost({
      updateLog: [
        {
          id: 7,
          documentKey: 'tasks:task-1:title',
          updateId: 'update-7',
          clientCommitId: 'commit-7',
          origin: 'local',
          status: 'acked',
          updateBase64: 'AQID',
          stateVectorBase64: 'vector-7',
          createdAt: 700,
          flushedAt: 710,
          ackedAt: 720,
        },
      ],
    });
    const events: SyncularCrdtProjectionEvent[] = [];
    const materializer = createCrdtFieldProjectionMaterializer(
      host,
      field,
      {
        derive() {
          return null;
        },
        apply(_projection, event) {
          events.push(event);
        },
      },
      { updateLogLimit: 1 }
    );

    await materializer.materialize();

    expect(host.updateLogRequests).toEqual([{ ...field, limit: 1 }]);
    expect(events[0]?.latestUpdate?.updateId).toBe('update-7');
    expect(events[0]?.updateLog?.[0]?.status).toBe('acked');
  });

  it('ignores non-CRDT rows and unrelated CRDT fields', async () => {
    const host = new FakeCrdtFieldHost();
    const applied: unknown[] = [];
    const materializer = createCrdtFieldProjectionMaterializer(
      host,
      field,
      {
        derive() {
          return 'projection';
        },
        apply(projection) {
          applied.push(projection);
        },
      }
    );

    const stop = await materializer.start();
    host.emitRowsChanged({
      source: 'remotePull',
      changedTables: ['tasks'],
      changedRows: [
        {
          table: 'tasks',
          rowId: 'task-1',
          operation: 'update',
          changedFields: ['completed'],
          crdtFields: [],
        },
        {
          table: 'tasks',
          rowId: 'task-2',
          operation: 'update',
          changedFields: ['title_yjs_state'],
          crdtFields: ['title_yjs_state'],
        },
      ],
    });
    await materializer.flush();

    expect(applied).toEqual([]);
    await stop();
  });

  it('labels compaction events and carries local commit metadata', async () => {
    const host = new FakeCrdtFieldHost();
    const events: SyncularCrdtProjectionEvent[] = [];
    const materializer = createCrdtFieldProjectionMaterializer(
      host,
      field,
      {
        derive() {
          return null;
        },
        apply(_projection, event) {
          events.push(event);
        },
      }
    );

    const stop = await materializer.start();
    host.emitRowsChanged({
      source: 'localWrite',
      changedTables: ['tasks'],
      changedRows: [
        {
          table: 'tasks',
          rowId: 'task-1',
          operation: 'compact',
          changedFields: ['title_yjs_state'],
          crdtFields: ['title_yjs_state'],
          commitId: 'commit-1',
        },
      ],
    });
    await materializer.flush();

    expect(events).toHaveLength(1);
    expect(events[0]?.reason).toBe('compaction');
    expect(events[0]?.operation).toBe('compact');
    expect(events[0]?.commitId).toBe('commit-1');

    await stop();
  });

  it('can materialize once on startup before any row event', async () => {
    const host = new FakeCrdtFieldHost();
    const reasons: string[] = [];
    const materializer = createCrdtFieldProjectionMaterializer(
      host,
      field,
      {
        derive() {
          return 'projection';
        },
        apply(_projection, event) {
          reasons.push(event.reason);
        },
      },
      { materializeOnStart: true }
    );

    const stop = await materializer.start();
    await materializer.flush();

    expect(reasons).toEqual(['startup']);
    await stop();
  });

  it('classifies row-change projection reasons', () => {
    expect(
      projectionReasonForRowsChanged(
        { source: 'remotePull', changedTables: [], changedRows: [] },
        {
          table: 'tasks',
          rowId: 'task-1',
          operation: 'update',
          changedFields: [],
          crdtFields: [],
        }
      )
    ).toBe('remote-apply');
    expect(
      projectionReasonForRowsChanged(
        { source: 'localWrite', changedTables: [], changedRows: [] },
        {
          table: 'tasks',
          rowId: 'task-1',
          operation: 'compact',
          changedFields: [],
          crdtFields: [],
        }
      )
    ).toBe('compaction');
  });
});

describe('createRichEditorCrdtAdapter', () => {
  it('combines persisted-state restore, local update flushing, and projections', async () => {
    const host = new FakeCrdtFieldHost({
      materialization: {
        value: { type: 'doc', text: 'Rich title' },
        stateBase64: bytesToBase64(new Uint8Array([6])),
        stateVectorBase64: 'rich-vector',
      },
    });
    const binding = createFakeBinding();
    const projections: unknown[] = [];
    const adapter = createRichEditorCrdtAdapter(
      host,
      field,
      binding.binding,
      {
        derive(materialization) {
          return (materialization.value as { text: string }).text;
        },
        apply(projection) {
          projections.push(projection);
        },
      },
      {
        field: {
          flushDelayMs: 10_000,
          updateId: createDeterministicIds('rich'),
        },
      }
    );

    const stop = await adapter.start();
    await adapter.projections.flush();
    binding.emit(new Uint8Array([8]));
    await adapter.flush();

    expect(binding.restoredStates).toEqual([new Uint8Array([6])]);
    expect(host.appliedUpdates.map((request) => request.update)).toEqual([
      { updateId: 'rich-1', updateBase64: 'CA==' },
    ]);
    expect(projections).toEqual(['Rich title']);

    await stop();
  });
});

class FakeCrdtFieldHost implements SyncularCrdtProjectionHost {
  readonly appliedUpdates: SyncularV2CrdtFieldYjsUpdateRequest[] = [];
  readonly queuedUpdates: SyncularV2CrdtFieldYjsUpdateRequest[] = [];
  readonly enqueueCrdtFieldYjsUpdate?: (
    request: SyncularV2CrdtFieldYjsUpdateRequest
  ) => Promise<string>;
  failNextWrite = false;

  readonly #materialization: SyncularV2CrdtFieldMaterialization;
  readonly #snapshot?: SyncularV2CrdtDocumentSnapshot;
  readonly #updateLog: SyncularV2CrdtUpdateLogEntry[];
  readonly updateLogRequests: Array<SyncularV2CrdtFieldRequest & { limit?: number }> = [];
  readonly #rowsChangedListeners = new Set<
    (event: SyncularV2RowsChangedEvent) => void
  >();

  constructor(
    options: {
      queued?: boolean;
      materialization?: SyncularV2CrdtFieldMaterialization;
      snapshot?: SyncularV2CrdtDocumentSnapshot;
      updateLog?: SyncularV2CrdtUpdateLogEntry[];
    } = {}
  ) {
    if (options.queued) {
      this.enqueueCrdtFieldYjsUpdate = (request) => {
        this.queuedUpdates.push(request);
        return Promise.resolve(`command-${this.queuedUpdates.length}`);
      };
    }
    this.#materialization =
      options.materialization ??
      ({
        value: 'materialized',
        stateVectorBase64: 'state-vector',
      } satisfies SyncularV2CrdtFieldMaterialization);
    this.#snapshot = options.snapshot;
    this.#updateLog = options.updateLog ?? [];
  }

  openCrdtField(
    request: SyncularV2CrdtFieldRequest
  ): Promise<SyncularV2CrdtFieldDescriptor> {
    return Promise.resolve({
      ...request,
      stateColumn: `${request.field}_yjs_state`,
      containerKey: request.field,
      rowIdField: 'id',
      kind: 'prosemirror',
      syncMode: 'server-merge',
    });
  }

  async applyCrdtFieldYjsUpdate(
    request: SyncularV2CrdtFieldYjsUpdateRequest
  ): Promise<SyncularV2CrdtFieldWriteReceipt> {
    this.appliedUpdates.push(request);
    if (this.failNextWrite) {
      this.failNextWrite = false;
      throw new Error('write failed');
    }
    return {
      clientCommitId: `commit-${this.appliedUpdates.length}`,
      syncMode: 'server-merge',
    };
  }

  materializeCrdtField(): Promise<SyncularV2CrdtFieldMaterialization> {
    return Promise.resolve(this.#materialization);
  }

  crdtDocumentSnapshot(): Promise<SyncularV2CrdtDocumentSnapshot> {
    return Promise.resolve(
      this.#snapshot ?? {
        documentKey: 'tasks:task-1:title',
        table: 'tasks',
        rowId: 'task-1',
        field: 'title',
        stateColumn: 'title_yjs_state',
        syncMode: 'server-merge',
        stateBase64: this.#materialization.stateBase64,
        stateVectorBase64: this.#materialization.stateVectorBase64,
        pendingUpdates: 0,
        flushedUpdates: 0,
        ackedUpdates: 0,
        logUpdates: 0,
        updatedAt: 1,
        compactedAt: null,
      }
    );
  }

  crdtUpdateLog(
    request: SyncularV2CrdtFieldRequest & { limit?: number }
  ): Promise<SyncularV2CrdtUpdateLogEntry[]> {
    this.updateLogRequests.push(request);
    return Promise.resolve(this.#updateLog.slice(0, request.limit));
  }

  snapshotCrdtFieldStateVector(): Promise<{ stateVectorBase64: string }> {
    return Promise.resolve({
      stateVectorBase64: this.#materialization.stateVectorBase64,
    });
  }

  async compactCrdtField(): Promise<SyncularV2CrdtFieldCompactionReceipt> {
    const stats = compactionStatsFromSnapshot(await this.crdtDocumentSnapshot());
    return {
      checkpointCreated: true,
      clientCommitId: 'compact-1',
      before: stats,
      after: stats,
      encryptedStreamBefore: null,
      encryptedStreamAfter: null,
    };
  }

  addRowsChangedListener(
    listener: (event: SyncularV2RowsChangedEvent) => void
  ): () => void {
    this.#rowsChangedListeners.add(listener);
    return () => {
      this.#rowsChangedListeners.delete(listener);
    };
  }

  emitRowsChanged(event: SyncularV2RowsChangedEvent): void {
    for (const listener of this.#rowsChangedListeners) listener(event);
  }
}

function createFakeBinding(): {
  binding: YjsDocumentBinding;
  emit(update: Uint8Array): void;
  readonly remoteUpdates: Uint8Array[];
  readonly restoredStates: Uint8Array[];
  readonly restoreReceipts: YjsDocumentRestoreReceipt[];
  readonly materializedValues: unknown[];
} {
  let listener: ((update: Uint8Array) => void) | undefined;
  const remoteUpdates: Uint8Array[] = [];
  const restoredStates: Uint8Array[] = [];
  const restoreReceipts: YjsDocumentRestoreReceipt[] = [];
  const materializedValues: unknown[] = [];

  return {
    binding: {
      subscribeLocalUpdates(next) {
        listener = next;
        return () => {
          listener = undefined;
        };
      },
      applyRemoteUpdate(update) {
        remoteUpdates.push(update);
      },
      replaceDocumentState(state, receipt) {
        restoredStates.push(state);
        restoreReceipts.push(receipt);
      },
      replaceMaterializedValue(value) {
        materializedValues.push(value);
      },
    },
    emit(update) {
      if (!listener) throw new Error('binding is not subscribed');
      listener(update);
    },
    remoteUpdates,
    restoredStates,
    restoreReceipts,
    materializedValues,
  };
}

function createDeterministicIds(prefix: string): () => string {
  let next = 1;
  return () => `${prefix}-${next++}`;
}
