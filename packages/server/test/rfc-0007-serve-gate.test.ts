/**
 * RFC 0007 phase 2b: the serve-path readiness gate.
 *
 * The gate refuses with the promoted §10.2 identity `sync.schema_not_ready`
 * on the real HTTP path and the real established-WebSocket path, for the two
 * conditions: a checkpoint for the running schema version is not activated,
 * and the database is newer than the running build.
 */
import { expect, test } from 'bun:test';
import { decodeMessage, REALTIME_TAG_ROUND } from '@syncular/core';
import {
  createRealtimeHub,
  handleSyncRequest,
  MemorySegmentStore,
  SqliteServerStorage,
  compileSchema,
} from '@syncular/server';
import { BunSqliteDatabase } from '@syncular/server/sqlite';
import {
  makeContext,
  pullHeader,
  pushCommit,
  pushResults,
  requestBytes,
  subFrame,
  sync,
  taskRow,
  upsert,
} from './helpers';
import { TEST_SCHEMA } from './helpers';

const PARTITION = 'part-1';
const SCHEMA = compileSchema(TEST_SCHEMA);
const SCHEMA_V2 = compileSchema({ ...TEST_SCHEMA, version: 2 });

function errorFrames(bytes: Uint8Array): { code: string; details?: string }[] {
  // Socket round chunks carry the §8.4 tag byte.
  const message = decodeMessage(bytes.subarray(1));
  return message.frames
    .filter((frame) => frame.type === 'ERROR')
    .map((frame) => ({
      code: frame.code,
      ...(frame.details !== undefined ? { details: frame.details } : {}),
    }));
}

test('HTTP pull is refused while an undeclared checkpoint is incomplete', async () => {
  const db = new BunSqliteDatabase();
  const storage = new SqliteServerStorage(db);
  const t = makeContext({ storage });
  try {
    await storage.ensureSchema(SCHEMA);
    await storage.declareCheckpoint(
      PARTITION,
      'tasks-projection',
      SCHEMA.version,
      t.now.ms,
    );
    let caught: unknown;
    try {
      await handleSyncRequest(requestBytes([pullHeader()]), t.ctx);
    } catch (error) {
      caught = error;
    }
    const error = caught as { code?: string; details?: string };
    expect(error.code).toBe('sync.schema_not_ready');
    // The projection name rides in structured details, never the message.
    expect(JSON.parse(error.details ?? '{}')).toEqual({
      partition: PARTITION,
      projection: 'tasks-projection',
    });
  } finally {
    db.close();
  }
});

test('the declaring process serves while it backfills', async () => {
  const db = new BunSqliteDatabase();
  const storage = new SqliteServerStorage(db);
  const t = makeContext({
    storage,
    checkpoints: [
      { partition: PARTITION, name: 'tasks-projection', schemaVersion: 1 },
    ],
  });
  try {
    await storage.ensureSchema(SCHEMA, t.ctx.checkpoints);
    await storage.declareCheckpoint(
      PARTITION,
      'tasks-projection',
      SCHEMA.version,
      t.now.ms,
    );
    const response = await sync(t, [
      pushCommit('c1', [upsert('tasks', 't1', taskRow('t1', 'p1'))]),
    ]);
    expect(response.frames.length).toBeGreaterThan(0);
  } finally {
    db.close();
  }
});

