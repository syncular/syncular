/**
 * Hono adapter smoke test — proves the embed boundary. The one test file
 * allowed to cross HTTP semantics (via Hono's in-process fetch dispatch;
 * still no socket).
 */
import { describe, expect, test } from 'bun:test';
import {
  canonicalScopeJson,
  decodeMessage,
  encodeMessage,
  encodeRemoteOperationRequest,
  decodeRemoteOperationResponse,
  encodeSparseRow,
  type RowColumn,
} from '@syncular/core';
import {
  MemorySegmentStore,
  registerRemoteQuery,
  RemoteOperationRegistry,
  SEGMENT_STREAM_THRESHOLD_BYTES,
  scopeDigest,
  type ServerSchema,
  SqliteServerStorage,
  SSP2_CONTENT_TYPE,
  type SyncServerConfig,
  type SyncularErrorMapper,
  type SyncularServerEvent,
  type SyncularServerEvents,
  SyncError,
} from '@syncular/server';
import { createSyncularHono } from './index';
import { Hono } from 'hono';

const COLUMNS: readonly RowColumn[] = [
  { name: 'id', type: 'string', nullable: false },
  { name: 'project_id', type: 'string', nullable: false },
  { name: 'title', type: 'string', nullable: false },
];

const SCHEMA: ServerSchema = {
  version: 1,
  tables: [
    {
      name: 'tasks',
      columns: COLUMNS,
      primaryKey: 'id',
      scopes: ['project:{project_id}'],
    },
  ],
};

const TEST_LOG_EPOCH = 'test-log-epoch';

async function makeApp(
  events?: SyncularServerEvents,
  operations?: RemoteOperationRegistry,
  storage = new SqliteServerStorage(),
) {
  const config: SyncServerConfig = {
    schema: SCHEMA,
    storage,
    segments: new MemorySegmentStore(),
    resolveScopes: () => ({ project_id: ['p1'] }),
    limits: { inlineSegmentMaxBytes: 1 },
    ...(events !== undefined ? { events } : {}),
  };
  // Pin the partition log epoch so the fixture can push in one round (§2.1).
  await storage.touchPartition('part-1', 0, TEST_LOG_EPOCH);
  const host = new Hono();
  host.use('*', async (c, next) => {
    c.header('Access-Control-Allow-Origin', 'tauri://localhost');
    c.header('X-Host-Policy', 'retained');
    await next();
  });
  host.route(
    '/',
    createSyncularHono({
      config,
      ...(operations !== undefined ? { operations } : {}),
      authenticate: async (request) => {
        const token = request.headers.get('authorization');
        if (token !== 'Bearer good') return null;
        return { actorId: 'actor-1', partition: 'part-1' };
      },
    }),
  );
  return host;
}

function requestBytes(title = 'hello'): Uint8Array {
  return encodeMessage({
    wireVersion: 3,
    msgKind: 'request',
    frames: [
      {
        type: 'REQ_HEADER',
        clientId: 'client-1',
        schemaVersion: 1,
        logEpoch: TEST_LOG_EPOCH,
      },
      {
        type: 'PUSH_COMMIT',
        clientCommitId: 'c1',
        operations: [
          {
            table: 'tasks',
            rowId: 't1',
            op: 'upsert',
            payload: encodeSparseRow(COLUMNS, 0, ['t1', 'p1', title]),
          },
        ],
      },
      {
        type: 'PULL_HEADER',
        limitCommits: 0,
        limitSnapshotRows: 0,
        maxSnapshotPages: 0,
        accept: 0b0011,
      },
      {
        type: 'SUBSCRIPTION',
        id: 's1',
        table: 'tasks',
        scopes: { project_id: ['p1'] },
        cursor: -1,
      },
    ],
  });
}

