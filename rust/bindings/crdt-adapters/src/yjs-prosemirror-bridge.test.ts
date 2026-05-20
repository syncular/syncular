import { describe, expect, it } from 'bun:test';
import * as Y from 'yjs';
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
} from '@syncular/client-rust';
import {
  base64ToBytes,
  bytesToBase64,
  createRichEditorCrdtAdapter,
  type SyncularCrdtProjectionEvent,
  type SyncularCrdtProjectionHost,
} from './yjs-document-field-adapter';
import {
  createProseMirrorReadModelProjection,
  createYjsProseMirrorBridge,
  extractProseMirrorHeadings,
  extractProseMirrorText,
  prosemirrorJsonProjection,
} from './yjs-prosemirror-bridge';

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

describe('createYjsProseMirrorBridge', () => {
  it('emits local Yjs updates from the ProseMirror XML fragment', () => {
    const bridge = createYjsProseMirrorBridge({ containerKey: 'content' });
    const updates: Uint8Array[] = [];
    const unsubscribe = bridge.subscribeLocalUpdates((update) => {
      updates.push(update);
    });

    appendXmlText(bridge.fragment(), 'Hello');

    expect(updates).toHaveLength(1);
    expect(bridge.fragment().toString()).toContain('Hello');

    unsubscribe();
    bridge.destroy();
  });

  it('applies remote updates without echoing them as local Syncular writes', () => {
    const bridge = createYjsProseMirrorBridge({ containerKey: 'content' });
    const updates: Uint8Array[] = [];
    bridge.subscribeLocalUpdates((update) => {
      updates.push(update);
    });

    const remote = new Y.Doc();
    appendXmlText(remote.getXmlFragment('content'), 'Remote text');
    bridge.applyRemoteUpdate?.(Y.encodeStateAsUpdate(remote));

    expect(updates).toEqual([]);
    expect(bridge.fragment().toString()).toContain('Remote text');

    remote.destroy();
    bridge.destroy();
  });

  it('restores from compacted Syncular state without echoing the restore', () => {
    const source = new Y.Doc();
    appendXmlText(source.getXmlFragment('content'), 'Persisted text');
    const persistedState = Y.encodeStateAsUpdate(source);
    const bridge = createYjsProseMirrorBridge({ containerKey: 'content' });
    const updates: Uint8Array[] = [];
    const replacements: string[] = [];
    bridge.subscribeLocalUpdates((update) => {
      updates.push(update);
    });

    const restoredBridge = createYjsProseMirrorBridge({
      containerKey: 'content',
      onDocumentReplaced(event) {
        replacements.push(event.fragment.toString());
      },
    });
    restoredBridge.subscribeLocalUpdates((update) => {
      updates.push(update);
    });
    restoredBridge.replaceDocumentFromState(persistedState);

    expect(updates).toEqual([]);
    expect(restoredBridge.fragment().toString()).toContain('Persisted text');
    expect(replacements).toHaveLength(1);

    appendXmlText(restoredBridge.fragment(), ' after restart');
    expect(updates).toHaveLength(1);

    source.destroy();
    bridge.destroy();
    restoredBridge.destroy();
  });

  it('derives common read-model fields from ProseMirror JSON', () => {
    const doc = {
      type: 'doc',
      content: [
        {
          type: 'heading',
          attrs: { level: 1 },
          content: [{ type: 'text', text: 'Project Plan' }],
        },
        {
          type: 'paragraph',
          content: [{ type: 'text', text: 'Ship the editor adapter.' }],
        },
      ],
    };

    expect(extractProseMirrorText(doc)).toBe(
      'Project Plan Ship the editor adapter.'
    );
    expect(extractProseMirrorHeadings(doc)).toEqual(['Project Plan']);
    expect(prosemirrorJsonProjection(doc)).toMatchObject({
      prosemirrorJson: doc,
      title: 'Project Plan',
      preview: 'Project Plan Ship the editor adapter.',
      outline: ['Project Plan'],
      searchText: 'Project Plan Ship the editor adapter.',
    });
  });

  it('builds an app-owned ProseMirror read-model projection', async () => {
    const models: unknown[] = [];
    const projection = createProseMirrorReadModelProjection({
      store: {
        upsert(model) {
          models.push(model);
        },
      },
    });
    const materialization: SyncularV2CrdtFieldMaterialization = {
      value: {
        type: 'doc',
        content: [
          {
            type: 'heading',
            content: [{ type: 'text', text: 'Derived Title' }],
          },
          {
            type: 'paragraph',
            content: [{ type: 'text', text: 'Projection body.' }],
          },
        ],
      },
      stateBase64: 'state',
      stateVectorBase64: 'vector-from-materialization',
    };
    const event = {
      field: {
        table: 'tasks',
        rowId: 'task-projection',
        field: 'title',
      },
      descriptor: {
        table: 'tasks',
        rowId: 'task-projection',
        field: 'title',
        stateColumn: 'title_yjs_state',
        containerKey: 'title',
        rowIdField: 'id',
        kind: 'prosemirror',
        syncMode: 'server-merge',
      },
      materialization,
      documentSnapshot: {
        documentKey: 'tasks:task-projection:title',
        table: 'tasks',
        rowId: 'task-projection',
        field: 'title',
        stateColumn: 'title_yjs_state',
        syncMode: 'server-merge',
        stateBase64: 'state',
        stateVectorBase64: 'snapshot-vector',
        pendingUpdates: 0,
        flushedUpdates: 0,
        ackedUpdates: 2,
        logUpdates: 2,
        updatedAt: 12,
        compactedAt: 10,
      },
      latestUpdate: {
        id: 2,
        documentKey: 'tasks:task-projection:title',
        updateId: 'update-2',
        clientCommitId: 'commit-2',
        origin: 'local',
        status: 'acked',
        updateBase64: 'AQID',
        stateVectorBase64: 'snapshot-vector',
        createdAt: 11,
        flushedAt: 12,
        ackedAt: 13,
      },
      reason: 'compaction',
      source: 'localWrite',
      operation: 'compact',
      commitId: 'commit-2',
      stateVectorBase64: 'snapshot-vector',
    } satisfies SyncularCrdtProjectionEvent;

    const model = await projection.derive(materialization, event);
    await projection.apply(model, event);

    expect(models).toEqual([model]);
    expect(model).toMatchObject({
      table: 'tasks',
      rowId: 'task-projection',
      field: 'title',
      title: 'Derived Title',
      preview: 'Derived Title Projection body.',
      searchText: 'Derived Title Projection body.',
      stateVectorBase64: 'snapshot-vector',
      reason: 'compaction',
      source: 'localWrite',
      operation: 'compact',
      documentKey: 'tasks:task-projection:title',
      ackedUpdates: 2,
      logUpdates: 2,
      latestUpdateId: 'update-2',
      latestUpdateStatus: 'acked',
    });
  });

  it('restores, replays offline edits, compacts, and rebuilds projections across restart', async () => {
    const field = {
      table: 'tasks',
      rowId: 'task-restart',
      field: 'title',
    } satisfies SyncularV2CrdtFieldRequest;
    const store = createDurableYjsStore(field);
    const projections: Array<{
      projection: ReturnType<typeof prosemirrorJsonProjection>;
      event: SyncularCrdtProjectionEvent;
    }> = [];

    const firstHost = new DurableYjsCrdtHost(store);
    const firstBridge = createYjsProseMirrorBridge({ containerKey: 'title' });
    const firstAdapter = createRichEditorCrdtAdapter(
      firstHost,
      field,
      firstBridge,
      projectionRecorder(projections),
      {
        field: { flushDelayMs: 10_000 },
        projections: { updateLogLimit: 10 },
      }
    );

    const stopFirst = await firstAdapter.start();
    appendXmlText(firstBridge.fragment(), 'Offline draft');
    await firstAdapter.flush();
    await firstHost.syncPush();

    expect(store.updateLog).toHaveLength(1);
    expect(store.updateLog[0]?.status).toBe('acked');
    expect(firstBridge.fragment().toString()).toContain('Offline draft');

    await stopFirst();
    firstBridge.destroy();

    const restoredFragments: string[] = [];
    const secondHost = new DurableYjsCrdtHost(store);
    const secondBridge = createYjsProseMirrorBridge({
      containerKey: 'title',
      onDocumentReplaced(event) {
        restoredFragments.push(event.fragment.toString());
      },
    });
    const secondAdapter = createRichEditorCrdtAdapter(
      secondHost,
      field,
      secondBridge,
      projectionRecorder(projections),
      {
        field: { flushDelayMs: 10_000 },
        projections: { updateLogLimit: 10 },
      }
    );

    const stopSecond = await secondAdapter.start();
    await secondAdapter.projections.flush();

    expect(restoredFragments).toHaveLength(1);
    expect(secondBridge.fragment().toString()).toContain('Offline draft');
    expect(store.updateLog).toHaveLength(1);
    expect(
      projections.some((entry) => entry.event.reason === 'startup')
    ).toBe(true);

    appendXmlText(secondBridge.fragment(), ' after restart');
    await secondAdapter.flush();
    await secondHost.syncPush();
    await secondAdapter.compact(1);
    await secondAdapter.projections.flush();

    expect(store.updateLog).toHaveLength(2);
    expect(store.updateLog.every((entry) => entry.status === 'acked')).toBe(
      true
    );
    expect(store.compactedAt).toBeGreaterThan(0);
    expect(secondBridge.fragment().toString()).toContain('Offline draft');
    expect(secondBridge.fragment().toString()).toContain('after restart');
    expect(projections.at(-1)?.event.reason).toBe('compaction');
    expect(projections.at(-1)?.event.documentSnapshot?.ackedUpdates).toBe(2);
    expect(projections.at(-1)?.projection.searchText).toContain(
      'Offline draft after restart'
    );

    await stopSecond();
    secondBridge.destroy();
  });
});

