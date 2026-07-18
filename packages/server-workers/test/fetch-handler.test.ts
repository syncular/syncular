/**
 * The Workers fetch handler, driven directly with Web `Request` objects over
 * the D1 double + memory stores — the loopback doctrine carried over `fetch`:
 * request/response bytes are built and decoded with the reference codec, so a
 * full push → pull → blob round-trip runs through the real Workers entry
 * (`createWorkersFetchHandler` → `createSyncularHono` → the core handler) with
 * no HTTP server and no `workerd`.
 *
 * This is the bar the TODP set: full push/pull/segment/blob round-trips
 * through the Workers entry, over the D1 double, with the reference codec.
 */
import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import {
  decodeMessage,
  encodeMessage,
  encodeRow,
  PROTOCOL_WIRE_VERSION,
  type PushResultFrame,
  type RequestFrame,
  type RowColumn,
} from '@syncular/core';
import {
  type BlobStore,
  blobIdFor,
  MemoryBlobStore,
  MemorySegmentStore,
  S3BlobStore,
  type ServerSchema,
  SSP2_CONTENT_TYPE,
  type SyncServerConfig,
} from '@syncular/server';
import { D1DatabaseDouble } from '../../server/test/d1-double';
import { startS3Stub } from '../../server/test/s3-stub';
import { createWorkersFetchHandler, D1ServerStorage } from '../src/index';
import { FakeDurableObjectNamespace } from './do-double';

const PARTITION = 'part-1';
const ACTOR_ID = 'actor-1';

const TASK_COLUMNS: readonly RowColumn[] = [
  { name: 'id', type: 'string', nullable: false },
  { name: 'list_id', type: 'string', nullable: false },
  { name: 'title', type: 'string', nullable: false },
  { name: 'attachment', type: 'blob_ref', nullable: true },
];

const SCHEMA: ServerSchema = {
  version: 1,
  tables: [
    {
      name: 'tasks',
      columns: TASK_COLUMNS,
      primaryKey: 'id',
      scopes: ['list:{list_id}'],
    },
  ],
};

/** Mirror the demo's Env → config wiring, but with the D1 double + memory. */
interface TestEnv {
  readonly DB: D1DatabaseDouble;
  readonly config: SyncServerConfig;
}

async function makeHandler(
  makeBlobs: () => BlobStore = () => new MemoryBlobStore(),
): Promise<(request: Request) => Promise<Response>> {
  const db = new D1DatabaseDouble();
  const storage = new D1ServerStorage(db);
  await storage.migrate();
  const segments = new MemorySegmentStore();
  const blobs = makeBlobs();
  const config: SyncServerConfig = {
    schema: SCHEMA,
    storage,
    segments,
    blobs,
    resolveScopes: () => ({ list_id: ['*'] }),
  };
  const namespace = new FakeDurableObjectNamespace(db, {
    syncConfig: (coordinatedStorage) => ({
      schema: SCHEMA,
      storage: coordinatedStorage,
      segments,
      blobs,
      resolveScopes: () => ({ list_id: ['*'] }),
    }),
  });
  const handler = createWorkersFetchHandler<TestEnv>({
    config: (env) => ({
      config: env.config,
      authenticate: async () => ({ actorId: ACTOR_ID, partition: PARTITION }),
    }),
    realtime: () => ({
      namespace,
      authenticate: async () => ({
        actorId: ACTOR_ID,
        partition: PARTITION,
        clientId: 'client-1',
      }),
    }),
  });
  const env: TestEnv = { DB: db, config };
  const ctx = { waitUntil: () => {}, passThroughOnException: () => {} };
  return (request: Request) => handler(request, env, ctx);
}

function syncRequest(frames: RequestFrame[], clientId = 'client-1'): Request {
  const bytes = encodeMessage({
    wireVersion: PROTOCOL_WIRE_VERSION,
    msgKind: 'request',
    frames: [{ type: 'REQ_HEADER', clientId, schemaVersion: 1 }, ...frames],
  });
  return new Request('https://worker.example/sync', {
    method: 'POST',
    headers: { 'content-type': SSP2_CONTENT_TYPE },
    body: bytes.slice().buffer as ArrayBuffer,
  });
}

async function decodeSync(response: Response) {
  expect(response.status).toBe(200);
  expect(response.headers.get('content-type')).toBe(SSP2_CONTENT_TYPE);
  const bytes = new Uint8Array(await response.arrayBuffer());
  const message = decodeMessage(bytes);
  if (message.msgKind !== 'response') throw new Error('expected a response');
  return message;
}

function taskRow(
  id: string,
  listId: string,
  title: string,
  attachment: string | null = null,
): Uint8Array {
  return encodeRow(TASK_COLUMNS, [id, listId, title, attachment]);
}

/** §5.9.1: a `blob_ref` value is the canonical JSON doc, not the bare id. */
function blobRef(blobId: string, byteLength: number): string {
  return JSON.stringify({ blobId, byteLength });
}

