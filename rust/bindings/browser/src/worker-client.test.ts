import { describe, expect, it } from 'bun:test';
import {
  SYNCULAR_V2_PACKAGE_NAME,
  SYNCULAR_V2_PACKAGE_VERSION,
} from './runtime-contract';
import type {
  SyncularV2BootstrapStatus,
  SyncularV2DiagnosticEvent,
  SyncularV2LifecycleState,
} from './types';
import {
  createSyncularV2WorkerClient,
  SyncularV2WorkerClient,
} from './worker-client';
import {
  SYNCULAR_V2_WORKER_PROTOCOL_VERSION,
  type SyncularV2WorkerEvent,
  type SyncularV2WorkerOutboundMessage,
  type SyncularV2WorkerRequest,
  type SyncularV2WorkerResponse,
} from './worker-protocol';

describe('Syncular v2 worker client', () => {
  it('rejects structured worker errors', async () => {
    const worker = new FakeWorker();
    const client = new SyncularV2WorkerClient(worker.asWorker(), {
      ownsWorker: false,
      requestTimeoutMs: 100,
    });

    const promise = client.executeSql('select 1');
    const request = worker.messages[0]!;
    worker.respond({
      id: request.id,
      protocolVersion: SYNCULAR_V2_WORKER_PROTOCOL_VERSION,
      ok: false,
      error: {
        code: 'sync.schema_mismatch',
        message: 'not open',
        category: 'schema-mismatch',
        retryable: false,
        recommendedAction: 'regenerateClient',
        details: { method: request.type },
      },
    });

    await expect(promise).rejects.toMatchObject({
      code: 'sync.schema_mismatch',
      category: 'schema-mismatch',
      retryable: false,
      recommendedAction: 'regenerateClient',
      message: 'not open',
      details: { method: 'executeSql' },
    });
  });

  it('rejects public mutating SQL before sending it to the worker', async () => {
    const worker = new FakeWorker();
    const client = new SyncularV2WorkerClient(worker.asWorker(), {
      ownsWorker: false,
      requestTimeoutMs: 100,
    });

    await expect(
      client.executeSql('insert into tasks (id) values (?)', ['1'])
    ).rejects.toThrow('public SQL is read-only');
    expect(worker.messages).toEqual([]);
  });

  it('does not drain live-query events after readonly SQL', async () => {
    const worker = new FakeWorker();
    const client = new SyncularV2WorkerClient(worker.asWorker(), {
      ownsWorker: false,
      requestTimeoutMs: 100,
    });

    const promise = client.executeSql('select 1');
    expect(worker.messages[0]).toMatchObject({ type: 'executeSql' });
    worker.respond({
      id: worker.messages[0]!.id,
      protocolVersion: SYNCULAR_V2_WORKER_PROTOCOL_VERSION,
      ok: true,
      value: { rows: [{ value: 1 }] },
    });

    await expect(promise).resolves.toEqual({ rows: [{ value: 1 }] });
    expect(worker.messages.map((message) => message.type)).toEqual([
      'executeSql',
    ]);
  });

  it('keeps unsafe SQL on an explicit internal worker request', async () => {
    const worker = new FakeWorker();
    const client = new SyncularV2WorkerClient(worker.asWorker(), {
      ownsWorker: false,
      requestTimeoutMs: 100,
    });

    const promise = client.executeUnsafeSql('create table setup (id text)');
    const request = worker.messages[0]!;
    expect(request).toMatchObject({
      type: 'executeUnsafeSql',
      sql: 'create table setup (id text)',
    });
    worker.respond({
      id: request.id,
      protocolVersion: SYNCULAR_V2_WORKER_PROTOCOL_VERSION,
      ok: true,
      value: { rows: [], numAffectedRows: 0 },
    });

    await expect(promise).resolves.toEqual({ rows: [], numAffectedRows: 0 });
  });

  it('forwards conflict summary and resolution requests to the worker', async () => {
    const worker = new FakeWorker();
    const client = new SyncularV2WorkerClient(worker.asWorker(), {
      ownsWorker: false,
      requestTimeoutMs: 100,
    });

    const summaries = client.conflictSummaries();
    expect(worker.messages[0]).toMatchObject({ type: 'conflictSummaries' });
    worker.respond({
      id: worker.messages[0]!.id,
      protocolVersion: SYNCULAR_V2_WORKER_PROTOCOL_VERSION,
      ok: true,
      value: [
        {
          id: 'conflict-1',
          clientCommitId: 'commit-1',
          opIndex: 0,
          resultStatus: 'conflict',
          message: 'version conflict',
          code: 'sync.version_conflict',
          serverVersion: 9,
          resolvedAt: null,
          resolution: null,
        },
      ],
    });
    await expect(summaries).resolves.toEqual([
      expect.objectContaining({
        id: 'conflict-1',
        code: 'sync.version_conflict',
      }),
    ]);

    const retry = client.retryConflictKeepLocal('conflict-1');
    expect(worker.messages[1]).toMatchObject({
      type: 'retryConflictKeepLocal',
      conflictId: 'conflict-1',
    });
    worker.respond({
      id: worker.messages[1]!.id,
      protocolVersion: SYNCULAR_V2_WORKER_PROTOCOL_VERSION,
      ok: true,
      value: 'commit-retry',
    });
    await waitForMessages(worker, 3);
    expect(worker.messages[2]).toMatchObject({ type: 'drainLiveQueryEvents' });
    worker.respond({
      id: worker.messages[2]!.id,
      protocolVersion: SYNCULAR_V2_WORKER_PROTOCOL_VERSION,
      ok: true,
      value: [],
    });
    await expect(retry).resolves.toBe('commit-retry');

    const resolve = client.resolveConflict('conflict-1', 'keep-server');
    expect(worker.messages[3]).toMatchObject({
      type: 'resolveConflict',
      conflictId: 'conflict-1',
      resolution: 'keep-server',
    });
    worker.respond({
      id: worker.messages[3]!.id,
      protocolVersion: SYNCULAR_V2_WORKER_PROTOCOL_VERSION,
      ok: true,
      value: true,
    });
    await waitForMessages(worker, 5);
    expect(worker.messages[4]).toMatchObject({ type: 'drainLiveQueryEvents' });
    worker.respond({
      id: worker.messages[4]!.id,
      protocolVersion: SYNCULAR_V2_WORKER_PROTOCOL_VERSION,
      ok: true,
      value: [],
    });
    await expect(resolve).resolves.toBeUndefined();
  });

  it('forwards generic CRDT field requests to the worker', async () => {
    const worker = new FakeWorker();
    const client = new SyncularV2WorkerClient(worker.asWorker(), {
      ownsWorker: false,
      requestTimeoutMs: 100,
    });

    const field = { table: 'tasks', rowId: 'task-1', field: 'title' };
    const openPromise = client.openCrdtField(field);
    expect(worker.messages[0]).toMatchObject({
      type: 'openCrdtField',
      request: field,
    });
    worker.respond({
      id: worker.messages[0]!.id,
      protocolVersion: SYNCULAR_V2_WORKER_PROTOCOL_VERSION,
      ok: true,
      value: {
        ...field,
        stateColumn: 'title_yjs_state',
        containerKey: 'title',
        rowIdField: 'id',
        kind: 'text',
        syncMode: 'server-merge',
      },
    });
    await expect(openPromise).resolves.toMatchObject({
      stateColumn: 'title_yjs_state',
    });

    const writePromise = client.applyCrdtFieldYjsUpdate({
      ...field,
      update: { updateId: 'u1', updateBase64: 'AA' },
    });
    expect(worker.messages[1]).toMatchObject({
      type: 'applyCrdtFieldYjsUpdate',
      request: { table: 'tasks', rowId: 'task-1', field: 'title' },
    });
    worker.respond({
      id: worker.messages[1]!.id,
      protocolVersion: SYNCULAR_V2_WORKER_PROTOCOL_VERSION,
      ok: true,
      value: { clientCommitId: 'commit-1', syncMode: 'server-merge' },
    });
    await waitForMessages(worker, 3);
    expect(worker.messages[2]).toMatchObject({ type: 'drainLiveQueryEvents' });
    worker.respond({
      id: worker.messages[2]!.id,
      protocolVersion: SYNCULAR_V2_WORKER_PROTOCOL_VERSION,
      ok: true,
      value: [],
    });
    await expect(writePromise).resolves.toEqual({
      clientCommitId: 'commit-1',
      syncMode: 'server-merge',
    });
  });

  it('times out requests and sends best-effort cancel', async () => {
    const worker = new FakeWorker();
    const diagnostics: SyncularV2DiagnosticEvent[] = [];
    const client = new SyncularV2WorkerClient(worker.asWorker(), {
      ownsWorker: false,
      requestTimeoutMs: 1,
      diagnostics: (event) => diagnostics.push(event),
    });

    await expect(client.executeSql('select 1')).rejects.toMatchObject({
      code: 'worker.request_timeout',
      retryable: true,
      recommendedAction: 'retryLater',
    });
    expect(worker.messages.map((message) => message.type)).toEqual([
      'executeSql',
      'cancel',
    ]);
    expect(worker.messages[1]).toMatchObject({
      requestId: worker.messages[0]!.id,
      protocolVersion: SYNCULAR_V2_WORKER_PROTOCOL_VERSION,
    });
    expect(diagnostics).toEqual([
      expect.objectContaining({
        level: 'warn',
        source: 'worker',
        code: 'worker.request_timeout',
        details: expect.objectContaining({ requestType: 'executeSql' }),
      }),
    ]);
  });

  it('returns worker runtime information', async () => {
    const worker = new FakeWorker();
    const client = new SyncularV2WorkerClient(worker.asWorker(), {
      ownsWorker: false,
      requestTimeoutMs: 100,
    });

    const promise = client.runtimeInfo();
    const request = worker.messages[0]!;
    expect(request.type).toBe('runtimeInfo');
    worker.respond({
      id: request.id,
      protocolVersion: SYNCULAR_V2_WORKER_PROTOCOL_VERSION,
      ok: true,
      value: {
        packageName: SYNCULAR_V2_PACKAGE_NAME,
        packageVersion: SYNCULAR_V2_PACKAGE_VERSION,
        workerProtocolVersion: SYNCULAR_V2_WORKER_PROTOCOL_VERSION,
        storage: 'opfsSahPool',
        workerUrl: 'http://localhost/syncular-v2-worker.js',
        wasmGlueUrl: 'http://localhost/wasm/syncular_v2.js',
        wasmUrl: 'http://localhost/wasm/syncular_v2_bg.wasm',
        rust: {
          crateName: 'syncular-runtime',
          crateVersion: '0.1.0',
          schemaVersion: 1,
          features: ['web-owned-sqlite'],
        },
      },
    });

    await expect(promise).resolves.toMatchObject({
      packageName: SYNCULAR_V2_PACKAGE_NAME,
      workerProtocolVersion: SYNCULAR_V2_WORKER_PROTOCOL_VERSION,
      storage: 'opfsSahPool',
      rust: { features: ['web-owned-sqlite'] },
    });
  });

  it('selects compatible runtime artifacts before opening the worker', async () => {
    const worker = new FakeWorker();
    const promise = createSyncularV2WorkerClient({
      worker: worker.asWorker(),
      config: {
        baseUrl: '/sync',
        actorId: 'actor',
        clientId: 'client',
      },
      requiredRuntimeFeatures: ['web-owned-sqlite-core'],
      runtimeArtifacts: [
        {
          name: 'core',
          features: ['web-owned-sqlite-core'],
          wasmGlueUrl: '/syncular/wasm-core/syncular_v2.js',
          wasmUrl: new URL(
            'https://app.test/syncular/wasm-core/syncular_v2_bg.wasm'
          ),
        },
        {
          name: 'full',
          features: [
            'web-owned-sqlite-core',
            'web-owned-sqlite',
            'blobs',
            'crdt-yjs',
            'e2ee',
          ],
          wasmGlueUrl: '/syncular/wasm/syncular_v2.js',
          wasmUrl: '/syncular/wasm/syncular_v2_bg.wasm',
        },
      ],
    });
    await waitForMessages(worker, 1);
    expect(worker.messages[0]).toMatchObject({
      type: 'open',
      runtime: {
        wasmGlueUrl: '/syncular/wasm-core/syncular_v2.js',
        wasmUrl: 'https://app.test/syncular/wasm-core/syncular_v2_bg.wasm',
      },
    });
    worker.respond({
      id: worker.messages[0]!.id,
      protocolVersion: SYNCULAR_V2_WORKER_PROTOCOL_VERSION,
      ok: true,
      value: true,
    });
    await expect(promise).resolves.toBeInstanceOf(SyncularV2WorkerClient);
  });

  it('rejects opening when no runtime artifact satisfies required features', async () => {
    const worker = new FakeWorker();
    await expect(
      createSyncularV2WorkerClient({
        worker: worker.asWorker(),
        config: {
          baseUrl: '/sync',
          actorId: 'actor',
          clientId: 'client',
        },
        requiredRuntimeFeatures: ['e2ee'],
        runtimeArtifacts: [
          {
            name: 'core',
            features: ['web-owned-sqlite-core'],
            wasmGlueUrl: '/syncular/wasm-core/syncular_v2.js',
            wasmUrl: '/syncular/wasm-core/syncular_v2_bg.wasm',
          },
        ],
      })
    ).rejects.toThrow('No Syncular Rust runtime artifact satisfies');
    expect(worker.messages).toEqual([]);
  });

  it('reports connection state for UI surfaces', async () => {
    const worker = new FakeWorker();
    const client = new SyncularV2WorkerClient(worker.asWorker(), {
      ownsWorker: false,
      requestTimeoutMs: 100,
    });

    expect(client.connectionState()).toMatchObject({
      closed: false,
      pendingRequests: 0,
      realtime: 'disconnected',
    });

    const runtimePromise = client.runtimeInfo();
    expect(client.connectionState()).toMatchObject({
      pendingRequests: 1,
    });
    worker.respond({
      id: worker.messages[0]!.id,
      protocolVersion: SYNCULAR_V2_WORKER_PROTOCOL_VERSION,
      ok: true,
      value: {
        packageName: SYNCULAR_V2_PACKAGE_NAME,
        packageVersion: SYNCULAR_V2_PACKAGE_VERSION,
        workerProtocolVersion: SYNCULAR_V2_WORKER_PROTOCOL_VERSION,
        wasmGlueUrl: 'http://localhost/wasm/syncular_v2.js',
        wasmUrl: 'http://localhost/wasm/syncular_v2_bg.wasm',
      },
    });
    await runtimePromise;
    expect(client.connectionState()).toMatchObject({ pendingRequests: 0 });

    worker.emit({
      protocolVersion: SYNCULAR_V2_WORKER_PROTOCOL_VERSION,
      type: 'realtimeState',
      state: 'connected',
    });
    expect(client.connectionState()).toMatchObject({
      realtime: 'connected',
      lastDiagnostic: {
        source: 'realtime',
        code: 'realtime.state',
      },
    });

    const failed = client.executeSql('select broken');
    worker.respond({
      id: worker.messages[1]!.id,
      protocolVersion: SYNCULAR_V2_WORKER_PROTOCOL_VERSION,
      ok: false,
      error: {
        code: 'worker.failed',
        message: 'broken',
      },
    });
    await expect(failed).rejects.toThrow('broken');
    expect(client.connectionState()).toMatchObject({
      lastError: {
        code: 'worker.failed',
        message: 'broken',
      },
    });
  });

  it('emits lifecycle state for app UI surfaces', () => {
    const worker = new FakeWorker();
    const client = new SyncularV2WorkerClient(worker.asWorker(), {
      ownsWorker: false,
      requestTimeoutMs: 100,
    });
    const events: SyncularV2LifecycleState[] = [];
    client.addEventListener('lifecycleChanged', (event) => events.push(event));

    expect(client.lifecycleState()).toMatchObject({
      phase: 'offline',
      realtime: 'disconnected',
      online: false,
      requiresAction: false,
    });

    worker.emit({
      protocolVersion: SYNCULAR_V2_WORKER_PROTOCOL_VERSION,
      type: 'realtimeState',
      state: 'connecting',
    });
    expect(events.at(-1)).toMatchObject({
      phase: 'connecting',
      realtime: 'connecting',
    });

    worker.emit({
      protocolVersion: SYNCULAR_V2_WORKER_PROTOCOL_VERSION,
      type: 'diagnostic',
      event: {
        at: 123,
        level: 'error',
        source: 'sync',
        code: 'sync.resync_required',
        message: 'resync required',
        details: { resyncRequired: true },
      },
    });
    expect(events.at(-1)).toMatchObject({
      phase: 'recovering',
      lastDiagnostic: { code: 'sync.resync_required' },
    });

    worker.emit({
      protocolVersion: SYNCULAR_V2_WORKER_PROTOCOL_VERSION,
      type: 'diagnostic',
      event: {
        at: 124,
        level: 'warn',
        source: 'auth',
        code: 'auth.refresh_failed',
        message: 'auth refresh failed',
      },
    });
    expect(events.at(-1)).toMatchObject({
      phase: 'authRequired',
      requiresAction: true,
    });

    worker.emit({
      protocolVersion: SYNCULAR_V2_WORKER_PROTOCOL_VERSION,
      type: 'realtimeState',
      state: 'connected',
    });
    worker.emit({
      protocolVersion: SYNCULAR_V2_WORKER_PROTOCOL_VERSION,
      type: 'bootstrapChanged',
      bootstrap: zeroBootstrapStatus(),
    });
    expect(events.at(-1)).toMatchObject({
      phase: 'complete',
      bootstrap: { complete: true, progressPercent: 100 },
      requiresAction: false,
    });
  });

  it('emits blob upload queue stats through lifecycle events', async () => {
    const worker = new FakeWorker();
    const client = new SyncularV2WorkerClient(worker.asWorker(), {
      ownsWorker: false,
      requestTimeoutMs: 100,
    });
    const lifecycleEvents: SyncularV2LifecycleState[] = [];
    const blobUploadEvents: Array<{
      pending: number;
      uploading: number;
      failed: number;
    }> = [];
    client.addEventListener('lifecycleChanged', (event) =>
      lifecycleEvents.push(event)
    );
    client.addEventListener('blobUploadsChanged', (event) =>
      blobUploadEvents.push(event)
    );

    const store = client.storeBlob(new Uint8Array([1, 2, 3]), {
      mimeType: 'application/test',
    });
    expect(worker.messages[0]).toMatchObject({ type: 'storeBlob' });
    worker.respond({
      id: worker.messages[0]!.id,
      protocolVersion: SYNCULAR_V2_WORKER_PROTOCOL_VERSION,
      ok: true,
      value: {
        hash: `sha256:${'0'.repeat(64)}`,
        size: 3,
        mimeType: 'application/test',
      },
    });
    await expect(store).resolves.toMatchObject({ size: 3 });

    await waitForMessages(worker, 4);
    expect(worker.messages.slice(1).map((message) => message.type)).toEqual([
      'executeUnsafeSql',
      'executeUnsafeSql',
      'blobUploadQueueStats',
    ]);
    worker.respond({
      id: worker.messages[1]!.id,
      protocolVersion: SYNCULAR_V2_WORKER_PROTOCOL_VERSION,
      ok: true,
      value: { rows: [] },
    });
    worker.respond({
      id: worker.messages[2]!.id,
      protocolVersion: SYNCULAR_V2_WORKER_PROTOCOL_VERSION,
      ok: true,
      value: { rows: [{ unresolved: 0, resolved: 0, total: 0 }] },
    });
    worker.respond({
      id: worker.messages[3]!.id,
      protocolVersion: SYNCULAR_V2_WORKER_PROTOCOL_VERSION,
      ok: true,
      value: { pending: 1, uploading: 0, failed: 0 },
    });

    await waitFor(() => blobUploadEvents.length > 0);
    expect(blobUploadEvents.at(-1)).toEqual({
      pending: 1,
      uploading: 0,
      failed: 0,
    });
    expect(lifecycleEvents.at(-1)).toMatchObject({
      blobUploads: { pending: 1, uploading: 0, failed: 0 },
      requiresAction: false,
    });

    const process = client.processBlobUploadQueue();
    await waitForMessages(worker, 5);
    expect(worker.messages[4]).toMatchObject({
      type: 'processBlobUploadQueue',
    });
    worker.respond({
      id: worker.messages[4]!.id,
      protocolVersion: SYNCULAR_V2_WORKER_PROTOCOL_VERSION,
      ok: true,
      value: { uploaded: 0, failed: 1 },
    });
    await expect(process).resolves.toEqual({ uploaded: 0, failed: 1 });

    await waitForMessages(worker, 8);
    worker.respond({
      id: worker.messages[5]!.id,
      protocolVersion: SYNCULAR_V2_WORKER_PROTOCOL_VERSION,
      ok: true,
      value: { rows: [] },
    });
    worker.respond({
      id: worker.messages[6]!.id,
      protocolVersion: SYNCULAR_V2_WORKER_PROTOCOL_VERSION,
      ok: true,
      value: { rows: [{ unresolved: 0, resolved: 0, total: 0 }] },
    });
    worker.respond({
      id: worker.messages[7]!.id,
      protocolVersion: SYNCULAR_V2_WORKER_PROTOCOL_VERSION,
      ok: true,
      value: { pending: 0, uploading: 0, failed: 1 },
    });

    await waitFor(() => blobUploadEvents.at(-1)?.failed === 1);
    expect(lifecycleEvents.at(-1)).toMatchObject({
      phase: 'degraded',
      requiresAction: true,
      blobUploads: { pending: 0, uploading: 0, failed: 1 },
    });
  });

  it('returns a redacted diagnostic snapshot for support tools', async () => {
    const worker = new FakeWorker();
    const client = new SyncularV2WorkerClient(worker.asWorker(), {
      ownsWorker: false,
      requestTimeoutMs: 100,
    });

    const setSubscriptions = client.setSubscriptions([
      {
        id: 'tasks-primary',
        table: 'tasks',
        scopes: {
          user_id: 'secret-user-id',
          organization_id: ['secret-org-a', 'secret-org-b'],
        },
        params: { limit: 50 },
        bootstrapPhase: 1,
      },
    ]);
    worker.respond({
      id: worker.messages[0]!.id,
      protocolVersion: SYNCULAR_V2_WORKER_PROTOCOL_VERSION,
      ok: true,
      value: true,
    });
    await setSubscriptions;

    worker.emit({
      protocolVersion: SYNCULAR_V2_WORKER_PROTOCOL_VERSION,
      type: 'diagnostic',
      event: {
        at: 123,
        level: 'info',
        source: 'sync',
        code: 'sync.pull.applied',
        message: 'Pull applied',
        syncAttemptId: 'sync-attempt-1',
        subscriptionId: 'tasks-primary',
        table: 'tasks',
        cursor: 42,
      },
    });
    worker.emit({
      protocolVersion: SYNCULAR_V2_WORKER_PROTOCOL_VERSION,
      type: 'bootstrapChanged',
      bootstrap: {
        ...zeroBootstrapStatus(),
        channelPhase: 'live',
        complete: true,
        expectedSubscriptionIds: ['tasks-primary'],
        readySubscriptionIds: ['tasks-primary'],
        subscriptions: [
          {
            id: 'tasks-primary',
            table: 'tasks',
            expected: true,
            ready: true,
            status: 'ok',
            phase: 'live',
            progressPercent: 100,
            cursor: 42,
            bootstrapPhase: 1,
            bootstrapState: {
              asOfCommitSeq: 7,
              tables: ['tasks'],
              tableIndex: 0,
              rowCursor: null,
            },
          },
        ],
      },
    });

    const snapshot = client.diagnosticSnapshot();
    await waitForMessages(worker, 3);
    worker.respond({
      id: worker.messages[1]!.id,
      protocolVersion: SYNCULAR_V2_WORKER_PROTOCOL_VERSION,
      ok: true,
      value: {
        packageName: SYNCULAR_V2_PACKAGE_NAME,
        packageVersion: SYNCULAR_V2_PACKAGE_VERSION,
        workerProtocolVersion: SYNCULAR_V2_WORKER_PROTOCOL_VERSION,
        wasmGlueUrl: 'http://localhost/wasm/syncular_v2.js',
        wasmUrl: 'http://localhost/wasm/syncular_v2_bg.wasm',
      },
    });
    worker.respond({
      id: worker.messages[2]!.id,
      protocolVersion: SYNCULAR_V2_WORKER_PROTOCOL_VERSION,
      ok: true,
      value: zeroTransportStats(),
    });
    await waitForMessages(worker, 4);
    worker.respond({
      id: worker.messages[3]!.id,
      protocolVersion: SYNCULAR_V2_WORKER_PROTOCOL_VERSION,
      ok: true,
      value: { rows: [{ status: 'pending', count: 2 }] },
    });
    await waitForMessages(worker, 5);
    worker.respond({
      id: worker.messages[4]!.id,
      protocolVersion: SYNCULAR_V2_WORKER_PROTOCOL_VERSION,
      ok: true,
      value: { rows: [{ unresolved: 1, resolved: 2, total: 3 }] },
    });
    await waitForMessages(worker, 6);
    worker.respond({
      id: worker.messages[5]!.id,
      protocolVersion: SYNCULAR_V2_WORKER_PROTOCOL_VERSION,
      ok: true,
      value: { pending: 4, uploading: 0, failed: 1 },
    });

    await expect(snapshot).resolves.toMatchObject({
      connection: {
        realtime: 'disconnected',
        lastDiagnostic: {
          code: 'sync.pull.applied',
          syncAttemptId: 'sync-attempt-1',
        },
      },
      subscriptions: [
        {
          id: 'tasks-primary',
          table: 'tasks',
          scopeKeys: ['organization_id', 'user_id'],
          scopeValueCount: 3,
          paramsKeys: ['limit'],
          paramsValueCount: 1,
          ready: true,
          phase: 'live',
          cursor: 42,
        },
      ],
      recentDiagnostics: [
        {
          code: 'sync.pull.applied',
          syncAttemptId: 'sync-attempt-1',
          subscriptionId: 'tasks-primary',
          table: 'tasks',
          cursor: 42,
        },
      ],
      outboxStats: { pending: 2, total: 2 },
      conflictStats: { unresolved: 1, resolved: 2, total: 3 },
      blobUploadStats: { pending: 4, uploading: 0, failed: 1 },
    });
    expect(JSON.stringify(await snapshot)).not.toContain('secret-user-id');
  });

  it('falls back to IndexedDB when default OPFS open fails', async () => {
    const worker = new FakeWorker();
    const promise = createSyncularV2WorkerClient({
      worker: worker.asWorker(),
      requestTimeoutMs: 100,
      config: {
        baseUrl: '/sync',
        actorId: 'actor',
        clientId: 'client',
      },
    });

    await waitForMessages(worker, 1);
    expect(worker.messages[0]).toMatchObject({
      type: 'open',
      config: { storage: 'opfsSahPool' },
    });
    worker.respond({
      id: worker.messages[0]!.id,
      protocolVersion: SYNCULAR_V2_WORKER_PROTOCOL_VERSION,
      ok: false,
      error: {
        code: 'worker.failed',
        message: 'Storage: install opfs-sahpool vfs: sync access handle failed',
      },
    });

    await waitForMessages(worker, 2);
    expect(worker.messages[1]).toMatchObject({
      type: 'open',
      config: { storage: 'indexedDb' },
    });
    worker.respond({
      id: worker.messages[1]!.id,
      protocolVersion: SYNCULAR_V2_WORKER_PROTOCOL_VERSION,
      ok: true,
      value: true,
    });

    const client = await promise;
    const runtimePromise = client.runtimeInfo();
    await waitForMessages(worker, 3);
    worker.respond({
      id: worker.messages[2]!.id,
      protocolVersion: SYNCULAR_V2_WORKER_PROTOCOL_VERSION,
      ok: true,
      value: {
        packageName: SYNCULAR_V2_PACKAGE_NAME,
        packageVersion: SYNCULAR_V2_PACKAGE_VERSION,
        workerProtocolVersion: SYNCULAR_V2_WORKER_PROTOCOL_VERSION,
        storage: 'indexedDb',
        wasmGlueUrl: 'http://localhost/wasm/syncular_v2.js',
        wasmUrl: 'http://localhost/wasm/syncular_v2_bg.wasm',
      },
    });
    await expect(runtimePromise).resolves.toMatchObject({
      storage: 'indexedDb',
      storageFallback: {
        from: 'opfsSahPool',
        to: 'indexedDb',
      },
    });
  });

  it('passes fresh auth headers through the worker before sync', async () => {
    const worker = new FakeWorker();
    let token = 'token-1';
    const promise = createSyncularV2WorkerClient({
      worker: worker.asWorker(),
      requestTimeoutMs: 100,
      getHeaders: () => ({ authorization: `Bearer ${token}` }),
      config: {
        baseUrl: '/sync',
        actorId: 'actor',
        clientId: 'client',
      },
    });

    await waitForMessages(worker, 1);
    worker.respond({
      id: worker.messages[0]!.id,
      protocolVersion: SYNCULAR_V2_WORKER_PROTOCOL_VERSION,
      ok: true,
      value: true,
    });

    await waitForMessages(worker, 2);
    expect(worker.messages[1]).toMatchObject({
      type: 'setAuthHeaders',
      headers: { authorization: 'Bearer token-1' },
    });
    worker.respond({
      id: worker.messages[1]!.id,
      protocolVersion: SYNCULAR_V2_WORKER_PROTOCOL_VERSION,
      ok: true,
      value: true,
    });

    const client = await promise;
    token = 'token-2';
    const syncPromise = client.syncOnce();

    await waitForMessages(worker, 3);
    expect(worker.messages[2]).toMatchObject({
      type: 'setAuthHeaders',
      headers: { authorization: 'Bearer token-2' },
    });
    worker.respond({
      id: worker.messages[2]!.id,
      protocolVersion: SYNCULAR_V2_WORKER_PROTOCOL_VERSION,
      ok: true,
      value: true,
    });

    await waitForMessages(worker, 4);
    const syncRequest = worker.messages[3] as Extract<
      SyncularV2WorkerRequest,
      { type: 'syncOnce' }
    >;
    const syncAttempt = syncRequest.syncAttempt;
    expect(syncRequest.type).toBe('syncOnce');
    expect(syncAttempt?.syncAttemptId).toMatch(/^[0-9a-f]{32}$/);
    expect(syncAttempt?.spanId).toMatch(/^[0-9a-f]{16}$/);
    expect(syncAttempt?.syncAttemptId).toBe(syncAttempt?.traceId);
    expect(syncAttempt?.traceparent).toBe(
      `00-${syncAttempt?.traceId}-${syncAttempt?.spanId}-01`
    );
    worker.respond({
      id: syncRequest.id,
      protocolVersion: SYNCULAR_V2_WORKER_PROTOCOL_VERSION,
      ok: true,
      value: {
        changedTables: [],
        changedRows: [],
        changedRowsTruncated: false,
        subscriptions: [],
        bootstrap: zeroBootstrapStatus(),
        pushedCommits: 0,
      },
    });

    await waitForMessages(worker, 5);
    expect(worker.messages[4]).toMatchObject({ type: 'drainLiveQueryEvents' });
    worker.respond({
      id: worker.messages[4]!.id,
      protocolVersion: SYNCULAR_V2_WORKER_PROTOCOL_VERSION,
      ok: true,
      value: [],
    });

    await expect(syncPromise).resolves.toEqual({
      changedTables: [],
      changedRows: [],
      changedRowsTruncated: false,
      subscriptions: [],
      bootstrap: zeroBootstrapStatus(),
      pushedCommits: 0,
    });
  });

  it('forwards field encryption config and helper calls', async () => {
    const worker = new FakeWorker();
    const client = new SyncularV2WorkerClient(worker.asWorker(), {
      ownsWorker: false,
      requestTimeoutMs: 100,
    });

    const setPromise = client.setFieldEncryption({
      rules: [{ scope: 'tasks', table: 'tasks', fields: ['title'] }],
      keys: { default: new Uint8Array(32).fill(7) },
    });
    await waitForMessages(worker, 1);
    expect(worker.messages[0]).toMatchObject({
      type: 'setFieldEncryption',
      config: {
        rules: [{ scope: 'tasks', table: 'tasks', fields: ['title'] }],
        keys: { default: 'BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc' },
      },
    });
    worker.respond({
      id: worker.messages[0]!.id,
      protocolVersion: SYNCULAR_V2_WORKER_PROTOCOL_VERSION,
      ok: true,
      value: true,
    });
    await expect(setPromise).resolves.toBeUndefined();

    const setCrdtPromise = client.setEncryptedCrdt({
      keys: { default: new Uint8Array(32).fill(9) },
    });
    await waitForMessages(worker, 2);
    expect(worker.messages[1]).toMatchObject({
      type: 'setEncryptedCrdt',
      config: {
        keys: { default: 'CQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQk' },
      },
    });
    worker.respond({
      id: worker.messages[1]!.id,
      protocolVersion: SYNCULAR_V2_WORKER_PROTOCOL_VERSION,
      ok: true,
      value: true,
    });
    await expect(setCrdtPromise).resolves.toBeUndefined();

    const helperPromise = client.encryptionHelper('generateSymmetricKey');
    await waitForMessages(worker, 3);
    expect(worker.messages[2]).toMatchObject({
      type: 'encryptionHelper',
      method: 'generateSymmetricKey',
    });
    worker.respond({
      id: worker.messages[2]!.id,
      protocolVersion: SYNCULAR_V2_WORKER_PROTOCOL_VERSION,
      ok: true,
      value: 'abc',
    });
    await expect(helperPromise).resolves.toBe('abc');
  });

  it('retries sync once after auth lifecycle refreshes credentials', async () => {
    const worker = new FakeWorker();
    let token = 'expired-token';
    const expiredStatuses: number[] = [];
    const retryStatuses: number[] = [];
    let refreshCount = 0;
    const promise = createSyncularV2WorkerClient({
      worker: worker.asWorker(),
      requestTimeoutMs: 100,
      getHeaders: () => ({ authorization: `Bearer ${token}` }),
      authLifecycle: {
        onAuthExpired: ({ status }) => {
          expiredStatuses.push(status);
        },
        refreshToken: async ({ status }) => {
          refreshCount += 1;
          expect(status).toBe(401);
          token = 'fresh-token';
          return true;
        },
        retryWithFreshToken: ({ status, refreshResult }) => {
          retryStatuses.push(status);
          return refreshResult;
        },
      },
      config: {
        baseUrl: '/sync',
        actorId: 'actor',
        clientId: 'client',
      },
    });

    await waitForMessages(worker, 1);
    worker.respond({
      id: worker.messages[0]!.id,
      protocolVersion: SYNCULAR_V2_WORKER_PROTOCOL_VERSION,
      ok: true,
      value: true,
    });
    await waitForMessages(worker, 2);
    worker.respond({
      id: worker.messages[1]!.id,
      protocolVersion: SYNCULAR_V2_WORKER_PROTOCOL_VERSION,
      ok: true,
      value: true,
    });
    const client = await promise;

    const syncPromise = client.syncOnce();
    await waitForMessages(worker, 3);
    expect(worker.messages[2]).toMatchObject({
      type: 'setAuthHeaders',
      headers: { authorization: 'Bearer expired-token' },
    });
    worker.respond({
      id: worker.messages[2]!.id,
      protocolVersion: SYNCULAR_V2_WORKER_PROTOCOL_VERSION,
      ok: true,
      value: true,
    });

    await waitForMessages(worker, 4);
    expect(worker.messages[3]).toMatchObject({ type: 'syncOnce' });
    const failedAttempt = (
      worker.messages[3] as Extract<
        SyncularV2WorkerRequest,
        { type: 'syncOnce' }
      >
    ).syncAttempt;
    worker.respond({
      id: worker.messages[3]!.id,
      protocolVersion: SYNCULAR_V2_WORKER_PROTOCOL_VERSION,
      ok: false,
      error: {
        code: 'worker.failed',
        message: 'Transport: browser fetch failed with HTTP 401: expired',
        details: { status: 401 },
      },
    });

    await waitForMessages(worker, 5);
    expect(worker.messages[4]).toMatchObject({
      type: 'setAuthHeaders',
      headers: { authorization: 'Bearer fresh-token' },
    });
    worker.respond({
      id: worker.messages[4]!.id,
      protocolVersion: SYNCULAR_V2_WORKER_PROTOCOL_VERSION,
      ok: true,
      value: true,
    });

    await waitForMessages(worker, 6);
    expect(worker.messages[5]).toMatchObject({ type: 'syncOnce' });
    expect(
      (
        worker.messages[5] as Extract<
          SyncularV2WorkerRequest,
          { type: 'syncOnce' }
        >
      ).syncAttempt
    ).toEqual(failedAttempt);
    worker.respond({
      id: worker.messages[5]!.id,
      protocolVersion: SYNCULAR_V2_WORKER_PROTOCOL_VERSION,
      ok: true,
      value: {
        changedTables: ['tasks'],
        changedRows: [],
        changedRowsTruncated: false,
        subscriptions: [],
        bootstrap: zeroBootstrapStatus(),
        pushedCommits: 0,
      },
    });

    await waitForMessages(worker, 7);
    expect(worker.messages[6]).toMatchObject({ type: 'drainLiveQueryEvents' });
    worker.respond({
      id: worker.messages[6]!.id,
      protocolVersion: SYNCULAR_V2_WORKER_PROTOCOL_VERSION,
      ok: true,
      value: [],
    });

    await expect(syncPromise).resolves.toEqual({
      changedTables: ['tasks'],
      changedRows: [],
      changedRowsTruncated: false,
      subscriptions: [],
      bootstrap: zeroBootstrapStatus(),
      pushedCommits: 0,
    });
    expect(expiredStatuses).toEqual([401]);
    expect(retryStatuses).toEqual([401]);
    expect(refreshCount).toBe(1);
  });

  it('starts realtime in the worker with resolved query params', async () => {
    const worker = new FakeWorker();
    const promise = createSyncularV2WorkerClient({
      worker: worker.asWorker(),
      requestTimeoutMs: 100,
      realtime: {
        wsUrl: 'wss://example.test/sync/realtime',
        params: { static: '1' },
        getParams: ({ clientId }) => ({ token: `token-for-${clientId}` }),
        initialReconnectDelayMs: 25,
      },
      config: {
        baseUrl: '/sync',
        actorId: 'actor',
        clientId: 'client',
      },
    });

    await waitForMessages(worker, 1);
    expect(worker.messages[0]).toMatchObject({ type: 'open' });
    worker.respond({
      id: worker.messages[0]!.id,
      protocolVersion: SYNCULAR_V2_WORKER_PROTOCOL_VERSION,
      ok: true,
      value: true,
    });

    await waitForMessages(worker, 2);
    expect(worker.messages[1]).toMatchObject({
      type: 'startRealtime',
      options: {
        wsUrl: 'wss://example.test/sync/realtime',
        params: { static: '1', token: 'token-for-client' },
        initialReconnectDelayMs: 25,
      },
    });
    worker.respond({
      id: worker.messages[1]!.id,
      protocolVersion: SYNCULAR_V2_WORKER_PROTOCOL_VERSION,
      ok: true,
      value: true,
    });

    await expect(promise).resolves.toBeInstanceOf(SyncularV2WorkerClient);
  });

  it('restarts active realtime with fresh params after auth headers change', async () => {
    const worker = new FakeWorker();
    const client = new SyncularV2WorkerClient(worker.asWorker(), {
      ownsWorker: false,
      requestTimeoutMs: 100,
    });
    let token = 'initial';

    const openPromise = client.open({
      baseUrl: '/sync',
      actorId: 'actor',
      clientId: 'client',
    });
    await waitForMessages(worker, 1);
    worker.respond({
      id: worker.messages[0]!.id,
      protocolVersion: SYNCULAR_V2_WORKER_PROTOCOL_VERSION,
      ok: true,
      value: true,
    });
    await openPromise;

    const realtimeOptions = {
      wsUrl: 'wss://example.test/sync/realtime',
      getParams: () => ({ token }),
    };
    const startPromise = client.startRealtime(realtimeOptions);
    await waitForMessages(worker, 2);
    expect(worker.messages[1]).toMatchObject({
      type: 'startRealtime',
      options: {
        wsUrl: 'wss://example.test/sync/realtime',
        params: { token: 'initial' },
      },
    });
    worker.respond({
      id: worker.messages[1]!.id,
      protocolVersion: SYNCULAR_V2_WORKER_PROTOCOL_VERSION,
      ok: true,
      value: true,
    });
    await startPromise;

    token = 'fresh';
    const authPromise = client.setAuthHeaders({
      authorization: 'Bearer fresh',
    });
    await waitForMessages(worker, 3);
    expect(worker.messages[2]).toMatchObject({
      type: 'setAuthHeaders',
      headers: { authorization: 'Bearer fresh' },
    });
    worker.respond({
      id: worker.messages[2]!.id,
      protocolVersion: SYNCULAR_V2_WORKER_PROTOCOL_VERSION,
      ok: true,
      value: true,
    });

    await waitForMessages(worker, 4);
    expect(worker.messages[3]).toMatchObject({
      type: 'startRealtime',
      options: {
        wsUrl: 'wss://example.test/sync/realtime',
        params: { token: 'fresh' },
      },
    });
    worker.respond({
      id: worker.messages[3]!.id,
      protocolVersion: SYNCULAR_V2_WORKER_PROTOCOL_VERSION,
      ok: true,
      value: true,
    });

    await expect(authPromise).resolves.toBeUndefined();
  });

  it('resumes from background by restarting realtime and syncing', async () => {
    const worker = new FakeWorker();
    const client = new SyncularV2WorkerClient(worker.asWorker(), {
      ownsWorker: false,
      requestTimeoutMs: 100,
    });
    const lifecycleEvents: SyncularV2LifecycleState[] = [];
    client.addEventListener('lifecycleChanged', (event) =>
      lifecycleEvents.push(event)
    );

    const openPromise = client.open({
      baseUrl: '/sync',
      actorId: 'actor',
      clientId: 'client',
    });
    await waitForMessages(worker, 1);
    worker.respond({
      id: worker.messages[0]!.id,
      protocolVersion: SYNCULAR_V2_WORKER_PROTOCOL_VERSION,
      ok: true,
      value: true,
    });
    await openPromise;

    const realtimeOptions = {
      wsUrl: 'wss://example.test/sync/realtime',
      params: { scope: 'app' },
    };
    const startPromise = client.startRealtime(realtimeOptions);
    await waitForMessages(worker, 2);
    worker.respond({
      id: worker.messages[1]!.id,
      protocolVersion: SYNCULAR_V2_WORKER_PROTOCOL_VERSION,
      ok: true,
      value: true,
    });
    await startPromise;

    const resumePromise = client.resumeFromBackground();
    expect(lifecycleEvents.at(-1)).toMatchObject({
      phase: 'recovering',
      lastDiagnostic: { code: 'lifecycle.resume_from_background' },
    });

    await waitForMessages(worker, 3);
    expect(worker.messages[2]).toMatchObject({
      type: 'startRealtime',
      options: {
        wsUrl: 'wss://example.test/sync/realtime',
        params: { scope: 'app' },
      },
    });
    worker.respond({
      id: worker.messages[2]!.id,
      protocolVersion: SYNCULAR_V2_WORKER_PROTOCOL_VERSION,
      ok: true,
      value: true,
    });

    await waitForMessages(worker, 4);
    expect(worker.messages[3]).toMatchObject({ type: 'syncOnce' });
    worker.respond({
      id: worker.messages[3]!.id,
      protocolVersion: SYNCULAR_V2_WORKER_PROTOCOL_VERSION,
      ok: true,
      value: {
        changedTables: [],
        changedRows: [],
        changedRowsTruncated: false,
        subscriptions: [],
        bootstrap: zeroBootstrapStatus(),
        pushedCommits: 0,
      },
    });
    await waitForMessages(worker, 5);
    expect(worker.messages[4]).toMatchObject({ type: 'drainLiveQueryEvents' });
    worker.respond({
      id: worker.messages[4]!.id,
      protocolVersion: SYNCULAR_V2_WORKER_PROTOCOL_VERSION,
      ok: true,
      value: [],
    });

    await waitForMessages(worker, 8);
    expect(worker.messages[5]).toMatchObject({ type: 'executeUnsafeSql' });
    expect(worker.messages[6]).toMatchObject({ type: 'executeUnsafeSql' });
    expect(worker.messages[7]).toMatchObject({ type: 'blobUploadQueueStats' });
    worker.respond({
      id: worker.messages[5]!.id,
      protocolVersion: SYNCULAR_V2_WORKER_PROTOCOL_VERSION,
      ok: true,
      value: { rows: [] },
    });
    worker.respond({
      id: worker.messages[6]!.id,
      protocolVersion: SYNCULAR_V2_WORKER_PROTOCOL_VERSION,
      ok: true,
      value: { rows: [{ unresolved: 0, resolved: 0, total: 0 }] },
    });
    worker.respond({
      id: worker.messages[7]!.id,
      protocolVersion: SYNCULAR_V2_WORKER_PROTOCOL_VERSION,
      ok: true,
      value: { pending: 0, uploading: 0, failed: 0 },
    });

    await expect(resumePromise).resolves.toMatchObject({
      bootstrap: { complete: true },
    });
    expect(lifecycleEvents.at(-1)).toMatchObject({ phase: 'complete' });
  });

  it('dispatches realtime live-query events from the worker', () => {
    const worker = new FakeWorker();
    const client = new SyncularV2WorkerClient(worker.asWorker(), {
      ownsWorker: false,
      requestTimeoutMs: 100,
    });
    const events: unknown[] = [];
    client.addLiveQueryListener('query-1', (event) => events.push(event));

    worker.emit({
      protocolVersion: SYNCULAR_V2_WORKER_PROTOCOL_VERSION,
      type: 'liveQueryEvents',
      events: [
        {
          queryId: 'query-1',
          version: 2,
          changedRows: [],
          rows: [{ id: 'task-1' }],
        },
      ],
    });

    expect(events).toEqual([
      {
        queryId: 'query-1',
        version: 2,
        changedRows: [],
        rows: [{ id: 'task-1' }],
      },
    ]);
  });

  it('dispatches row-level change events from the worker', () => {
    const worker = new FakeWorker();
    const client = new SyncularV2WorkerClient(worker.asWorker(), {
      ownsWorker: false,
      requestTimeoutMs: 100,
    });
    const events: unknown[] = [];
    const remove = client.addRowsChangedListener((event) => events.push(event));

    worker.emit({
      protocolVersion: SYNCULAR_V2_WORKER_PROTOCOL_VERSION,
      type: 'rowsChanged',
      source: 'localWrite',
      changedTables: ['tasks'],
      changedRows: [
        {
          table: 'tasks',
          rowId: 'task-1',
          operation: 'insert',
          changedFields: ['title'],
          crdtFields: [],
          commitId: 'commit-1',
        },
      ],
    });
    remove();
    worker.emit({
      protocolVersion: SYNCULAR_V2_WORKER_PROTOCOL_VERSION,
      type: 'rowsChanged',
      source: 'remotePull',
      changedTables: ['tasks'],
      changedRows: [],
    });

    expect(events).toEqual([
      {
        source: 'localWrite',
        changedTables: ['tasks'],
        changedRows: [
          {
            table: 'tasks',
            rowId: 'task-1',
            operation: 'insert',
            changedFields: ['title'],
            crdtFields: [],
            commitId: 'commit-1',
          },
        ],
      },
    ]);
  });

  it('uses Rust-native camelCase client event names', () => {
    const worker = new FakeWorker();
    const client = new SyncularV2WorkerClient(worker.asWorker(), {
      ownsWorker: false,
      requestTimeoutMs: 100,
    });
    const rowsEvents: unknown[] = [];
    const bootstrapEvents: unknown[] = [];
    const presenceEvents: unknown[] = [];
    client.addEventListener('rowsChanged', (event) => rowsEvents.push(event));
    client.addEventListener('bootstrapChanged', (event) =>
      bootstrapEvents.push(event)
    );
    client.addEventListener('presenceChanged', (event) =>
      presenceEvents.push(event)
    );

    worker.emit({
      protocolVersion: SYNCULAR_V2_WORKER_PROTOCOL_VERSION,
      type: 'rowsChanged',
      source: 'remotePull',
      changedTables: ['tasks'],
      changedRows: [],
    });
    worker.emit({
      protocolVersion: SYNCULAR_V2_WORKER_PROTOCOL_VERSION,
      type: 'bootstrapChanged',
      bootstrap: {
        ...zeroBootstrapStatus(),
        channelPhase: 'live',
      },
    });
    worker.emit({
      protocolVersion: SYNCULAR_V2_WORKER_PROTOCOL_VERSION,
      type: 'presenceEvent',
      action: 'snapshot',
      scopeKey: 'tasks:user-1',
      entries: [
        {
          clientId: 'client-2',
          actorId: 'actor-2',
          joinedAt: 123,
          metadata: { viewing: 'task-2' },
        },
      ],
    });

    expect(rowsEvents).toEqual([
      {
        source: 'remotePull',
        changedTables: ['tasks'],
        changedRows: [],
      },
    ]);
    expect(bootstrapEvents).toEqual([
      {
        ...zeroBootstrapStatus(),
        channelPhase: 'live',
      },
    ]);
    expect(presenceEvents).toEqual([
      {
        scopeKey: 'tasks:user-1',
        presence: [
          {
            clientId: 'client-2',
            actorId: 'actor-2',
            joinedAt: 123,
            metadata: { viewing: 'task-2' },
          },
        ],
      },
    ]);
  });

  it('sends and tracks realtime presence events', () => {
    const worker = new FakeWorker();
    const client = new SyncularV2WorkerClient(worker.asWorker(), {
      ownsWorker: false,
      requestTimeoutMs: 100,
    });
    const events: unknown[] = [];
    client.addPresenceListener((event) => events.push(event));

    client.joinPresence('tasks:user-1', { editing: 'task-1' });
    expect(worker.messages[0]).toMatchObject({
      type: 'sendPresence',
      action: 'join',
      scopeKey: 'tasks:user-1',
      metadata: { editing: 'task-1' },
    });
    worker.respond({
      id: worker.messages[0]!.id,
      protocolVersion: SYNCULAR_V2_WORKER_PROTOCOL_VERSION,
      ok: true,
      value: true,
    });
    worker.emit({
      protocolVersion: SYNCULAR_V2_WORKER_PROTOCOL_VERSION,
      type: 'presenceEvent',
      action: 'snapshot',
      scopeKey: 'tasks:user-1',
      entries: [
        {
          clientId: 'client-2',
          actorId: 'actor-2',
          joinedAt: 123,
          metadata: { viewing: 'task-2' },
        },
      ],
    });

    expect(client.getPresence('tasks:user-1')).toEqual([
      {
        clientId: 'client-2',
        actorId: 'actor-2',
        joinedAt: 123,
        metadata: { viewing: 'task-2' },
      },
    ]);
    expect(events.at(-1)).toEqual({
      scopeKey: 'tasks:user-1',
      presence: [
        {
          clientId: 'client-2',
          actorId: 'actor-2',
          joinedAt: 123,
          metadata: { viewing: 'task-2' },
        },
      ],
    });

    worker.emit({
      protocolVersion: SYNCULAR_V2_WORKER_PROTOCOL_VERSION,
      type: 'realtimeState',
      state: 'connected',
    });
    expect(worker.messages[1]).toMatchObject({
      type: 'sendPresence',
      action: 'join',
      scopeKey: 'tasks:user-1',
      metadata: { editing: 'task-1' },
    });
  });

  it('forwards storage compaction options to the worker', async () => {
    const worker = new FakeWorker();
    const client = new SyncularV2WorkerClient(worker.asWorker(), {
      ownsWorker: false,
      requestTimeoutMs: 100,
    });

    const promise = client.compactStorage({
      olderThanMs: 60_000,
      maxBlobCacheBytes: 1024,
      maxTombstoneServerVersion: 99,
    });
    const request = worker.messages[0]!;
    expect(request).toMatchObject({
      type: 'compactStorage',
      options: {
        olderThanMs: 60_000,
        maxBlobCacheBytes: 1024,
        maxTombstoneServerVersion: 99,
      },
    });
    worker.respond({
      id: request.id,
      protocolVersion: SYNCULAR_V2_WORKER_PROTOCOL_VERSION,
      ok: true,
      value: {
        ackedOutboxCommitsDeleted: 1,
        resolvedConflictsDeleted: 2,
        failedBlobUploadsDeleted: 0,
        inactiveSubscriptionStatesDeleted: 0,
        tombstoneRowsDeleted: 3,
        blobCacheBytesPruned: 4,
        encryptedCrdtUpdatesDeleted: 0,
        encryptedCrdtCheckpointsDeleted: 0,
      },
    });

    await expect(promise).resolves.toMatchObject({
      ackedOutboxCommitsDeleted: 1,
      tombstoneRowsDeleted: 3,
      blobCacheBytesPruned: 4,
    });
  });

  it('forwards local health checks and explicit repairs to the worker', async () => {
    const worker = new FakeWorker();
    const client = new SyncularV2WorkerClient(worker.asWorker(), {
      ownsWorker: false,
      requestTimeoutMs: 100,
    });

    const health = client.localHealthCheck();
    expect(worker.messages[0]).toMatchObject({ type: 'localHealthCheck' });
    worker.respond({
      id: worker.messages[0]!.id,
      protocolVersion: SYNCULAR_V2_WORKER_PROTOCOL_VERSION,
      ok: true,
      value: {
        generatedAt: 1,
        ok: false,
        checkedSubscriptions: 1,
        checkedSubscriptionStates: 2,
        checkedVerifiedRoots: 1,
        checkedOutboxCommits: 0,
        checkedConflicts: 0,
        checkedSyncedRows: 0,
        checkedBlobReferences: 0,
        checkedCrdtDocuments: 0,
        checkedCrdtUpdateLogEntries: 0,
        findings: [
          {
            severity: 'error',
            code: 'local.subscription_state_orphaned',
            component: 'subscriptionState',
            message:
              'stored subscription state is not configured on this client',
            subscriptionId: 'old-subscription',
            table: 'tasks',
            repairAction: 'clearOrphanedState',
          },
        ],
      },
    });
    await expect(health).resolves.toMatchObject({
      ok: false,
      findings: [
        expect.objectContaining({
          code: 'local.subscription_state_orphaned',
          repairAction: 'clearOrphanedState',
        }),
      ],
    });

    const repair = client.repairLocalHealth({
      action: 'clearOrphanedState',
      subscriptionIds: ['old-subscription'],
    });
    expect(worker.messages[1]).toMatchObject({
      type: 'repairLocalHealth',
      request: {
        action: 'clearOrphanedState',
        subscriptionIds: ['old-subscription'],
      },
    });
    worker.respond({
      id: worker.messages[1]!.id,
      protocolVersion: SYNCULAR_V2_WORKER_PROTOCOL_VERSION,
      ok: true,
      value: {
        action: 'clearOrphanedState',
        deletedSubscriptionStates: 1,
        deletedVerifiedRoots: 1,
        forcedRebootstrapSubscriptions: 0,
        clearedOrphanedSyncedRows: 0,
        clearedTables: [],
      },
    });
    await expect(repair).resolves.toEqual({
      action: 'clearOrphanedState',
      deletedSubscriptionStates: 1,
      deletedVerifiedRoots: 1,
      forcedRebootstrapSubscriptions: 0,
      clearedOrphanedSyncedRows: 0,
      clearedTables: [],
    });
  });

  it('forwards structured worker diagnostics to registered listeners', () => {
    const worker = new FakeWorker();
    const initialDiagnostics: SyncularV2DiagnosticEvent[] = [];
    const additionalDiagnostics: SyncularV2DiagnosticEvent[] = [];
    const client = new SyncularV2WorkerClient(worker.asWorker(), {
      ownsWorker: false,
      requestTimeoutMs: 100,
      diagnostics: (event) => initialDiagnostics.push(event),
    });
    const remove = client.addDiagnosticListener((event) =>
      additionalDiagnostics.push(event)
    );

    const event = {
      at: 123,
      level: 'info' as const,
      source: 'sync' as const,
      code: 'sync.syncOnce.completed',
      message: 'Sync completed',
      details: { changedTableCount: 1 },
    };
    worker.emit({
      protocolVersion: SYNCULAR_V2_WORKER_PROTOCOL_VERSION,
      type: 'diagnostic',
      event,
    });
    remove();
    worker.emit({
      protocolVersion: SYNCULAR_V2_WORKER_PROTOCOL_VERSION,
      type: 'diagnostic',
      event: { ...event, code: 'sync.syncPull.completed' },
    });

    expect(initialDiagnostics.map((item) => item.code)).toEqual([
      'sync.syncOnce.completed',
      'sync.syncPull.completed',
    ]);
    expect(additionalDiagnostics.map((item) => item.code)).toEqual([
      'sync.syncOnce.completed',
    ]);
  });

  it('retries immediate blob storage after auth lifecycle refreshes credentials', async () => {
    const worker = new FakeWorker();
    let token = 'expired-token';
    let refreshCount = 0;
    const promise = createSyncularV2WorkerClient({
      worker: worker.asWorker(),
      requestTimeoutMs: 100,
      getHeaders: () => ({ authorization: `Bearer ${token}` }),
      authLifecycle: {
        refreshToken: ({ operation, status }) => {
          expect(operation).toBe('blobInitiateUpload');
          expect(status).toBe(403);
          refreshCount += 1;
          token = 'fresh-token';
          return true;
        },
      },
      config: {
        baseUrl: '/sync',
        actorId: 'actor',
        clientId: 'client',
      },
    });

    await waitForMessages(worker, 1);
    worker.respond({
      id: worker.messages[0]!.id,
      protocolVersion: SYNCULAR_V2_WORKER_PROTOCOL_VERSION,
      ok: true,
      value: true,
    });
    await waitForMessages(worker, 2);
    worker.respond({
      id: worker.messages[1]!.id,
      protocolVersion: SYNCULAR_V2_WORKER_PROTOCOL_VERSION,
      ok: true,
      value: true,
    });
    const client = await promise;

    const storePromise = client.storeBlob(new Uint8Array([1, 2, 3]), {
      mimeType: 'application/test',
      immediate: true,
    });
    await waitForMessages(worker, 3);
    expect(worker.messages[2]).toMatchObject({
      type: 'setAuthHeaders',
      headers: { authorization: 'Bearer expired-token' },
    });
    worker.respond({
      id: worker.messages[2]!.id,
      protocolVersion: SYNCULAR_V2_WORKER_PROTOCOL_VERSION,
      ok: true,
      value: true,
    });

    await waitForMessages(worker, 4);
    expect(worker.messages[3]).toMatchObject({
      type: 'storeBlob',
      data: new Uint8Array([1, 2, 3]),
      options: { mimeType: 'application/test', immediate: true },
    });
    worker.respond({
      id: worker.messages[3]!.id,
      protocolVersion: SYNCULAR_V2_WORKER_PROTOCOL_VERSION,
      ok: false,
      error: {
        code: 'worker.failed',
        message: 'Transport: browser fetch failed with HTTP 403: expired',
        details: { status: 403 },
      },
    });

    await waitForMessages(worker, 5);
    expect(worker.messages[4]).toMatchObject({
      type: 'setAuthHeaders',
      headers: { authorization: 'Bearer fresh-token' },
    });
    worker.respond({
      id: worker.messages[4]!.id,
      protocolVersion: SYNCULAR_V2_WORKER_PROTOCOL_VERSION,
      ok: true,
      value: true,
    });

    await waitForMessages(worker, 6);
    expect(worker.messages[5]).toMatchObject({ type: 'storeBlob' });
    worker.respond({
      id: worker.messages[5]!.id,
      protocolVersion: SYNCULAR_V2_WORKER_PROTOCOL_VERSION,
      ok: true,
      value: {
        hash: `sha256:${'0'.repeat(64)}`,
        size: 3,
        mimeType: 'application/test',
      },
    });

    await expect(storePromise).resolves.toMatchObject({
      hash: `sha256:${'0'.repeat(64)}`,
      size: 3,
      mimeType: 'application/test',
    });
    expect(refreshCount).toBe(1);
  });
});