function appendXmlText(fragment: Y.XmlFragment, text: string): void {
  const xmlText = new Y.XmlText();
  xmlText.insert(0, text);
  fragment.insert(fragment.length, [xmlText]);
}

interface DurableYjsStore {
  field: SyncularV2CrdtFieldRequest;
  stateBase64: string | null;
  stateVectorBase64: string;
  updateLog: SyncularV2CrdtUpdateLogEntry[];
  updatedAt: number;
  compactedAt: number | null;
}

function createDurableYjsStore(
  field: SyncularV2CrdtFieldRequest
): DurableYjsStore {
  return {
    field,
    stateBase64: null,
    stateVectorBase64: bytesToBase64(Y.encodeStateVector(new Y.Doc())),
    updateLog: [],
    updatedAt: 1,
    compactedAt: null,
  };
}

function projectionRecorder(
  projections: Array<{
    projection: ReturnType<typeof prosemirrorJsonProjection>;
    event: SyncularCrdtProjectionEvent;
  }>
) {
  return {
    derive(materialization: SyncularV2CrdtFieldMaterialization) {
      return prosemirrorJsonProjection(materialization.value);
    },
    apply(
      projection: ReturnType<typeof prosemirrorJsonProjection>,
      event: SyncularCrdtProjectionEvent
    ) {
      projections.push({ projection, event });
    },
  };
}

