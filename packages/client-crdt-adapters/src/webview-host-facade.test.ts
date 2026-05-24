import { describe, expect, it } from 'bun:test';
import type {
  SyncularCrdtDocumentSnapshot,
  SyncularCrdtFieldCompactionReceipt,
  SyncularCrdtFieldDescriptor,
  SyncularCrdtFieldMaterialization,
  SyncularCrdtFieldRequest,
  SyncularCrdtFieldWriteReceipt,
  SyncularCrdtFieldYjsUpdateRequest,
  SyncularCrdtUpdateLogEntry,
  SyncularRowsChangedEvent,
} from '@syncular/client';
import {
  createSyncularCrdtHostResponseMessage,
  createSyncularCrdtJsonTransport,
  createSyncularCrdtRowsChangedMessage,
  createSyncularCrdtWebViewHost,
  createSyncularCrdtWebViewHostResponder,
  dispatchSyncularCrdtHostRequest,
  SYNCULAR_CRDT_WEBVIEW_REQUEST,
  type SyncularCrdtHostMessage,
  type SyncularCrdtHostRequestMessage,
  type SyncularCrdtWebViewTransport,
  syncularCrdtRowsChangedMessageFromNativeEvent,
  syncularCrdtRowsChangedMessageFromNativeEventJson,
} from './webview-host-facade';
import type { SyncularCrdtProjectionHost } from './yjs-document-field-adapter';

const field = {
  table: 'notes',
  rowId: 'note-1',
  field: 'body',
} satisfies SyncularCrdtFieldRequest;