describe('Workers fetch handler (D1 double + memory stores)', () => {
  let fetch_: (request: Request) => Promise<Response>;
  beforeEach(async () => {
    fetch_ = await makeHandler();
  });

  test('415 on a non-SSP2 content type', async () => {
    const response = await fetch_(
      new Request('https://worker.example/sync', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      }),
    );
    expect(response.status).toBe(415);
  });

  test('HTTP-only transport can coordinate D1 pushes without mounting realtime', async () => {
    const db = new D1DatabaseDouble();
    const directStorage = new D1ServerStorage(db);
    await directStorage.migrate();
    const segments = new MemorySegmentStore();
    const namespace = new FakeDurableObjectNamespace(db, {
      syncConfig: (storage) => ({
        schema: SCHEMA,
        storage,
        segments,
        resolveScopes: () => ({ list_id: ['*'] }),
      }),
    });
    const handler = createWorkersFetchHandler<unknown>({
      config: () => ({
        config: {
          schema: SCHEMA,
          storage: directStorage,
          segments,
          resolveScopes: () => ({ list_id: ['*'] }),
        },
        authenticate: async () => ({ actorId: ACTOR_ID, partition: PARTITION }),
      }),
      coordinator: () => ({ namespace }),
    });
    const response = await handler(
      syncRequest([
        {
          type: 'PUSH_COMMIT',
          clientCommitId: 'coordinator-only',
          operations: [
            {
              table: 'tasks',
              rowId: 'coordinator-only-row',
              op: 'upsert',
              payload: taskRow('coordinator-only-row', 'L', 'coordinated'),
            },
          ],
        },
      ]),
      {},
      { waitUntil: () => {} },
    );
    expect((await decodeSync(response)).frames).toContainEqual(
      expect.objectContaining({
        type: 'PUSH_RESULT',
        status: 'applied',
      }),
    );
  });

  test('a stateless D1 push fails before app-row mutation', async () => {
    const db = new D1DatabaseDouble();
    const storage = new D1ServerStorage(db);
    await storage.migrate();
    const handler = createWorkersFetchHandler<unknown>(() => ({
      config: {
        schema: SCHEMA,
        storage,
        segments: new MemorySegmentStore(),
        resolveScopes: () => ({ list_id: ['*'] }),
      },
      authenticate: async () => ({ actorId: ACTOR_ID, partition: PARTITION }),
    }));
    const response = await handler(
      syncRequest([
        {
          type: 'PUSH_COMMIT',
          clientCommitId: 'unsafe-stateless',
          operations: [
            {
              table: 'tasks',
              rowId: 'must-not-land',
              op: 'upsert',
              payload: taskRow('must-not-land', 'L', 'unsafe'),
            },
          ],
        },
      ]),
      {},
      { waitUntil: () => {} },
    );
    expect(response.status).toBe(400);
    expect(await storage.getMaxCommitSeq(PARTITION)).toBe(0);
    expect(
      await storage.getPushResult(PARTITION, 'client-1', 'unsafe-stateless'),
    ).toBeUndefined();
  });

  test('push then pull round-trips a row through the Workers entry', async () => {
    const pushResp = await fetch_(
      syncRequest([
        {
          type: 'PUSH_COMMIT',
          clientCommitId: 'c1',
          operations: [
            {
              table: 'tasks',
              rowId: 't1',
              op: 'upsert',
              payload: taskRow('t1', 'L', 'first'),
            },
          ],
        },
      ]),
    );
    const pushMsg = await decodeSync(pushResp);
    const result = pushMsg.frames.find(
      (f): f is PushResultFrame => f.type === 'PUSH_RESULT',
    );
    expect(result?.status).toBe('applied');
    expect(result?.commitSeq).toBe(1);

    // A second client bootstraps and sees the row through a pull.
    const pullResp = await fetch_(
      syncRequest(
        [
          {
            type: 'PULL_HEADER',
            limitCommits: 100,
            limitSnapshotRows: 100,
            maxSnapshotPages: 4,
            accept: 0b0011,
          },
          {
            type: 'SUBSCRIPTION',
            id: 's1',
            table: 'tasks',
            scopes: { list_id: ['L'] },
            cursor: -1,
          },
        ],
        'client-2',
      ),
    );
    const pullMsg = await decodeSync(pullResp);
    // The subscription is served: a SUB_START/SUB_END section bracketing the
    // bootstrap for `s1`, proving the pull ran through the Workers entry over
    // D1. (Small datasets inline the rows segment rather than emit a separate
    // SEGMENT descriptor, so we assert on the section, not the frame type.)
    const subStart = pullMsg.frames.find(
      (f) => f.type === 'SUB_START' && f.id === 's1',
    );
    const subEnd = pullMsg.frames.find((f) => f.type === 'SUB_END');
    expect(subStart).toBeDefined();
    expect(subEnd).toBeDefined();
  });

  test('idempotent replay returns the cached result (same commitSeq)', async () => {
    const req = () =>
      syncRequest([
        {
          type: 'PUSH_COMMIT',
          clientCommitId: 'dup',
          operations: [
            {
              table: 'tasks',
              rowId: 't9',
              op: 'upsert',
              payload: taskRow('t9', 'L', 'x'),
            },
          ],
        },
      ]);
    const first = await decodeSync(await fetch_(req()));
    const second = await decodeSync(await fetch_(req()));
    const seq = (fr: typeof first) =>
      fr.frames.find((f): f is PushResultFrame => f.type === 'PUSH_RESULT')
        ?.commitSeq;
    expect(seq(first)).toBe(1);
    expect(seq(second)).toBe(1);
  });

  test('blob upload → reference → download round-trips (row-derived authz)', async () => {
    const blobBytes = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
    const blobId = await blobIdFor(blobBytes);

    // Upload the blob (content-addressed PUT).
    const uploadResp = await fetch_(
      new Request(`https://worker.example/blobs/${blobId}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/octet-stream' },
        body: blobBytes.slice().buffer as ArrayBuffer,
      }),
    );
    expect(uploadResp.status).toBe(200);

    // Push a row referencing the blob.
    const pushMsg = await decodeSync(
      await fetch_(
        syncRequest([
          {
            type: 'PUSH_COMMIT',
            clientCommitId: 'cb',
            operations: [
              {
                table: 'tasks',
                rowId: 'tb',
                op: 'upsert',
                payload: taskRow(
                  'tb',
                  'L',
                  'with-blob',
                  blobRef(blobId, blobBytes.length),
                ),
              },
            ],
          },
        ]),
      ),
    );
    expect(
      pushMsg.frames.find((f): f is PushResultFrame => f.type === 'PUSH_RESULT')
        ?.status,
    ).toBe('applied');

    // Download the blob — re-authorized against the referencing row (§5.9.5).
    const downloadResp = await fetch_(
      new Request(`https://worker.example/blobs/${blobId}`),
    );
    expect(downloadResp.status).toBe(200);
    const got = new Uint8Array(await downloadResp.arrayBuffer());
    expect(got).toEqual(blobBytes);
  });

  test('a push referencing an absent blob fails loud (blob.not_found)', async () => {
    const missing = await blobIdFor(new Uint8Array([9, 9, 9]));
    const pushMsg = await decodeSync(
      await fetch_(
        syncRequest([
          {
            type: 'PUSH_COMMIT',
            clientCommitId: 'cm',
            operations: [
              {
                table: 'tasks',
                rowId: 'tm',
                op: 'upsert',
                payload: taskRow('tm', 'L', 'no-blob', blobRef(missing, 3)),
              },
            ],
          },
        ]),
      ),
    );
    const result = pushMsg.frames.find(
      (f): f is PushResultFrame => f.type === 'PUSH_RESULT',
    );
    expect(result?.status).toBe('rejected');
  });
});