class FakeWorker {
  messages: SyncularV2WorkerRequest[] = [];
  onmessage:
    | ((event: MessageEvent<SyncularV2WorkerOutboundMessage>) => void)
    | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  onmessageerror: ((event: MessageEvent) => void) | null = null;

  postMessage(message: SyncularV2WorkerRequest): void {
    this.messages.push(message);
  }

  terminate(): void {}

  respond(response: SyncularV2WorkerResponse): void {
    this.onmessage?.({
      data: response,
    } as MessageEvent<SyncularV2WorkerOutboundMessage>);
  }

  emit(event: SyncularV2WorkerEvent): void {
    this.onmessage?.({
      data: event,
    } as MessageEvent<SyncularV2WorkerOutboundMessage>);
  }

  asWorker(): Worker {
    return this as unknown as Worker;
  }
}

async function waitForMessages(
  worker: FakeWorker,
  count: number
): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt++) {
    if (worker.messages.length >= count) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error(
    `expected ${count} worker messages, got ${worker.messages.length}`
  );
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error('condition was not met');
}

function zeroBootstrapStatus(): SyncularV2BootstrapStatus {
  return {
    channelPhase: 'idle',
    progressPercent: 100,
    isBootstrapping: false,
    criticalReady: true,
    interactiveReady: true,
    complete: true,
    activePhase: null,
    expectedSubscriptionIds: [],
    readySubscriptionIds: [],
    pendingSubscriptionIds: [],
    subscriptions: [],
    phases: [],
  };
}

function zeroTransportStats() {
  return {
    requestCount: 0,
    requestBytes: 0,
    responseBytes: 0,
    snapshotChunkCount: 0,
    snapshotChunkJsonCount: 0,
    snapshotChunkBinaryCount: 0,
    snapshotChunkRowCount: 0,
    snapshotChunkFetchMs: 0,
    snapshotChunkDecompressMs: 0,
    snapshotChunkHashMs: 0,
    snapshotChunkDecodeMs: 0,
    snapshotArtifactCount: 0,
    snapshotArtifactBytes: 0,
    snapshotArtifactFetchMs: 0,
    snapshotArtifactDecompressMs: 0,
    snapshotArtifactHashMs: 0,
    syncPackDecodeMs: 0,
    serverBootstrapSnapshotQueryMs: 0,
    serverBootstrapRowFrameEncodeMs: 0,
    serverBootstrapSnapshotBinaryEncodeMs: 0,
    serverBootstrapChunkCacheLookupMs: 0,
    serverBootstrapArtifactCacheLookupMs: 0,
    serverBootstrapChunkGzipMs: 0,
    serverBootstrapChunkHashMs: 0,
    serverBootstrapChunkPersistMs: 0,
  };
}