describe('hono adapter', () => {
  test('authentication exceptions retain host middleware headers', async () => {
    const app = new Hono();
    app.use('*', async (c, next) => {
      c.header('Access-Control-Allow-Origin', 'tauri://localhost');
      await next();
    });
    app.route(
      '/',
      createSyncularHono({
        config: {
          schema: SCHEMA,
          storage: new SqliteServerStorage(),
          segments: new MemorySegmentStore(),
          resolveScopes: () => ({}),
        },
        authenticate: async () => {
          throw new Error('host authentication failed');
        },
      }),
    );
    const response = await app.request('/segments/unknown');
    expect(response.status).toBe(500);
    expect(response.headers.get('access-control-allow-origin')).toBe(
      'tauri://localhost',
    );
    expect(await response.json()).toMatchObject({
      code: 'sync.internal_error',
    });
  });

  test('POST /operations runs a registered query', async () => {
    const descriptor = {
      id: 'sha256:test/allTasks',
      hasParams: false,
      sql: 'SELECT id, title FROM tasks ORDER BY id',
      relationPlans: [
        {
          sql: 'SELECT id, title FROM tasks ORDER BY id',
          relations: [{ table: 'tasks', start: 22, end: 27 }],
        },
      ],
      tables: ['tasks'],
      resultColumns: [
        { name: 'id', type: 'string', nullable: false },
        { name: 'title', type: 'string', nullable: false },
      ] as const,
      bind: () => [],
      dependencies: () => [{ table: 'tasks' }],
      coverage: () => [],
    };
    const storage = new SqliteServerStorage();
    const app = await makeApp(
      undefined,
      new RemoteOperationRegistry([
        registerRemoteQuery(descriptor, {
          maxRows: 10,
          auth: {
            access: 'privileged',
            authorize: () => true,
          },
        }),
      ]),
      storage,
    );
    const response = await app.request('/operations', {
      method: 'POST',
      headers: {
        'content-type': 'application/vnd.syncular.operations.v1+json',
        authorization: 'Bearer good',
      },
      body: encodeRemoteOperationRequest({
        revision: 1,
        kind: 'query',
        clientId: 'admin-worker',
        operationId: descriptor.id,
        params: null,
      }).slice().buffer as ArrayBuffer,
    });

    expect(response.status).toBe(200);
    expect(
      decodeRemoteOperationResponse(
        new Uint8Array(await response.arrayBuffer()),
      ),
    ).toEqual({
      revision: 1,
      kind: 'query',
      operationId: descriptor.id,
      rows: [],
      maxCommitSeq: 0,
    });
    expect((await storage.listPartitionRegistry())[0]).toMatchObject({
      partition: 'part-1',
    });
  });

  test('POST /operations rejects the wrong content type with HTTP 415', async () => {
    const app = await makeApp();

    const response = await app.request('/operations', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });

    expect(response.status).toBe(415);
    expect(response.headers.get('x-host-policy')).toBe('retained');
    expect(await response.json()).toMatchObject({
      code: 'operation.invalid_request',
      retryable: false,
    });
  });

  test('POST /sync round-trips SSP2 bytes', async () => {
    const app = await makeApp();
    const response = await app.request('/sync', {
      method: 'POST',
      headers: {
        'content-type': SSP2_CONTENT_TYPE,
        authorization: 'Bearer good',
      },
      body: requestBytes().slice().buffer as ArrayBuffer,
    });
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe(SSP2_CONTENT_TYPE);
    const message = decodeMessage(new Uint8Array(await response.arrayBuffer()));
    expect(message.msgKind).toBe('response');
    const types = message.frames.map((f) => f.type);
    expect(types).toContain('PUSH_RESULT');
    expect(types).toContain('SUB_START');
    expect(types).toContain('SEGMENT_REF');
  });

  test('wrong content type is HTTP 415 (§1.1)', async () => {
    const app = await makeApp();
    const response = await app.request('/sync', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer good',
      },
      body: requestBytes().slice().buffer as ArrayBuffer,
    });
    expect(response.status).toBe(415);
    expect(response.headers.get('x-host-policy')).toBe('retained');
  });

  test('failed authentication is HTTP 401 with the §10.1 error shape', async () => {
    const app = await makeApp();
    const response = await app.request('/sync', {
      method: 'POST',
      headers: { 'content-type': SSP2_CONTENT_TYPE },
      body: requestBytes().slice().buffer as ArrayBuffer,
    });
    expect(response.status).toBe(401);
    expect(response.headers.get('x-host-policy')).toBe('retained');
    const body = (await response.json()) as { code: string; category: string };
    expect(body.code).toBe('sync.auth_required');
    expect(body.category).toBe('auth-required');
  });

  test('GET /segments/:id serves with re-authorization and ETag/304', async () => {
    const app = await makeApp();
    const syncResponse = await app.request('/sync', {
      method: 'POST',
      headers: {
        'content-type': SSP2_CONTENT_TYPE,
        authorization: 'Bearer good',
      },
      body: requestBytes().slice().buffer as ArrayBuffer,
    });
    const message = decodeMessage(
      new Uint8Array(await syncResponse.arrayBuffer()),
    );
    const ref = message.frames.find((f) => f.type === 'SEGMENT_REF');
    if (ref?.type !== 'SEGMENT_REF') throw new Error('expected SEGMENT_REF');
    const headers = {
      authorization: 'Bearer good',
      'x-syncular-scopes': canonicalScopeJson({ project_id: ['p1'] }),
    };
    const download = await app.request(`/segments/${ref.segmentId}`, {
      headers,
    });
    expect(download.status).toBe(200);
    expect(download.headers.get('access-control-allow-origin')).toBe(
      'tauri://localhost',
    );
    expect(download.headers.get('x-host-policy')).toBe('retained');
    expect(download.headers.get('etag')).toBe(`"${ref.segmentId}"`);
    const bytes = new Uint8Array(await download.arrayBuffer());
    expect(bytes.length).toBe(ref.byteLength);
    const cached = await app.request(`/segments/${ref.segmentId}`, {
      headers: { ...headers, 'if-none-match': `"${ref.segmentId}"` },
    });
    expect(cached.status).toBe(304);
    expect(cached.headers.get('x-host-policy')).toBe('retained');
  });

  test('GET /segments/:id negotiates Content-Encoding (§5.8)', async () => {
    const app = await makeApp();
    // A title long enough that the rows segment clears the 1 KiB
    // identity floor.
    const syncResponse = await app.request('/sync', {
      method: 'POST',
      headers: {
        'content-type': SSP2_CONTENT_TYPE,
        authorization: 'Bearer good',
      },
      body: requestBytes('x'.repeat(4096)).slice().buffer as ArrayBuffer,
    });
    const message = decodeMessage(
      new Uint8Array(await syncResponse.arrayBuffer()),
    );
    const ref = message.frames.find((f) => f.type === 'SEGMENT_REF');
    if (ref?.type !== 'SEGMENT_REF') throw new Error('expected SEGMENT_REF');
    const headers = {
      authorization: 'Bearer good',
      'x-syncular-scopes': canonicalScopeJson({ project_id: ['p1'] }),
    };

    // zstd preferred when offered (§5.8).
    const zstd = await app.request(`/segments/${ref.segmentId}`, {
      headers: { ...headers, 'accept-encoding': 'zstd, gzip' },
    });
    expect(zstd.status).toBe(200);
    expect(zstd.headers.get('content-encoding')).toBe('zstd');
    expect(zstd.headers.get('vary')).toContain('Accept-Encoding');
    const zstdBody = new Uint8Array(await zstd.arrayBuffer());
    expect(zstdBody.length).toBeLessThan(ref.byteLength);
    // The content address is over the UNCOMPRESSED bytes (§5.1/§5.8).
    expect(Bun.zstdDecompressSync(zstdBody).length).toBe(ref.byteLength);

    // gzip fallback.
    const gzip = await app.request(`/segments/${ref.segmentId}`, {
      headers: { ...headers, 'accept-encoding': 'gzip' },
    });
    expect(gzip.headers.get('content-encoding')).toBe('gzip');
    expect(gzip.headers.get('x-host-policy')).toBe('retained');
    expect(
      Bun.gunzipSync(new Uint8Array(await gzip.arrayBuffer())).length,
    ).toBe(ref.byteLength);

    // Identity when nothing acceptable is offered (q=0 refusal counts).
    const identity = await app.request(`/segments/${ref.segmentId}`, {
      headers: { ...headers, 'accept-encoding': 'zstd;q=0, br' },
    });
    expect(identity.headers.get('content-encoding')).toBeNull();
    expect(new Uint8Array(await identity.arrayBuffer()).length).toBe(
      ref.byteLength,
    );
  });

  test('a config events sink flows through the adapter untouched', async () => {
    const events: SyncularServerEvent[] = [];
    const app = await makeApp({
      emit(event) {
        events.push(event);
      },
    });
    const response = await app.request('/sync', {
      method: 'POST',
      headers: {
        'content-type': SSP2_CONTENT_TYPE,
        authorization: 'Bearer good',
      },
      body: requestBytes().slice().buffer as ArrayBuffer,
    });
    expect(response.status).toBe(200);
    await response.arrayBuffer();
    const types = events.map((e) => e.type);
    expect(types).toContain('push.applied');
    expect(types).toContain('pull.served');
    expect(types).toContain('request.handled');
    const handled = events.find((e) => e.type === 'request.handled');
    expect(handled).toMatchObject({ outcome: 'ok', kind: 'sync' });
  });
});