test('the real WebSocket round is refused on an established session', async () => {
  const db = new BunSqliteDatabase();
  const storage = new SqliteServerStorage(db);
  const t = makeContext();
  try {
    await storage.ensureSchema(SCHEMA);
    await storage.declareCheckpoint(
      PARTITION,
      'tasks-projection',
      SCHEMA.version,
      t.now.ms,
    );
    const hub = createRealtimeHub({
      schema: TEST_SCHEMA,
      storage,
      segments: new MemorySegmentStore(),
      resolveScopes: t.ctx.resolveScopes,
      ...(t.ctx.clock !== undefined ? { clock: t.ctx.clock } : {}),
    });
    const sent: Uint8Array[] = [];
    const session = await hub.connect({
      partition: PARTITION,
      actorId: 'actor-1',
      clientId: 'client-1',
      send: (data) => {
        if (typeof data !== 'string') sent.push(data);
      },
    });
    const bytes = requestBytes([pullHeader()], 'client-1');
    const tagged = new Uint8Array(bytes.length + 1);
    tagged[0] = REALTIME_TAG_ROUND;
    tagged.set(bytes, 1);
    await session.handleBinary(tagged);
    const errors = sent.flatMap((chunk) => errorFrames(chunk));
    expect(errors.map((frame) => frame.code)).toContain(
      'sync.schema_not_ready',
    );
    session.close();
  } finally {
    db.close();
  }
});

test('acceptance 9: an already-serving process is refused after another migrates the database', async () => {
  const db = new BunSqliteDatabase();
  const a = new SqliteServerStorage(db);
  const t = makeContext({ storage: a });
  try {
    await a.ensureSchema(SCHEMA);
    // The already-serving process completes one round at version 1.
    await sync(t, [
      pushCommit('c1', [upsert('tasks', 't1', taskRow('t1', 'p1'))]),
    ]);
    // A second process migrates the shared database past the running build.
    const b = new SqliteServerStorage(db);
    await b.ensureSchema(SCHEMA_V2);
    await expect(
      handleSyncRequest(requestBytes([pullHeader()]), t.ctx),
    ).rejects.toMatchObject({ code: 'sync.schema_not_ready' });
  } finally {
    db.close();
  }
});