function compactionStatsFromSnapshot(
  snapshot: SyncularCrdtDocumentSnapshot
): SyncularCrdtFieldCompactionReceipt['before'] {
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

describe('createSyncularCrdtWebViewHost', () => {
  it('proxies CRDT persistence requests to a host-owned responder', async () => {
    const transports = createTransportPair();
    const host = new FakeProjectionHost();
    const responder = createSyncularCrdtWebViewHostResponder({
      transport: transports.host,
      host,
    });
    const facade = createSyncularCrdtWebViewHost({
      transport: transports.webview,
      requestId: createDeterministicIds('request'),
    });

    await expect(facade.host.openCrdtField(field)).resolves.toEqual({
      ...field,
      stateColumn: 'body_yjs_state',
      containerKey: 'body',
      rowIdField: 'id',
      kind: 'prosemirror',
      syncMode: 'server-merge',
    });
    await expect(
      facade.host.enqueueCrdtFieldYjsUpdate?.({
        ...field,
        update: { updateId: 'update-1', updateBase64: 'AQID' },
      })
    ).resolves.toBe('queued-1');
    await expect(facade.host.crdtDocumentSnapshot?.(field)).resolves.toEqual(
      host.snapshot
    );
    await expect(
      facade.host.crdtUpdateLog?.({ ...field, limit: 1 })
    ).resolves.toEqual([host.updateLog[0]]);
    await expect(
      facade.host.snapshotCrdtFieldStateVector(field)
    ).resolves.toEqual({
      stateVectorBase64: 'vector-1',
    });

    expect(host.openRequests).toEqual([field]);
    expect(host.queuedUpdates).toHaveLength(1);
    expect(host.updateLogRequests).toEqual([{ ...field, limit: 1 }]);

    facade.close();
    responder.close();
  });

  it('fans out rows-changed events from the native host', async () => {
    const transports = createTransportPair();
    const host = new FakeProjectionHost();
    const responder = createSyncularCrdtWebViewHostResponder({
      transport: transports.host,
      host,
    });
    const facade = createSyncularCrdtWebViewHost({
      transport: transports.webview,
    });
    const received: SyncularRowsChangedEvent[] = [];
    const unsubscribe = facade.host.addRowsChangedListener((event) => {
      received.push(event);
    });
    const event: SyncularRowsChangedEvent = {
      source: 'remotePull',
      changedTables: ['notes'],
      changedRows: [
        {
          table: 'notes',
          rowId: 'note-1',
          operation: 'compact',
          changedFields: ['body'],
          crdtFields: ['body'],
          commitId: 'commit-1',
          commitSeq: 3,
          serverVersion: 10,
        },
      ],
    };

    host.emitRowsChanged(event);
    await nextMicrotask();

    expect(received).toEqual([event]);

    unsubscribe();
    facade.close();
    responder.close();
  });

  it('propagates host errors back to the WebView facade', async () => {
    const transports = createTransportPair();
    const host = new FakeProjectionHost();
    host.failNextOpen = true;
    const responder = createSyncularCrdtWebViewHostResponder({
      transport: transports.host,
      host,
    });
    const facade = createSyncularCrdtWebViewHost({
      transport: transports.webview,
    });

    await expect(facade.host.openCrdtField(field)).rejects.toThrow(
      'open failed'
    );

    facade.close();
    responder.close();
  });

  it('times out unanswered host requests', async () => {
    const transport = new MemoryTransport();
    const facade = createSyncularCrdtWebViewHost({
      transport,
      timeoutMs: 1,
    });

    await expect(facade.host.openCrdtField(field)).rejects.toThrow(
      'Syncular CRDT WebView host request timed out: openCrdtField'
    );

    facade.close();
  });

  it('rejects pending requests when closed', async () => {
    const transport = new MemoryTransport();
    const facade = createSyncularCrdtWebViewHost({
      transport,
      timeoutMs: 10_000,
    });
    const pending = facade.host.openCrdtField(field);

    facade.close();

    await expect(pending).rejects.toThrow(
      'Syncular CRDT WebView host closed before response'
    );
  });

  it('rejects immediately when the WebView channel cannot post', async () => {
    const facade = createSyncularCrdtWebViewHost({
      transport: {
        postMessage() {
          throw new Error('channel unavailable');
        },
        addMessageListener() {
          return () => {};
        },
      },
      timeoutMs: 10_000,
    });

    await expect(facade.host.openCrdtField(field)).rejects.toThrow(
      'channel unavailable'
    );

    facade.close();
  });

  it('can run over JSON-string WebView channels', async () => {
    const channels = createJsonChannelPair();
    const webview = createSyncularCrdtJsonTransport(channels.webview);
    const native = createSyncularCrdtJsonTransport(channels.native);
    const host = new FakeProjectionHost();
    const responder = createSyncularCrdtWebViewHostResponder({
      transport: native,
      host,
    });
    const facade = createSyncularCrdtWebViewHost({
      transport: webview,
      requestId: createDeterministicIds('json-request'),
    });

    await expect(facade.host.materializeCrdtField(field)).resolves.toEqual({
      value: { type: 'doc' },
      stateBase64: 'state-1',
      stateVectorBase64: 'vector-1',
    });

    expect(channels.webview.sent[0]).toContain(
      '"protocol":"syncular.crdt.host.v1"'
    );
    expect(channels.native.sent[0]).toContain('"ok":true');

    facade.close();
    responder.close();
  });

  it('reports invalid JSON transport messages without crashing listeners', () => {
    const invalid: string[] = [];
    let listener: ((message: string) => void) | undefined;
    const transport = createSyncularCrdtJsonTransport({
      postJsonMessage() {},
      addJsonMessageListener(next) {
        listener = next;
        return () => {
          listener = undefined;
        };
      },
      onInvalidMessage(_error, message) {
        invalid.push(message);
      },
    });
    const received: unknown[] = [];

    transport.addMessageListener((message) => {
      received.push(message);
    });
    listener?.('not json');
    listener?.('{"type":"unrelated"}');

    expect(invalid).toEqual(['not json']);
    expect(received).toEqual([]);
  });

  it('exposes a host request dispatcher for native protocol switches', async () => {
    const host = new FakeProjectionHost();
    const request = hostRequest('compactCrdtField', {
      ...field,
      minUncheckpointedUpdates: 25,
    });

    await expect(
      dispatchSyncularCrdtHostRequest(host, request)
    ).resolves.toMatchObject({
      checkpointCreated: true,
      clientCommitId: 'compact-1',
      before: compactionStatsFromSnapshot(host.snapshot),
      after: compactionStatsFromSnapshot(host.snapshot),
    });
    await expect(
      createSyncularCrdtHostResponseMessage(host, request)
    ).resolves.toMatchObject({
      id: 'host-request-1',
      ok: true,
      response: {
        checkpointCreated: true,
        clientCommitId: 'compact-1',
      },
    });
  });

  it('builds WebView rows-changed messages from native event JSON', () => {
    const nativeEvent = {
      event_seq: 7,
      kind: 'RowsChanged',
      tables: ['notes'],
      changedRows: [
        {
          table: 'notes',
          rowId: 'note-1',
          operation: 'update',
          changedFields: ['body'],
          crdtFields: ['body'],
          commitId: 'commit-2',
          commitSeq: 4,
          serverVersion: 11,
        },
      ],
      payload_json: {
        type: 'rowsChanged',
        source: 'remotePull',
      },
    };

    expect(syncularCrdtRowsChangedMessageFromNativeEvent(nativeEvent)).toEqual(
      createSyncularCrdtRowsChangedMessage({
        source: 'remotePull',
        changedTables: ['notes'],
        changedRows: nativeEvent.changedRows,
      })
    );
    expect(
      syncularCrdtRowsChangedMessageFromNativeEventJson(
        JSON.stringify(nativeEvent)
      )
    ).toEqual(
      createSyncularCrdtRowsChangedMessage({
        source: 'remotePull',
        changedTables: ['notes'],
        changedRows: nativeEvent.changedRows,
      })
    );
    expect(
      syncularCrdtRowsChangedMessageFromNativeEvent({
        kind: 'SyncCompleted',
        tables: ['notes'],
      })
    ).toBeUndefined();
  });
});

class MemoryTransport implements SyncularCrdtWebViewTransport {
  peer?: MemoryTransport;
  readonly messages: SyncularCrdtHostMessage[] = [];
  readonly #listeners = new Set<(message: unknown) => void>();

  postMessage(message: SyncularCrdtHostMessage): void {
    this.messages.push(message);
    queueMicrotask(() => {
      this.peer?.emit(message);
    });
  }

  addMessageListener(listener: (message: unknown) => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  emit(message: unknown): void {
    for (const listener of this.#listeners) listener(message);
  }
}

function createTransportPair(): {
  webview: MemoryTransport;
  host: MemoryTransport;
} {
  const webview = new MemoryTransport();
  const host = new MemoryTransport();
  webview.peer = host;
  host.peer = webview;
  return { webview, host };
}

function createJsonChannelPair(): {
  webview: JsonChannelEndpoint;
  native: JsonChannelEndpoint;
} {
  const webview = new JsonChannelEndpoint();
  const native = new JsonChannelEndpoint();
  webview.peer = native;
  native.peer = webview;
  return { webview, native };
}

class JsonChannelEndpoint {
  peer?: JsonChannelEndpoint;
  readonly sent: string[] = [];
  readonly #listeners = new Set<(message: string) => void>();

  postJsonMessage(message: string): void {
    this.sent.push(message);
    queueMicrotask(() => {
      this.peer?.emit(message);
    });
  }

  addJsonMessageListener(listener: (message: string) => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  emit(message: string): void {
    for (const listener of this.#listeners) listener(message);
  }
}

class FakeProjectionHost implements SyncularCrdtProjectionHost {
  readonly openRequests: SyncularCrdtFieldRequest[] = [];
  readonly appliedUpdates: SyncularCrdtFieldYjsUpdateRequest[] = [];
  readonly queuedUpdates: SyncularCrdtFieldYjsUpdateRequest[] = [];
  readonly updateLogRequests: Array<
    SyncularCrdtFieldRequest & { limit?: number }
  > = [];
  readonly #listeners = new Set<(event: SyncularRowsChangedEvent) => void>();
  failNextOpen = false;
  readonly snapshot: SyncularCrdtDocumentSnapshot = {
    ...field,
    documentKey: 'notes:note-1:body',
    stateColumn: 'body_yjs_state',
    syncMode: 'server-merge',
    stateBase64: 'state-1',
    stateVectorBase64: 'vector-1',
    pendingUpdates: 1,
    flushedUpdates: 2,
    ackedUpdates: 3,
    logUpdates: 4,
    updatedAt: 100,
    compactedAt: 90,
  };
  readonly updateLog: SyncularCrdtUpdateLogEntry[] = [
    {
      id: 1,
      documentKey: 'notes:note-1:body',
      updateId: 'update-1',
      clientCommitId: 'commit-1',
      origin: 'local',
      status: 'flushed',
      updateBase64: 'AQID',
      stateVectorBase64: 'vector-1',
      createdAt: 100,
      flushedAt: 101,
      ackedAt: null,
    },
  ];

  openCrdtField(
    request: SyncularCrdtFieldRequest
  ): Promise<SyncularCrdtFieldDescriptor> {
    this.openRequests.push(request);
    if (this.failNextOpen) {
      this.failNextOpen = false;
      return Promise.reject(new Error('open failed'));
    }
    return Promise.resolve({
      ...request,
      stateColumn: `${request.field}_yjs_state`,
      containerKey: request.field,
      rowIdField: 'id',
      kind: 'prosemirror',
      syncMode: 'server-merge',
    });
  }

  applyCrdtFieldYjsUpdate(
    request: SyncularCrdtFieldYjsUpdateRequest
  ): Promise<SyncularCrdtFieldWriteReceipt> {
    this.appliedUpdates.push(request);
    return Promise.resolve({
      clientCommitId: `commit-${this.appliedUpdates.length}`,
      syncMode: 'server-merge',
    });
  }

  enqueueCrdtFieldYjsUpdate(
    request: SyncularCrdtFieldYjsUpdateRequest
  ): Promise<string> {
    this.queuedUpdates.push(request);
    return Promise.resolve(`queued-${this.queuedUpdates.length}`);
  }

  materializeCrdtField(): Promise<SyncularCrdtFieldMaterialization> {
    return Promise.resolve({
      value: { type: 'doc' },
      stateBase64: 'state-1',
      stateVectorBase64: 'vector-1',
    });
  }

  crdtDocumentSnapshot(): Promise<SyncularCrdtDocumentSnapshot> {
    return Promise.resolve(this.snapshot);
  }

  crdtUpdateLog(
    request: SyncularCrdtFieldRequest & { limit?: number }
  ): Promise<SyncularCrdtUpdateLogEntry[]> {
    this.updateLogRequests.push(request);
    return Promise.resolve(this.updateLog.slice(0, request.limit));
  }

  snapshotCrdtFieldStateVector(): Promise<{ stateVectorBase64: string }> {
    return Promise.resolve({ stateVectorBase64: 'vector-1' });
  }

  compactCrdtField(): Promise<SyncularCrdtFieldCompactionReceipt> {
    const stats = compactionStatsFromSnapshot(this.snapshot);
    return Promise.resolve({
      checkpointCreated: true,
      clientCommitId: 'compact-1',
      before: stats,
      after: stats,
      encryptedStreamBefore: null,
      encryptedStreamAfter: null,
    });
  }

  addRowsChangedListener(
    listener: (event: SyncularRowsChangedEvent) => void
  ): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  emitRowsChanged(event: SyncularRowsChangedEvent): void {
    for (const listener of this.#listeners) listener(event);
  }
}

function createDeterministicIds(prefix: string): () => string {
  let next = 0;
  return () => `${prefix}-${++next}`;
}

function hostRequest<Method extends SyncularCrdtHostRequestMessage['method']>(
  method: Method,
  request: Extract<
    SyncularCrdtHostRequestMessage,
    { method: Method }
  >['request']
): Extract<SyncularCrdtHostRequestMessage, { method: Method }> {
  return {
    protocol: 'syncular.crdt.host.v1',
    type: SYNCULAR_CRDT_WEBVIEW_REQUEST,
    id: 'host-request-1',
    method,
    request,
  } as Extract<SyncularCrdtHostRequestMessage, { method: Method }>;
}

function nextMicrotask(): Promise<void> {
  return new Promise((resolve) => queueMicrotask(resolve));
}