describe('unexpected exceptions (SYNCULAR-ERROR-CLASS-001)', () => {
  const SECRET = 'Network connection lost. secret-7f3a';

  async function faultyApp(options: {
    storage?: SqliteServerStorage;
    segments?: MemorySegmentStore;
    mapError?: SyncularErrorMapper;
  }) {
    const storage = options.storage ?? new SqliteServerStorage();
    const reported: { error: unknown; route: string }[] = [];
    await storage.touchPartition('part-1', 0, TEST_LOG_EPOCH);
    const app = createSyncularHono({
      config: {
        schema: SCHEMA,
        storage,
        segments: options.segments ?? new MemorySegmentStore(),
        resolveScopes: () => ({ project_id: ['p1'] }),
        limits: { inlineSegmentMaxBytes: 1 },
        onError: (error, { route }) => reported.push({ error, route }),
        ...(options.mapError !== undefined
          ? { mapError: options.mapError }
          : {}),
      },
      authenticate: async () => ({ actorId: 'actor-1', partition: 'part-1' }),
    });
    return { app, reported };
  }

  async function expectInternalError(response: Response): Promise<void> {
    expect(response.status).toBe(500);
    const text = await response.text();
    expect(text).not.toContain('secret-7f3a');
    expect(JSON.parse(text)).toMatchObject({
      code: 'sync.internal_error',
      category: 'internal',
      retryable: true,
      recommendedAction: 'retryLater',
    });
  }

  test('a storage exception in a pull answers 500 sync.internal_error and reaches onError', async () => {
    const storage = new SqliteServerStorage();
    storage.scanRows = async () => {
      throw new Error(SECRET);
    };
    const { app, reported } = await faultyApp({ storage });
    await expectInternalError(
      await app.request('/sync', {
        method: 'POST',
        headers: { 'content-type': SSP2_CONTENT_TYPE },
        body: requestBytes().slice().buffer as ArrayBuffer,
      }),
    );
    expect(reported).toHaveLength(1);
    expect(reported[0]?.route).toBe('sync');
    expect((reported[0]?.error as Error).message).toBe(SECRET);
  });

  test('a segment-store exception in a download answers 500 and reaches onError', async () => {
    const segments = new MemorySegmentStore();
    const { app, reported } = await faultyApp({ segments });
    const sync = await app.request('/sync', {
      method: 'POST',
      headers: { 'content-type': SSP2_CONTENT_TYPE },
      body: requestBytes().slice().buffer as ArrayBuffer,
    });
    const ref = decodeMessage(
      new Uint8Array(await sync.arrayBuffer()),
    ).frames.find((f) => f.type === 'SEGMENT_REF');
    if (ref?.type !== 'SEGMENT_REF') throw new Error('expected SEGMENT_REF');
    segments.get = async () => {
      throw new Error(SECRET);
    };
    segments.open = async () => {
      throw new Error(SECRET);
    };
    await expectInternalError(
      await app.request(`/segments/${ref.segmentId}`, {
        headers: {
          'x-syncular-scopes': canonicalScopeJson({ project_id: ['p1'] }),
        },
      }),
    );
    expect(reported.map((entry) => entry.route)).toEqual(['segments']);
    expect((reported[0]?.error as Error).message).toBe(SECRET);
  });

  test('a SyncError keeps its catalog status and never reaches onError', async () => {
    const { app, reported } = await faultyApp({});
    const response = await app.request('/sync', {
      method: 'POST',
      headers: { 'content-type': SSP2_CONTENT_TYPE },
      body: new Uint8Array([1, 2, 3]).buffer as ArrayBuffer,
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      code: 'sync.invalid_request',
      retryable: false,
    });
    expect(reported).toHaveLength(0);
  });

  test('a host mapError answers a typed catalog error with retry metadata', async () => {
    const storage = new SqliteServerStorage();
    storage.scanRows = async () => {
      throw new Error(SECRET);
    };
    const { app, reported } = await faultyApp({
      storage,
      mapError: () =>
        new SyncError(
          'sync.rate_limited',
          'service paused',
          JSON.stringify({ retryAfterMs: 1500 }),
        ),
    });
    const response = await app.request('/sync', {
      method: 'POST',
      headers: { 'content-type': SSP2_CONTENT_TYPE },
      body: requestBytes().slice().buffer as ArrayBuffer,
    });
    expect(response.status).toBe(429);
    expect(await response.json()).toMatchObject({
      code: 'sync.rate_limited',
      category: 'rate-limited',
      retryable: true,
      recommendedAction: 'retryLater',
      details: { retryAfterMs: 1500 },
    });
    expect(reported).toHaveLength(1);
    expect((reported[0]?.error as Error).message).toBe(SECRET);
  });

  test('a throwing mapError is contained as sync.internal_error', async () => {
    const storage = new SqliteServerStorage();
    storage.scanRows = async () => {
      throw new Error(SECRET);
    };
    const { app, reported } = await faultyApp({
      storage,
      mapError: () => {
        throw new Error('mapper failure');
      },
    });
    await expectInternalError(
      await app.request('/sync', {
        method: 'POST',
        headers: { 'content-type': SSP2_CONTENT_TYPE },
        body: requestBytes().slice().buffer as ArrayBuffer,
      }),
    );
    expect(reported).toHaveLength(1);
  });
});

