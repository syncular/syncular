/**
 * A Worker that serves Syncular's real routes under workerd for
 * `segment-encoding.workerd.test.ts`. `POST /setup` migrates the D1 schema and
 * pins the partition log epoch. `POST /seed` stores one segment above
 * SEGMENT_STREAM_THRESHOLD_BYTES and answers its content address.
 * `POST /r2` runs the R2 segment and blob stores over the workerd R2 binding
 * and answers what it read back. `POST /reference?blobId=` stores a `files`
 * row that references the blob, and `GET /object?blobId=` answers the R2
 * object's `httpMetadata.contentType`. `POST /erase?blobId=` seeds two rows
 * of project p1 (one referencing the blob), erases the binding on D1 and R2,
 * and answers what is left. Everything else (including `POST /sync`) reaches
 * `createWorkersFetchHandler`; `/sync` is forwarded to `RealtimeDO`, so the
 * gzip assertion in the test lane covers the real DO hop plus the Worker's
 * own `Content-Encoding`.
 */
import { encodeRow } from '@syncular/core';
import {
  compileSchema,
  eraseScopeValue,
  MemorySegmentStore,
  SEGMENT_STREAM_THRESHOLD_BYTES,
  type ServerSchema,
  scopeDigest,
  seedMutations,
} from '@syncular/server';
import {
  createWorkersFetchHandler,
  type D1Database,
  D1ServerStorage,
  type DurableObjectNamespaceLike,
  type DurableObjectStateLike,
  type ExecutionContextLike,
  R2BlobStore,
  type R2BucketLike,
  type R2ObjectLike,
  R2SegmentStore,
  SyncularRealtimeHost,
} from '../../src/index';

const SCHEMA: ServerSchema = {
  version: 1,
  tables: [
    {
      name: 'tasks',
      columns: [
        { name: 'id', type: 'string', nullable: false },
        { name: 'project_id', type: 'string', nullable: false },
      ],
      primaryKey: 'id',
      scopes: ['project:{project_id}'],
    },
    {
      name: 'files',
      columns: [
        { name: 'id', type: 'string', nullable: false },
        { name: 'project_id', type: 'string', nullable: false },
        { name: 'file', type: 'blob_ref', nullable: true },
      ],
      primaryKey: 'id',
      scopes: ['project:{project_id}'],
    },
  ],
};
const PARTITION = 'part-1';
const LOG_EPOCH = 'test-log-epoch';
const segments = new MemorySegmentStore();

interface Env {
  readonly DB: D1Database;
  readonly REALTIME: DurableObjectNamespaceLike;
  readonly BUCKET: {
    head(key: string): Promise<
      | (R2ObjectLike & {
          readonly httpMetadata?: { readonly contentType?: string };
        })
      | null
    >;
  } & R2BucketLike;
}

/** The partition's D1-backed sync/realtime host (§8), reached through the
 * Worker's `coordinator` wiring: `/sync` forwards here. */
export class RealtimeDO {
  readonly #host: SyncularRealtimeHost;

  constructor(state: DurableObjectStateLike, env: Env) {
    this.#host = new SyncularRealtimeHost(state, env.DB, {
      syncConfig: (storage) => ({
        schema: SCHEMA,
        storage,
        segments: new MemorySegmentStore(),
        blobs: new R2BlobStore(env.BUCKET),
        resolveScopes: () => ({ project_id: ['p1'] }),
      }),
    });
  }

  fetch(request: Request): Promise<Response> {
    return this.#host.fetch(request);
  }
}

/**
 * Two concurrent publications of identical bytes under two scopes exercise
 * the create-only bytes write and the record compare-and-swap; two
 * concurrent blob puts exercise the create-only blob write and the stats CAS.
 */
async function runR2Stores(bucket: R2BucketLike): Promise<Response> {
  const store = new R2SegmentStore(bucket);
  const bytes = new TextEncoder().encode('rows segment bytes');
  const metadata = {
    partition: PARTITION,
    logEpoch: LOG_EPOCH,
    table: 'tasks',
    schemaVersion: 1,
    mediaType: 'rows' as const,
    asOfCommitSeq: 3,
    rowCount: 1,
    rowCursor: null,
    nextRowCursor: null,
  };
  const now = Date.now();
  const [first] = await Promise.all([
    store.put(
      { ...metadata, scopeDigest: await scopeDigest({ project_id: ['p1'] }) },
      bytes,
      now,
    ),
    store.put(
      { ...metadata, scopeDigest: await scopeDigest({ project_id: ['p2'] }) },
      bytes,
      now,
    ),
  ]);
  const stored = await store.get(first.segmentId);
  const opened = await store.open(first.segmentId);
  const openedText =
    opened === undefined ? null : await new Response(opened.body).text();
  const blobs = new R2BlobStore(bucket);
  const blob = new TextEncoder().encode('{"inline":"json"}');
  const blobId = `sha256:${[
    ...new Uint8Array(await crypto.subtle.digest('SHA-256', blob)),
  ]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')}`;
  await Promise.all([
    blobs.put(PARTITION, blobId, blob, now, 'application/json'),
    blobs.put(PARTITION, blobId, blob, now + 1, 'application/json'),
  ]);
  const storedBlob = await blobs.get(PARTITION, blobId);
  return Response.json({
    segmentText:
      stored === undefined ? null : new TextDecoder().decode(stored.bytes),
    scopeDigests: stored?.record.scopeDigests.length ?? 0,
    openedText,
    blobText:
      storedBlob === undefined
        ? null
        : new TextDecoder().decode(storedBlob.bytes),
    blobCount: (await blobs.stats(PARTITION)).count,
  });
}

