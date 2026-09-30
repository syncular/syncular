/**
 * Offline §5.3 image publishing: a publisher with a SQLite engine stores the
 * image a builder-less serving host (a Worker) finds on its pull, and the
 * image stays current across commits outside its scope (§4.7 scope pin).
 */
import { expect, test } from 'bun:test';
import { PGlite } from '@electric-sql/pglite';
import {
  canonicalScopeJson,
  decodeMessage,
  type RequestFrame,
} from '@syncular/core';
import {
  compileSchema,
  handleSyncRequest,
  MemorySegmentStore,
  openSegmentDownload,
  PostgresServerStorage,
  publishSqliteImage,
  type SyncServerConfig,
} from '@syncular/server';
import { pgliteExecutor } from '@syncular/server/pglite';
import { buildSqliteImage } from '@syncular/server/sqlite';
import {
  docRow,
  pullHeader,
  pushCommit,
  requestBytes,
  subFrame,
  TEST_LOG_EPOCH,
  TEST_SCHEMA,
  taskRow,
  upsert,
} from './helpers';

const P1 = { project_id: ['p1'] };

test('a published image is served by a host without a builder until its scope changes', async () => {
  const db = await PGlite.create();
  const storage = new PostgresServerStorage(pgliteExecutor(db));
  // The publisher's store sets the publication lifetime (§5.1 TTL).
  const segments = new MemorySegmentStore({ ttlMs: 30 * 24 * 60 * 60 * 1000 });
  const base: SyncServerConfig = {
    schema: TEST_SCHEMA,
    storage,
    segments,
    resolveScopes: () => ({
      project_id: ['p1', 'p2'],
      projectId: ['p1'],
      org_id: ['o1'],
    }),
    clock: () => 1_750_000_000_000,
  };
  // The serving host has no SQLite engine: any build attempt fails loudly.
  const host: SyncServerConfig = {
    ...base,
    sqliteImageBuilder: async () => {
      throw new Error('the serving host must not build an image');
    },
  };
  const publisher: SyncServerConfig = {
    ...base,
    sqliteImageBuilder: buildSqliteImage,
  };
  const sync = async (frames: RequestFrame[], clientId = 'client-1') => {
    const message = decodeMessage(
      await handleSyncRequest(requestBytes(frames, clientId), {
        ...host,
        partition: 'part-1',
        actorId: 'actor-1',
      }),
    );
    if (message.msgKind !== 'response') throw new Error('expected a response');
    return message;
  };
  await storage.ensureSchema(compileSchema(TEST_SCHEMA));
  await storage.touchPartition('part-1', 0, TEST_LOG_EPOCH);
  await sync([
    pushCommit('c1', [
      upsert('tasks', 't1', taskRow('t1', 'p1')),
      upsert('tasks', 't2', taskRow('t2', 'p1')),
      upsert('tasks', 't3', taskRow('t3', 'p1')),
    ]),
  ]);

  const publish = () =>
    publishSqliteImage({
      config: publisher,
      partition: 'part-1',
      table: 'tasks',
      scopes: P1,
    });
  const published = await publish();
  expect(published).toMatchObject({
    asOfCommitSeq: 1,
    rowCount: 3,
    origin: 'built',
  });
  expect(await publish()).toEqual({ ...published, origin: 'reused' });

  // Commits outside the scope leave the pin, and so the image, current.
  await sync([
    pushCommit('c2', [upsert('docs', 'd1', docRow('d1', 'o1', 'p1'))]),
    pushCommit('c3', [upsert('tasks', 't9', taskRow('t9', 'p2'))]),
  ]);
  const bootstrap = await sync(
    [
      pullHeader({ accept: 0b0111, limitSnapshotRows: 1 }),
      subFrame('s1', 'tasks', P1, -1),
    ],
    'client-2',
  );
  const ref = bootstrap.frames.find((frame) => frame.type === 'SEGMENT_REF');
  expect(ref).toMatchObject({
    segmentId: published.segmentId,
    mediaType: 'sqlite',
    asOfCommitSeq: published.asOfCommitSeq,
  });
  expect(await publish()).toEqual({ ...published, origin: 'reused' });

  // The serving host streams the stored bytes (§5.5).
  const download = await openSegmentDownload(
    { ...host, partition: 'part-1', actorId: 'actor-1' },
    { segmentId: published.segmentId, scopesHeader: canonicalScopeJson(P1) },
  );
  const bytes = new Uint8Array(await new Response(download.body).arrayBuffer());
  expect(bytes.length).toBe(published.byteLength);

  // A change inside the scope moves the pin: the next publication builds.
  await sync([pushCommit('c4', [upsert('tasks', 't4', taskRow('t4', 'p1'))])]);
  const republished = await publish();
  expect(republished.origin).toBe('built');
  expect(republished.asOfCommitSeq).toBe(4);
  await db.close();
});