test('acceptance 13: a migration between the entry gate and the push transaction is refused under the lock', async () => {
  const db = new BunSqliteDatabase();
  const a = new SqliteServerStorage(db);
  const t = makeContext({ storage: a });
  try {
    await a.ensureSchema(SCHEMA);
    let migrated = false;
    const wrapped = new Proxy(a, {
      get(target, property) {
        if (property === 'begin') {
          return async (partition: string) => {
            if (!migrated) {
              migrated = true;
              // The migration lands after the entry gate has passed and
              // before the push transaction starts.
              const b = new SqliteServerStorage(db);
              await b.ensureSchema(SCHEMA_V2);
            }
            return target.begin(partition);
          };
        }
        const value = Reflect.get(target, property);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    Object.assign(t.ctx, { storage: wrapped });
    // The push transaction's own gate refuses before any write, and the
    // buffered read-verify refuses the whole request because the stored
    // version moved.
    await expect(
      sync(t, [pushCommit('c1', [upsert('tasks', 't1', taskRow('t1', 'p1'))])]),
    ).rejects.toMatchObject({ code: 'sync.schema_not_ready' });
    // The refused write landed nothing.
    expect(await a.getMaxCommitSeq(PARTITION)).toBe(0);
  } finally {
    db.close();
  }
});

test('acceptance 13 (pull): a migration during the pull read is refused before any byte escapes', async () => {
  const db = new BunSqliteDatabase();
  const a = new SqliteServerStorage(db);
  const t = makeContext({ storage: a });
  try {
    await a.ensureSchema(SCHEMA);
    await sync(t, [
      pushCommit('c1', [upsert('tasks', 't1', taskRow('t1', 'p1'))]),
    ]);
    let migrated = false;
    const wrapped = new Proxy(a, {
      get(target, property) {
        if (property === 'getMaxCommitSeq') {
          return async (partition: string) => {
            if (!migrated) {
              migrated = true;
              // The migration lands inside the pull's own data read, after
              // the entry gate has passed and after RESP_HEADER was built.
              const b = new SqliteServerStorage(db);
              await b.ensureSchema(SCHEMA_V2);
            }
            return target.getMaxCommitSeq(partition);
          };
        }
        const value = Reflect.get(target, property);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    Object.assign(t.ctx, { storage: wrapped });
    await expect(
      handleSyncRequest(requestBytes([pullHeader({ limitCommits: 1 })]), t.ctx),
    ).rejects.toMatchObject({ code: 'sync.schema_not_ready' });
    expect(migrated).toBe(true);
  } finally {
    db.close();
  }
});

test('an epoch rotation during the pull read is refused by the token comparison', async () => {
  const db = new BunSqliteDatabase();
  const a = new SqliteServerStorage(db);
  const t = makeContext({ storage: a });
  try {
    await a.ensureSchema(SCHEMA);
    await sync(t, [
      pushCommit('c1', [upsert('tasks', 't1', taskRow('t1', 'p1'))]),
    ]);
    let rotated = false;
    const wrapped = new Proxy(a, {
      get(target, property) {
        if (property === 'getMaxCommitSeq') {
          return async (partition: string) => {
            if (!rotated) {
              rotated = true;
              // A restore presents V -> other -> V at the same schema version;
              // only the epoch distinguishes it.
              await target.rotatePartitionLogEpoch(
                partition,
                'restored-epoch',
                t.now.ms,
              );
            }
            return target.getMaxCommitSeq(partition);
          };
        }
        const value = Reflect.get(target, property);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    Object.assign(t.ctx, { storage: wrapped });
    let caught: unknown;
    try {
      await handleSyncRequest(
        requestBytes([pullHeader({ limitCommits: 1 })]),
        t.ctx,
      );
    } catch (error) {
      caught = error;
    }
    const error = caught as { code?: string; details?: string };
    expect(error.code).toBe('sync.schema_not_ready');
    expect(JSON.parse(error.details ?? '{}')).toEqual({
      logEpochChanged: true,
    });
    expect(rotated).toBe(true);
  } finally {
    db.close();
  }
});

test('acceptance 13 (mixed push+pull): the pull half is refused and the applied push replays once', async () => {
  const db = new BunSqliteDatabase();
  const a = new SqliteServerStorage(db);
  const t = makeContext({ storage: a });
  try {
    await a.ensureSchema(SCHEMA);
    let rotated = false;
    const wrapped = new Proxy(a, {
      get(target, property) {
        if (property === 'getMaxCommitSeq') {
          return async (partition: string) => {
            if (!rotated) {
              rotated = true;
              // The token changes during the pull half's data read, after the
              // push half already applied.
              await target.rotatePartitionLogEpoch(
                partition,
                'mixed-rotated-epoch',
                t.now.ms,
              );
            }
            return target.getMaxCommitSeq(partition);
          };
        }
        const value = Reflect.get(target, property);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    Object.assign(t.ctx, { storage: wrapped });
    await expect(
      sync(t, [
        pushCommit('mixed-1', [upsert('tasks', 'm1', taskRow('m1', 'p1'))]),
        pullHeader({ limitCommits: 1 }),
        subFrame('s1', 'tasks', { project_id: ['p1'] }, 0),
      ]),
    ).rejects.toMatchObject({ code: 'sync.schema_not_ready' });
    // The push half is durable: it committed before the token changed.
    expect(await a.getMaxCommitSeq(PARTITION)).toBe(1);
    expect((await a.getRow(PARTITION, 'tasks', 'm1'))?.serverVersion).toBe(1);
    // Retrying under the same commit id replays the durable outcome with no
    // second apply. The request carries the rotated log epoch so it is not a
    // stale-epoch reset.
    const retryBytes = requestBytes(
      [pushCommit('mixed-1', [upsert('tasks', 'm1', taskRow('m1', 'p1'))])],
      'client-1',
      1,
      'mixed-rotated-epoch',
    );
    const retry = decodeMessage(await handleSyncRequest(retryBytes, t.ctx));
    if (retry.msgKind !== 'response') throw new Error('expected a response');
    const replayed = pushResults(retry)[0];
    expect(replayed?.status).toBe('cached');
    expect(replayed?.commitSeq).toBe(1);
    expect(await a.getMaxCommitSeq(PARTITION)).toBe(1);
    expect((await a.getRow(PARTITION, 'tasks', 'm1'))?.serverVersion).toBe(1);
  } finally {
    db.close();
  }
});