const handler = createWorkersFetchHandler<Env>({
  config: (env) => ({
    config: {
      schema: SCHEMA,
      storage: new D1ServerStorage(env.DB),
      segments,
      blobs: new R2BlobStore(env.BUCKET),
      resolveScopes: () => ({ project_id: ['p1'] }),
    },
    authenticate: async (request) => ({
      actorId: 'actor-1',
      // The gzip round runs in a partition of its own so its rows do not
      // disturb the p1 fixtures the other routes share.
      partition: request.headers.get('x-test-partition') ?? PARTITION,
    }),
  }),
  coordinator: (env) => ({ namespace: env.REALTIME }),
});

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContextLike) {
    // Bun's `fetch` and its `node:http` both force `accept-encoding: br, gzip`
    // onto every request, so the identity branch is only reachable from the
    // test process by naming the encoding on a header the Worker applies.
    const testAcceptEncoding = request.headers.get('x-test-accept-encoding');
    if (testAcceptEncoding !== null) {
      const headers = new Headers(request.headers);
      headers.set('accept-encoding', testAcceptEncoding);
      headers.delete('x-test-accept-encoding');
      request = new Request(request, { headers });
    }
    const pathname = new URL(request.url).pathname;
    if (pathname === '/r2') return runR2Stores(env.BUCKET);
    const blobId = new URL(request.url).searchParams.get('blobId') ?? '';
    if (pathname === '/object') {
      const object = await env.BUCKET.head(
        new R2BlobStore(env.BUCKET).objectKeyFor(PARTITION, blobId),
      );
      return Response.json({
        contentType: object?.httpMetadata?.contentType ?? null,
      });
    }
    if (pathname === '/erase') {
      const storage = new D1ServerStorage(env.DB, {
        pushApplySerialized: true,
      });
      const blobs = new R2BlobStore(env.BUCKET);
      const config = {
        schema: SCHEMA,
        storage,
        segments,
        blobs,
        resolveScopes: () => ({ project_id: ['p1'] }),
      };
      const ref = JSON.stringify({ blobId, byteLength: 6 });
      await seedMutations(
        config,
        { partition: PARTITION, actorId: 'actor-1', commitId: 'erase-seed' },
        [
          {
            table: 'tasks',
            op: 'upsert',
            values: { id: 't1', project_id: 'p1' },
          },
          {
            table: 'files',
            op: 'upsert',
            values: { id: 'f2', project_id: 'p1', file: ref },
          },
        ],
      );
      const steps = [];
      for (;;) {
        const step = await eraseScopeValue(config, {
          partition: PARTITION,
          variable: 'project_id',
          value: 'p1',
        });
        steps.push(step);
        if (step.done) break;
      }
      return Response.json({
        steps,
        rows: [
          await storage.getRow(PARTITION, 'tasks', 't1'),
          await storage.getRow(PARTITION, 'files', 'f1'),
          await storage.getRow(PARTITION, 'files', 'f2'),
        ].filter((row) => row !== undefined).length,
        blob: await blobs.has(PARTITION, blobId),
      });
    }
    if (pathname === '/setup') {
      const storage = new D1ServerStorage(env.DB);
      await storage.migrate();
      for (const partition of [PARTITION, 'part-sync']) {
        await storage.touchPartition(partition, 0, LOG_EPOCH);
      }
      while (!(await storage.migrateSchema(compileSchema(SCHEMA))).complete) {}
      return new Response(null, { status: 204 });
    }
    if (pathname === '/reference') {
      const storage = new D1ServerStorage(env.DB);
      await storage.migrate();
      await storage.touchPartition(PARTITION, 0, LOG_EPOCH);
      // D1 budgets DDL per invocation; step the migration to completion.
      while (!(await storage.migrateSchema(compileSchema(SCHEMA))).complete) {}
      const ref = JSON.stringify({ blobId, byteLength: 6 });
      const tx = await storage.begin(PARTITION);
      await tx.upsertRow('files', {
        rowId: 'f1',
        serverVersion: 1,
        scopes: { project_id: 'p1' },
        payload: encodeRow(SCHEMA.tables[1]!.columns, ['f1', 'p1', ref]),
      });
      await tx.setBlobRefs?.('files', 'f1', [blobId]);
      await tx.commit();
      return new Response(null, { status: 204 });
    }
    if (pathname !== '/seed') return handler(request, env, ctx);
    const storage = new D1ServerStorage(env.DB);
    await storage.migrate();
    await storage.touchPartition(PARTITION, 0, LOG_EPOCH);
    // Text-like bytes: gzip shrinks them, so a second encoding is visible.
    const bytes = new Uint8Array(SEGMENT_STREAM_THRESHOLD_BYTES + 4096);
    for (let i = 0; i < bytes.length; i++)
      bytes[i] = 97 + ((i * 7 + (i >> 9)) % 26);
    const record = await segments.put(
      {
        partition: PARTITION,
        logEpoch: LOG_EPOCH,
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
    return Response.json({
      segmentId: record.segmentId,
      byteLength: bytes.length,
    });
  },
};
