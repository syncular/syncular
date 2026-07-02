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
  encodeRow,
  PROTOCOL_WIRE_VERSION,
  type RowColumn,
} from '@syncular-v2/core';
import {
  MemorySegmentStore,
  type ServerSchema,
  SqliteServerStorage,
  SSP2_CONTENT_TYPE,
  type SyncServerConfig,
} from '@syncular-v2/server';
import { createSyncularHono } from './index';

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

function makeApp() {
  const config: SyncServerConfig = {
    schema: SCHEMA,
    storage: new SqliteServerStorage(),
    segments: new MemorySegmentStore(),
    resolveScopes: () => ({ project_id: ['p1'] }),
    limits: { inlineSegmentMaxBytes: 1 },
  };
  return createSyncularHono({
    config,
    authenticate: async (request) => {
      const token = request.headers.get('authorization');
      if (token !== 'Bearer good') return null;
      return { actorId: 'actor-1', partition: 'part-1' };
    },
  });
}

function requestBytes(): Uint8Array {
  return encodeMessage({
    wireVersion: PROTOCOL_WIRE_VERSION,
    msgKind: 'request',
    frames: [
      { type: 'REQ_HEADER', clientId: 'client-1', schemaVersion: 1 },
      {
        type: 'PUSH_COMMIT',
        clientCommitId: 'c1',
        operations: [
          {
            table: 'tasks',
            rowId: 't1',
            op: 'upsert',
            payload: encodeRow(COLUMNS, ['t1', 'p1', 'hello']),
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
  test('POST /sync round-trips SSP2 bytes', async () => {
    const app = makeApp();
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
    const app = makeApp();
    const response = await app.request('/sync', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer good',
      },
      body: requestBytes().slice().buffer as ArrayBuffer,
    });
    expect(response.status).toBe(415);
  });

  test('failed authentication is HTTP 401 with the §10.1 error shape', async () => {
    const app = makeApp();
    const response = await app.request('/sync', {
      method: 'POST',
      headers: { 'content-type': SSP2_CONTENT_TYPE },
      body: requestBytes().slice().buffer as ArrayBuffer,
    });
    expect(response.status).toBe(401);
    const body = (await response.json()) as { code: string; category: string };
    expect(body.code).toBe('sync.auth_required');
    expect(body.category).toBe('auth-required');
  });

  test('GET /segments/:id serves with re-authorization and ETag/304', async () => {
    const app = makeApp();
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
    expect(download.headers.get('etag')).toBe(`"${ref.segmentId}"`);
    const bytes = new Uint8Array(await download.arrayBuffer());
    expect(bytes.length).toBe(ref.byteLength);
    const cached = await app.request(`/segments/${ref.segmentId}`, {
      headers: { ...headers, 'if-none-match': `"${ref.segmentId}"` },
    });
    expect(cached.status).toBe(304);
  });
});