class DurableYjsCrdtHost implements SyncularCrdtProjectionHost {
  readonly #store: DurableYjsStore;
  readonly #doc = new Y.Doc();
  readonly #listeners = new Set<(event: SyncularV2RowsChangedEvent) => void>();

  constructor(store: DurableYjsStore) {
    this.#store = store;
    if (store.stateBase64) {
      Y.applyUpdate(this.#doc, base64ToBytes(store.stateBase64));
    }
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
    Y.applyUpdate(this.#doc, base64ToBytes(request.update.updateBase64));
    this.#persistState();
    const entry: SyncularV2CrdtUpdateLogEntry = {
      id: this.#store.updateLog.length + 1,
      documentKey: this.#documentKey(),
      updateId: request.update.updateId,
      clientCommitId: `commit-${this.#store.updateLog.length + 1}`,
      origin: 'local',
      status: 'pending',
      updateBase64: request.update.updateBase64,
      stateVectorBase64: this.#store.stateVectorBase64,
      createdAt: this.#store.updatedAt,
      flushedAt: null,
      ackedAt: null,
    };
    this.#store.updateLog.unshift(entry);
    this.#emitRowsChanged('localWrite', {
      operation: 'update',
      commitId: entry.clientCommitId,
    });
    return {
      clientCommitId: entry.clientCommitId ?? '',
      syncMode: 'server-merge',
    };
  }

  enqueueCrdtFieldYjsUpdate(
    request: SyncularV2CrdtFieldYjsUpdateRequest
  ): Promise<string> {
    return this.applyCrdtFieldYjsUpdate(request).then(
      (receipt) => receipt.clientCommitId
    );
  }