describe('large segment downloads', () => {
  test('a segment above the stream threshold is relayed from SegmentStore.open', async () => {
    const storage = new SqliteServerStorage();
    await storage.touchPartition('part-1', 0, TEST_LOG_EPOCH);
    const segments = new MemorySegmentStore();
    const bytes = new Uint8Array(SEGMENT_STREAM_THRESHOLD_BYTES + 1024);
    for (let i = 0; i < bytes.length; i++) bytes[i] = i % 251;
    const record = await segments.put(
      {
        partition: 'part-1',
        logEpoch: TEST_LOG_EPOCH,
        table: 'tasks',
        schemaVersion: 1,
        mediaType: 'sqlite',
        scopeDigest: await scopeDigest({ project_id: ['p1'] }),
        asOfCommitSeq: 0,
        rowCount: 0,
        rowCursor: null,
        nextRowCursor: null,
      },
      bytes,
      Date.now(),
    );
    // The route must not buffer through `get`.
    segments.get = async () => {
      throw new Error('get must not be called for a streamed segment');
    };
    const app = new Hono();
    app.use('*', async (c, next) => {
      c.header('X-Host-Policy', 'retained');
      await next();
    });
    app.route(
      '/',
      createSyncularHono({
        config: {
          schema: SCHEMA,
          storage,
          segments,
          resolveScopes: () => ({ project_id: ['p1'] }),
        },
        authenticate: async () => ({ actorId: 'actor-1', partition: 'part-1' }),
      }),
    );
    const headers = {
      'x-syncular-scopes': canonicalScopeJson({ project_id: ['p1'] }),
    };
    const identity = await app.request(`/segments/${record.segmentId}`, {
      headers,
    });
    expect(identity.status).toBe(200);
    expect(identity.headers.get('x-host-policy')).toBe('retained');
    expect(identity.headers.get('content-length')).toBe(String(bytes.length));
    expect(new Uint8Array(await identity.arrayBuffer())).toEqual(bytes);
    const gzip = await app.request(`/segments/${record.segmentId}`, {
      headers: { ...headers, 'accept-encoding': 'gzip' },
    });
    expect(gzip.headers.get('content-encoding')).toBe('gzip');
    expect(gzip.headers.get('x-host-policy')).toBe('retained');
    expect(Bun.gunzipSync(new Uint8Array(await gzip.arrayBuffer()))).toEqual(
      bytes,
    );
  });
});
