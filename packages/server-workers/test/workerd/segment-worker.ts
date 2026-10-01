/**
 * A Worker that serves Syncular's real segment route under workerd for
 * `segment-encoding.workerd.test.ts`. `POST /seed` stores one segment above
 * SEGMENT_STREAM_THRESHOLD_BYTES and answers its content address.
 */
import {
  MemorySegmentStore,
  SEGMENT_STREAM_THRESHOLD_BYTES,
  type ServerSchema,
  scopeDigest,
} from '@syncular/server';
import {
  createWorkersFetchHandler,
  type D1Database,
  D1ServerStorage,
  type ExecutionContextLike,
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
  ],
};
const PARTITION = 'part-1';
const LOG_EPOCH = 'test-log-epoch';
const segments = new MemorySegmentStore();

interface Env {
  readonly DB: D1Database;
}

const handler = createWorkersFetchHandler<Env>((env) => ({
  config: {
    schema: SCHEMA,
    storage: new D1ServerStorage(env.DB),
    segments,
    resolveScopes: () => ({ project_id: ['p1'] }),
  },
  authenticate: async () => ({ actorId: 'actor-1', partition: PARTITION }),
}));

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContextLike) {
    if (new URL(request.url).pathname !== '/seed')
      return handler(request, env, ctx);
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