  materializeCrdtField(): Promise<SyncularV2CrdtFieldMaterialization> {
    return Promise.resolve({
      value: xmlFragmentToProseMirrorJson(
        this.#doc.getXmlFragment(this.#store.field.field)
      ),
      stateBase64: this.#store.stateBase64,
      stateVectorBase64: this.#store.stateVectorBase64,
    });
  }

  crdtDocumentSnapshot(): Promise<SyncularV2CrdtDocumentSnapshot> {
    const pendingUpdates = this.#store.updateLog.filter(
      (entry) => entry.status === 'pending'
    ).length;
    const flushedUpdates = this.#store.updateLog.filter(
      (entry) => entry.status === 'flushed'
    ).length;
    const ackedUpdates = this.#store.updateLog.filter(
      (entry) => entry.status === 'acked'
    ).length;
    return Promise.resolve({
      ...this.#store.field,
      documentKey: this.#documentKey(),
      stateColumn: `${this.#store.field.field}_yjs_state`,
      syncMode: 'server-merge',
      stateBase64: this.#store.stateBase64,
      stateVectorBase64: this.#store.stateVectorBase64,
      pendingUpdates,
      flushedUpdates,
      ackedUpdates,
      logUpdates: this.#store.updateLog.length,
      updatedAt: this.#store.updatedAt,
      compactedAt: this.#store.compactedAt,
    });
  }

  crdtUpdateLog(
    request: SyncularV2CrdtFieldRequest & { limit?: number }
  ): Promise<SyncularV2CrdtUpdateLogEntry[]> {
    return Promise.resolve(this.#store.updateLog.slice(0, request.limit));
  }

  snapshotCrdtFieldStateVector(): Promise<{ stateVectorBase64: string }> {
    return Promise.resolve({
      stateVectorBase64: this.#store.stateVectorBase64,
    });
  }

  async compactCrdtField(): Promise<SyncularV2CrdtFieldCompactionReceipt> {
    const before = compactionStatsFromSnapshot(await this.crdtDocumentSnapshot());
    this.#persistState();
    this.#store.compactedAt = this.#store.updatedAt;
    const after = compactionStatsFromSnapshot(await this.crdtDocumentSnapshot());
    this.#emitRowsChanged('localWrite', { operation: 'compact' });
    return {
      checkpointCreated: false,
      clientCommitId: null,
      before,
      after,
      encryptedStreamBefore: null,
      encryptedStreamAfter: null,
    };
  }

  addRowsChangedListener(
    listener: (event: SyncularV2RowsChangedEvent) => void
  ): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  async syncPush(): Promise<void> {
    for (const entry of this.#store.updateLog) {
      if (entry.status === 'pending') {
        entry.status = 'acked';
        entry.flushedAt = this.#store.updatedAt + 1;
        entry.ackedAt = this.#store.updatedAt + 2;
      }
    }
  }

  #persistState(): void {
    this.#store.stateBase64 = bytesToBase64(Y.encodeStateAsUpdate(this.#doc));
    this.#store.stateVectorBase64 = bytesToBase64(
      Y.encodeStateVector(this.#doc)
    );
    this.#store.updatedAt += 1;
  }

  #emitRowsChanged(
    source: SyncularV2RowsChangedEvent['source'],
    row: Pick<SyncularV2ChangedRow, 'operation' | 'commitId'>
  ): void {
    const event: SyncularV2RowsChangedEvent = {
      source,
      changedTables: [this.#store.field.table],
      changedRows: [
        {
          table: this.#store.field.table,
          rowId: this.#store.field.rowId,
          operation: row.operation,
          changedFields: [this.#store.field.field, `${this.#store.field.field}_yjs_state`],
          crdtFields: [`${this.#store.field.field}_yjs_state`],
          commitId: row.commitId,
        },
      ],
    };
    for (const listener of this.#listeners) listener(event);
  }

  #documentKey(): string {
    return `${this.#store.field.table}:${this.#store.field.rowId}:${this.#store.field.field}`;
  }
}

function xmlFragmentToProseMirrorJson(fragment: Y.XmlFragment): unknown {
  const text = fragment
    .toArray()
    .map((item) => item.toString())
    .join(' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return {
    type: 'doc',
    content: text
      ? [
          {
            type: 'paragraph',
            content: [{ type: 'text', text }],
          },
        ]
      : [],
  };
}
