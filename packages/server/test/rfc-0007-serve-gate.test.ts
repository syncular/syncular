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
  requestBytes,
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
    // The push transaction's own gate refuses; the response carries the
    // in-band ERROR frame (§1.6) and the write rolled back.
    const response = await sync(t, [
      pushCommit('c1', [upsert('tasks', 't1', taskRow('t1', 'p1'))]),
    ]);
    expect(
      response.frames.some(
        (frame) =>
          frame.type === 'ERROR' && frame.code === 'sync.schema_not_ready',
      ),
    ).toBe(true);
    // The refused write landed nothing.
    expect(await a.getMaxCommitSeq(PARTITION)).toBe(0);
  } finally {
    db.close();
  }
});