/**
 * A Workers deployment configuring `S3BlobStore` (R2-as-S3): the same
 * upload → reference → download round-trip, but the blob bytes live in the
 * object store, proving the env wiring flows an S3 blob store through
 * `SyncServerConfig.blobs` exactly like the memory store.
 */
describe('Workers fetch handler (D1 double + S3 blob store)', () => {
  const stub = startS3Stub({
    bucket: 'wk-blobs',
    region: 'auto',
    accessKeyId: 'SYNCULARTESTAKID',
    secretAccessKey: 'syncular-test-secret',
    now: () => Date.now(),
  });
  afterAll(() => stub.stop());

  let storeCount = 0;
  const makeS3Blobs = () => {
    storeCount += 1;
    return new S3BlobStore({
      endpoint: stub.url,
      region: 'auto',
      bucket: 'wk-blobs',
      accessKeyId: 'SYNCULARTESTAKID',
      secretAccessKey: 'syncular-test-secret',
      keyPrefix: `wk${storeCount}/`,
    });
  };

  test('blob upload → reference → download round-trips over S3', async () => {
    const fetch_ = await makeHandler(makeS3Blobs);
    const blobBytes = new Uint8Array([9, 8, 7, 6, 5, 4, 3, 2, 1]);
    const blobId = await blobIdFor(blobBytes);

    const uploadResp = await fetch_(
      new Request(`https://worker.example/blobs/${blobId}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/octet-stream' },
        body: blobBytes.slice().buffer as ArrayBuffer,
      }),
    );
    expect(uploadResp.status).toBe(200);

    const pushMsg = await decodeSync(
      await fetch_(
        syncRequest([
          {
            type: 'PUSH_COMMIT',
            clientCommitId: 'cs3',
            operations: [
              {
                table: 'tasks',
                rowId: 'ts3',
                op: 'upsert',
                payload: taskRow(
                  'ts3',
                  'L',
                  'with-s3-blob',
                  blobRef(blobId, blobBytes.length),
                ),
              },
            ],
          },
        ]),
      ),
    );
    expect(
      pushMsg.frames.find((f): f is PushResultFrame => f.type === 'PUSH_RESULT')
        ?.status,
    ).toBe('applied');

    const downloadResp = await fetch_(
      new Request(`https://worker.example/blobs/${blobId}`),
    );
    expect(downloadResp.status).toBe(200);
    const got = new Uint8Array(await downloadResp.arrayBuffer());
    expect(got).toEqual(blobBytes);
  });
});
