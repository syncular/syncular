import { describe, expect, it } from 'bun:test';
import type {
  SyncularV2CrdtFieldCompactionReceipt,
  SyncularV2CrdtFieldDescriptor,
  SyncularV2CrdtFieldMaterialization,
  SyncularV2CrdtFieldRequest,
  SyncularV2CrdtFieldWriteReceipt,
  SyncularV2CrdtFieldYjsUpdateRequest,
} from '../../bindings/browser/src';
import {
  base64ToBytes,
  bytesToBase64,
  createYjsDocumentFieldAdapter,
  type SyncularCrdtFieldHost,
  type YjsDocumentBinding,
} from './yjs-document-field-adapter';

const field = {
  table: 'tasks',
  rowId: 'task-1',
  field: 'title',
} satisfies SyncularV2CrdtFieldRequest;

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

  it('roundtrips byte arrays through base64', () => {
    const bytes = new Uint8Array([0, 1, 2, 253, 254, 255]);
    expect(base64ToBytes(bytesToBase64(bytes))).toEqual(bytes);
  });
});

class FakeCrdtFieldHost implements SyncularCrdtFieldHost {
  readonly appliedUpdates: SyncularV2CrdtFieldYjsUpdateRequest[] = [];
  readonly queuedUpdates: SyncularV2CrdtFieldYjsUpdateRequest[] = [];
  readonly enqueueCrdtFieldYjsUpdate?: (
    request: SyncularV2CrdtFieldYjsUpdateRequest
  ) => Promise<string>;
  failNextWrite = false;

  readonly #materialization: SyncularV2CrdtFieldMaterialization;

  constructor(
    options: {
      queued?: boolean;
      materialization?: SyncularV2CrdtFieldMaterialization;
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

  snapshotCrdtFieldStateVector(): Promise<{ stateVectorBase64: string }> {
    return Promise.resolve({
      stateVectorBase64: this.#materialization.stateVectorBase64,
    });
  }

  compactCrdtField(): Promise<SyncularV2CrdtFieldCompactionReceipt> {
    return Promise.resolve({ checkpointCreated: true });
  }
}

function createFakeBinding(): {
  binding: YjsDocumentBinding;
  emit(update: Uint8Array): void;
  readonly remoteUpdates: Uint8Array[];
  readonly materializedValues: unknown[];
} {
  let listener: ((update: Uint8Array) => void) | undefined;
  const remoteUpdates: Uint8Array[] = [];
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
      replaceMaterializedValue(value) {
        materializedValues.push(value);
      },
    },
    emit(update) {
      if (!listener) throw new Error('binding is not subscribed');
      listener(update);
    },
    remoteUpdates,
    materializedValues,
  };
}

function createDeterministicIds(prefix: string): () => string {
  let next = 1;
  return () => `${prefix}-${next++}`;
}
