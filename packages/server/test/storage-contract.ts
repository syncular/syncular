/**
 * The `ServerStorage` contract (SPEC §2.1 commit log, §2.3 idempotency,
 * §3.1 inverted scope index, §4.5 windowing, §4.6 horizon), run identically
 * against every backend — sqlite and Postgres. Backends register via
 * `runStorageContract` with a factory returning a fresh, isolated storage
 * per test.
 *
 * This is the storage analogue of `segment-store-contract.ts`: the exact
 * same assertions run on `SqliteServerStorage` (bun:sqlite) and
 * `PostgresServerStorage` (pglite), so the Postgres path is held to the
 * reference implementation's behavior key-for-key — especially the
 * index-first fanout and dense per-partition commitSeq allocation.
 */
import { describe, expect, test } from 'bun:test';
import {
  encodeRow,
  registrationDigest,
  type RowColumn,
  unitId,
} from '@syncular/core';
import {
  type ClientRecord,
  compileSchema,
  type NewChange,
  type NewReaction,
  PARTITION_TOUCH_INTERVAL_MS,
  prepareAuthorityTransaction,
  type ServerSchema,
  type ServerStorage,
  StorageQueryError,
  type StoredPushResult,
  type StoredRow,
} from '@syncular/server';

const PARTITION = 'part-1';
const NOW = 1_750_000_000_000;

function bytes(...values: number[]): Uint8Array {
  return new Uint8Array(values);
}

function reaction(
  sourceCommitSeq: number,
  idempotencyKey = '["c1","commit-1","email"]',
): NewReaction {
  return {
    idempotencyKey,
    type: 'email.send',
    version: 1,
    payload: { messageId: 'message-1' },
    sourceClientId: 'c1',
    sourceClientCommitId: 'commit-1',
    sourceCommitSeq,
    createdAtMs: NOW,
    maxAttempts: 3,
  };
}

/**
 * The contract schema: storage persists rows RELATIONALLY (per-app tables,
 * the relational-storage contract), so every upserted payload must be
 * valid row-codec bytes for its table.
 */
const TASKS_COLUMNS: readonly RowColumn[] = [
  { name: 'id', type: 'string', nullable: false },
  { name: 'project_id', type: 'string', nullable: false },
  { name: 'data', type: 'bytes', nullable: true },
];
const DOCS_COLUMNS: readonly RowColumn[] = [
  { name: 'id', type: 'string', nullable: false },
  { name: 'org_id', type: 'string', nullable: false },
  { name: 'project_id', type: 'string', nullable: false },
];
const DEVICE_KEY_GRANTS_COLUMNS: readonly RowColumn[] = [
  { name: 'id', type: 'string', nullable: false },
  { name: 'user_id', type: 'string', nullable: false },
  { name: 'workspace_id', type: 'string', nullable: false },
  { name: 'key_id', type: 'string', nullable: false },
];
export const CONTRACT_SCHEMA: ServerSchema = {
  version: 1,
  tables: [
    {
      name: 'tasks',
      columns: TASKS_COLUMNS,
      primaryKey: 'id',
      scopes: ['project:{project_id}'],
      indexes: [{ name: 'tasks_by_project', columns: ['project_id'] }],
    },
    {
      name: 'docs',
      columns: DOCS_COLUMNS,
      primaryKey: 'id',
      scopes: ['org:{org_id}', 'project:{project_id}'],
    },
    {
      name: 'device_key_grants',
      columns: DEVICE_KEY_GRANTS_COLUMNS,
      primaryKey: 'id',
      scopes: ['user:{user_id}'],
      indexes: [
        {
          name: 'device_key_grants_by_workspace',
          columns: ['workspace_id'],
        },
        {
          name: 'device_key_grants_by_workspace_key',
          columns: ['workspace_id', 'key_id'],
        },
      ],
    },
  ],
};

function taskRow(
  rowId: string,
  project: string,
  serverVersion = 1,
  data: Uint8Array | null = bytes(1, 2, 3),
): StoredRow {
  return {
    rowId,
    serverVersion,
    scopes: { project_id: project },
    payload: encodeRow(TASKS_COLUMNS, [rowId, project, data]),
  };
}

function docRow(rowId: string, project: string, serverVersion = 1): StoredRow {
  return {
    rowId,
    serverVersion,
    scopes: { project_id: project },
    payload: encodeRow(DOCS_COLUMNS, [rowId, 'o1', project]),
  };
}

function deviceKeyGrantRow(
  rowId: string,
  userId: string,
  workspaceId: string,
): StoredRow {
  return {
    rowId,
    serverVersion: 1,
    scopes: { user_id: userId },
    payload: encodeRow(DEVICE_KEY_GRANTS_COLUMNS, [
      rowId,
      userId,
      workspaceId,
      `key-${rowId}`,
    ]),
  };
}

export function runStorageContract(
  name: string,
  makeStorage: () => ServerStorage | Promise<ServerStorage>,
): void {
  // Relational row tables are created up front (the handler does this on
  // first contact in production; the contract drives storage directly).
  const make = async (): Promise<ServerStorage> => {
    const storage = await makeStorage();
    await storage.ensureSchema(compileSchema(CONTRACT_SCHEMA));
    return storage;
  };
  describe(`ServerStorage contract (${name})`, () => {
    test('prepares a non-push authority transaction without an idempotency read', async () => {
      const storage = await make();
      const tx = await storage.begin(PARTITION);
      let readPushResult = false;
      const guarded = new Proxy(tx, {
        get(target, property) {
          if (property === 'getPushResult') {
            readPushResult = true;
            throw new Error('unexpected push identity lookup');
          }
          const value = Reflect.get(target, property, target);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
      try {
        if (name === 'd1/double') {
          await expect(
            prepareAuthorityTransaction(guarded, CONTRACT_SCHEMA.version),
          ).rejects.toMatchObject({
            code: 'sync.storage.partition_lock_unsupported',
          });
          return;
        }
        await prepareAuthorityTransaction(guarded, CONTRACT_SCHEMA.version);
        await tx.upsertRow('tasks', taskRow('authority-row', 'p1'));
        expect(await tx.getRow('tasks', 'authority-row')).toMatchObject({
          rowId: 'authority-row',
        });
        await tx.commit();
      } finally {
        await tx.rollback();
      }
      expect(readPushResult).toBe(false);
      expect(
        await storage.getRow(PARTITION, 'tasks', 'authority-row'),
      ).toBeDefined();
    });

    test('a missing partition-lock capability fails before a gate read', async () => {
      const storage = await make();
      const tx = await storage.begin(PARTITION);
      try {
        for (const missing of [undefined, null]) {
          const unsupported = new Proxy(tx, {
            get(target, property, receiver) {
              if (property === 'lockPartition') return missing;
              if (property === 'readServeGate')
                throw new Error('unexpected gate read');
              return Reflect.get(target, property, receiver);
            },
          });
          await expect(
            prepareAuthorityTransaction(unsupported, CONTRACT_SCHEMA.version),
          ).rejects.toMatchObject({
            code: 'sync.storage.partition_lock_unsupported',
          });
        }
      } finally {
        await tx.rollback();
      }
    });

    test('invalid authority schema versions fail before invoking the lock capability', async () => {
      const storage = await make();
      const tx = await storage.begin(PARTITION);
      const guarded = new Proxy(tx, {
        get(target, property, receiver) {
          if (property === 'lockPartition') throw new Error('unexpected lock');
          return Reflect.get(target, property, receiver);
        },
      });
      try {
        for (const version of [
          0,
          -1,
          1.5,
          Number.NaN,
          Number.POSITIVE_INFINITY,
          0x80000000,
        ]) {
          await expect(
            prepareAuthorityTransaction(guarded, version),
          ).rejects.toMatchObject({
            code: 'sync.invalid_request',
          });
        }
      } finally {
        await tx.rollback();
      }
    });

    test('appendCommit allocates a dense per-partition commitSeq', async () => {
      const storage = await make();
      const seqs: number[] = [];
      for (let i = 0; i < 3; i++) {
        const tx = await storage.begin(PARTITION);
        const seq = await tx.appendCommit({
          clientId: 'c1',
          clientCommitId: `commit-${i}`,
          actorId: 'a1',
          createdAtMs: NOW + i,
          changes: [
            {
              table: 'tasks',
              rowId: `r${i}`,
              op: 'upsert',
              rowVersion: 1,
              scopes: { project_id: 'p1' },
              payload: bytes(i),
            },
          ],
        });
        await tx.commit();
        seqs.push(seq);
      }
      expect(seqs).toEqual([1, 2, 3]);
      expect(await storage.getMaxCommitSeq(PARTITION)).toBe(3);
    });

    test('a delete followed by an upsert in one commit leaves no tombstone', async () => {
      const storage = await make();
      const seed = await storage.begin(PARTITION);
      await seed.upsertRow('tasks', taskRow('r1', 'p1'));
      await seed.appendCommit({
        clientId: 'c1',
        clientCommitId: 'seed',
        actorId: 'a1',
        createdAtMs: NOW,
        changes: [
          {
            table: 'tasks',
            rowId: 'r1',
            op: 'upsert',
            rowVersion: 1,
            scopes: { project_id: 'p1' },
            payload: taskRow('r1', 'p1').payload,
          },
        ],
      });
      await seed.commit();

      const move = await storage.begin(PARTITION);
      await move.deleteRow('tasks', 'r1');
      await move.upsertRow('tasks', taskRow('r1', 'p2'));
      await move.appendCommit({
        clientId: 'c1',
        clientCommitId: 'move',
        actorId: 'a1',
        createdAtMs: NOW + 1,
        changes: [
          {
            table: 'tasks',
            rowId: 'r1',
            op: 'delete',
            rowVersion: 2,
            scopes: { project_id: 'p1' },
          },
          {
            table: 'tasks',
            rowId: 'r1',
            op: 'upsert',
            rowVersion: 1,
            scopes: { project_id: 'p2' },
            payload: taskRow('r1', 'p2').payload,
          },
        ],
      });
      await move.commit();
      const moved = await storage.begin(PARTITION);
      expect(await moved.getTombstone('tasks', 'r1')).toBeUndefined();
      await moved.rollback();
      expect((await storage.getRow(PARTITION, 'tasks', 'r1'))?.scopes).toEqual({
        project_id: 'p2',
      });

      const del = await storage.begin(PARTITION);
      await del.deleteRow('tasks', 'r1');
      const seq = await del.appendCommit({
        clientId: 'c1',
        clientCommitId: 'delete',
        actorId: 'a1',
        createdAtMs: NOW + 2,
        // A commit that deletes one row twice keeps its last delete.
        changes: [
          {
            table: 'tasks',
            rowId: 'r1',
            op: 'delete',
            rowVersion: 1,
            scopes: { project_id: 'p1' },
          },
          {
            table: 'tasks',
            rowId: 'r1',
            op: 'delete',
            rowVersion: 3,
            scopes: { project_id: 'p2' },
          },
        ],
      });
      await del.commit();
      const after = await storage.begin(PARTITION);
      // §2.2: the tombstone carries the deleted row's version and scopes.
      expect(await after.getTombstone('tasks', 'r1')).toEqual({
        commitSeq: seq,
        serverVersion: 3,
        scopes: { project_id: 'p2' },
      });
      await after.rollback();
    });

    test('commitSeq is per-partition (independent counters)', async () => {
      const storage = await make();
      const txA = await storage.begin('part-a');
      const a = await txA.appendCommit({
        clientId: 'c',
        clientCommitId: 'x',
        actorId: 'a',
        createdAtMs: NOW,
        changes: [
          {
            table: 'tasks',
            rowId: 'r',
            op: 'upsert',
            rowVersion: 1,
            scopes: { project_id: 'p1' },
            payload: bytes(1),
          },
        ],
      });
      await txA.commit();
      const txB = await storage.begin('part-b');
      const b = await txB.appendCommit({
        clientId: 'c',
        clientCommitId: 'x',
        actorId: 'a',
        createdAtMs: NOW,
        changes: [
          {
            table: 'tasks',
            rowId: 'r',
            op: 'upsert',
            rowVersion: 1,
            scopes: { project_id: 'p1' },
            payload: bytes(1),
          },
        ],
      });
      await txB.commit();
      expect(a).toBe(1);
      expect(b).toBe(1);
    });

    test('rollback discards writes and does not consume a commitSeq', async () => {
      const storage = await make();
      const tx1 = await storage.begin(PARTITION);
      await tx1.appendCommit({
        clientId: 'c',
        clientCommitId: 'a',
        actorId: 'a',
        createdAtMs: NOW,
        changes: [
          {
            table: 'tasks',
            rowId: 'r1',
            op: 'upsert',
            rowVersion: 1,
            scopes: { project_id: 'p1' },
            payload: bytes(1),
          },
        ],
      });
      await tx1.rollback();
      expect(await storage.getMaxCommitSeq(PARTITION)).toBe(0);
      // Next real commit is still seq 1 (no gap from the rolled-back one).
      const tx2 = await storage.begin(PARTITION);
      const seq = await tx2.appendCommit({
        clientId: 'c',
        clientCommitId: 'b',
        actorId: 'a',
        createdAtMs: NOW,
        changes: [
          {
            table: 'tasks',
            rowId: 'r1',
            op: 'upsert',
            rowVersion: 1,
            scopes: { project_id: 'p1' },
            payload: bytes(2),
          },
        ],
      });
      await tx2.commit();
      expect(seq).toBe(1);
    });

    test('row upsert / getRow / delete round-trips through a transaction', async () => {
      const storage = await make();
      const tx = await storage.begin(PARTITION);
      const r1 = taskRow('r1', 'p1', 2, bytes(9, 8, 7));
      await tx.upsertRow('tasks', r1);
      const inTx = await tx.getRow('tasks', 'r1');
      expect(inTx?.serverVersion).toBe(2);
      // The relational store re-serves the payload byte-verbatim because
      // `_sync_payload` is the wire source of truth.
      expect(inTx?.payload).toEqual(r1.payload);
      expect(inTx?.scopes).toEqual({ project_id: 'p1' });
      await tx.commit();

      const stored = await storage.getRow(PARTITION, 'tasks', 'r1');
      expect(stored?.payload).toEqual(r1.payload);

      const del = await storage.begin(PARTITION);
      await del.deleteRow('tasks', 'r1');
      await del.commit();
      expect(await storage.getRow(PARTITION, 'tasks', 'r1')).toBeUndefined();
    });

    test('commit-validation reads see the candidate state inside the transaction', async () => {
      const storage = await make();
      const seed = await storage.begin(PARTITION);
      await seed.upsertRow('tasks', taskRow('r1', 'p1'));
      await seed.upsertRow('tasks', taskRow('r2', 'p2'));
      await seed.commit();

      const tx = await storage.begin(PARTITION);
      expect(tx.preparePushApply).toBeDefined();
      expect(tx.scanRows).toBeDefined();
      await tx.preparePushApply('test-client', 'test-commit', 1);
      await tx.deleteRow('tasks', 'r1');
      await tx.upsertRow('tasks', taskRow('r3', 'p1'));
      const rows = await tx.scanRows?.({
        table: 'tasks',
        scopeFilter: { project_id: ['p1'] },
        afterRowId: null,
        limit: 10,
      });
      expect(rows?.map((row) => row.rowId)).toEqual(['r3']);
      await tx.rollback();
    });

    test('commit-validation rejection discards candidates and persists its outcome under one lock', async () => {
      const storage = await make();
      const tx = await storage.begin(PARTITION);
      expect(tx.preparePushApply).toBeDefined();
      expect(tx.commitRejectedPushResult).toBeDefined();
      await tx.preparePushApply('test-client', 'test-commit', 1);
      await tx.upsertRow('tasks', taskRow('candidate', 'p1'));
      await tx.commitRejectedPushResult?.('c1', 'rejected-aggregate', {
        status: 'rejected',
        results: [
          {
            opIndex: 0,
            status: 'error',
            code: 'app.aggregate_rejected',
            message: 'diagnostic only',
            retryable: false,
          },
        ],
      });

      expect(
        await storage.getRow(PARTITION, 'tasks', 'candidate'),
      ).toBeUndefined();
      expect(
        await storage.getPushResult(PARTITION, 'c1', 'rejected-aggregate'),
      ).toEqual({
        status: 'rejected',
        results: [
          {
            opIndex: 0,
            status: 'error',
            code: 'app.aggregate_rejected',
            message: 'diagnostic only',
            retryable: false,
          },
        ],
      });
    });

    test('idempotency result persists and reads back', async () => {
      const storage = await make();
      const tx = await storage.begin(PARTITION);
      await tx.putPushResult('c1', 'commit-1', {
        status: 'applied',
        commitSeq: 5,
        recordedAtMs: 1_750_000_000_000,
        cacheIdentity: 'push-cache-1',
        results: [{ opIndex: 0, status: 'applied' }],
      });
      await tx.commit();
      const got = await storage.getPushResult(PARTITION, 'c1', 'commit-1');
      expect(got?.status).toBe('applied');
      expect(got?.commitSeq).toBe(5);
      expect(got?.recordedAtMs).toBe(1_750_000_000_000);
      expect(got?.cacheIdentity).toBe('push-cache-1');
      expect(got?.results).toEqual([{ opIndex: 0, status: 'applied' }]);
      expect(
        await storage.getPushResult(PARTITION, 'c1', 'missing'),
      ).toBeUndefined();
    });

    test('idempotency results are first-writer-safe', async () => {
      const storage = await make();
      const first: StoredPushResult = {
        status: 'rejected',
        results: [
          {
            opIndex: 1,
            status: 'error',
            code: 'app.first',
            message: 'first outcome',
            retryable: false,
          },
        ],
      };
      const second: StoredPushResult = {
        status: 'applied',
        commitSeq: 99,
        results: [{ opIndex: 0, status: 'applied' }],
      };
      const firstTx = await storage.begin(PARTITION);
      await firstTx.putPushResult('c1', 'first-writer', first);
      await firstTx.commit();
      const secondTx = await storage.begin(PARTITION);
      await secondTx.putPushResult('c1', 'first-writer', second);
      await secondTx.commit();

      expect(
        await storage.getPushResult(PARTITION, 'c1', 'first-writer'),
      ).toEqual(first);
    });

    test('reaction enqueue commits and rolls back with the source transaction', async () => {
      const storage = await make();
      const committed = await storage.begin(PARTITION);
      expect(committed.enqueueReactions).toBeDefined();
      const commitSeq = await committed.appendCommit({
        clientId: 'c1',
        clientCommitId: 'commit-1',
        actorId: 'a1',
        createdAtMs: NOW,
        changes: [],
      });
      await committed.enqueueReactions?.([reaction(commitSeq)]);
      await committed.commit();
      expect(
        await storage.getReaction?.(PARTITION, '["c1","commit-1","email"]'),
      ).toMatchObject({ status: 'pending', sourceCommitSeq: 1, attempts: 0 });
      expect(
        await storage.listReactions?.(PARTITION, {
          statuses: ['pending'],
          types: ['email.send'],
          limit: 10,
        }),
      ).toHaveLength(1);

      const rolledBack = await storage.begin(PARTITION);
      const rolledBackSeq = await rolledBack.appendCommit({
        clientId: 'c1',
        clientCommitId: 'commit-2',
        actorId: 'a1',
        createdAtMs: NOW + 1,
        changes: [],
      });
      await rolledBack.enqueueReactions?.([
        reaction(rolledBackSeq, '["c1","commit-2","email"]'),
      ]);
      await rolledBack.rollback();
      expect(
        await storage.getReaction?.(PARTITION, '["c1","commit-2","email"]'),
      ).toBeUndefined();
      expect(await storage.getMaxCommitSeq(PARTITION)).toBe(1);
    });

    test('concurrent claimers lease one reaction to one worker', async () => {
      const storage = await make();
      const tx = await storage.begin(PARTITION);
      await tx.enqueueReactions?.([reaction(1)]);
      await tx.commit();
      const [left, right] = await Promise.all([
        storage.claimReactions?.(PARTITION, {
          leaseOwner: 'lease-1',
          types: ['email.send'],
          nowMs: NOW,
          leaseDurationMs: 100,
          limit: 1,
        }),
        storage.claimReactions?.(PARTITION, {
          leaseOwner: 'lease-2',
          types: ['email.send'],
          nowMs: NOW,
          leaseDurationMs: 100,
          limit: 1,
        }),
      ]);
      expect((left?.length ?? 0) + (right?.length ?? 0)).toBe(1);
      const claimed = [...(left ?? []), ...(right ?? [])][0];
      expect(claimed?.status).toBe('leased');
      expect(claimed?.attempts).toBe(1);
    });

    test('expired leases are reclaimed and stale owners cannot acknowledge', async () => {
      const storage = await make();
      const tx = await storage.begin(PARTITION);
      await tx.enqueueReactions?.([reaction(1)]);
      await tx.commit();
      const first = await storage.claimReactions?.(PARTITION, {
        leaseOwner: 'lease-1',
        types: ['email.send'],
        nowMs: NOW,
        leaseDurationMs: 100,
        limit: 1,
      });
      expect(first).toHaveLength(1);
      expect(
        await storage.extendReactionLease?.(
          PARTITION,
          reaction(1).idempotencyKey,
          'lease-1',
          NOW + 200,
        ),
      ).toBe(true);
      expect(
        await storage.claimReactions?.(PARTITION, {
          leaseOwner: 'lease-2',
          types: ['email.send'],
          nowMs: NOW + 199,
          leaseDurationMs: 100,
          limit: 1,
        }),
      ).toHaveLength(0);
      const reclaimed = await storage.claimReactions?.(PARTITION, {
        leaseOwner: 'lease-2',
        types: ['email.send'],
        nowMs: NOW + 200,
        leaseDurationMs: 100,
        limit: 1,
      });
      expect(reclaimed?.[0]).toMatchObject({
        leaseOwner: 'lease-2',
        attempts: 2,
      });
      expect(
        await storage.completeReaction?.(
          PARTITION,
          reaction(1).idempotencyKey,
          'lease-1',
          NOW + 201,
        ),
      ).toBe(false);
      expect(
        await storage.completeReaction?.(
          PARTITION,
          reaction(1).idempotencyKey,
          'lease-2',
          NOW + 201,
        ),
      ).toBe(true);
    });

    test('retry, dead-letter, and manual retry state round-trip', async () => {
      const storage = await make();
      const tx = await storage.begin(PARTITION);
      await tx.enqueueReactions?.([reaction(1)]);
      await tx.commit();
      await storage.claimReactions?.(PARTITION, {
        leaseOwner: 'lease-1',
        types: ['email.send'],
        nowMs: NOW,
        leaseDurationMs: 100,
        limit: 1,
      });
      expect(
        await storage.failReaction?.(PARTITION, reaction(1).idempotencyKey, {
          leaseOwner: 'lease-1',
          failure: { code: 'email.unavailable', atMs: NOW + 1 },
          retryAtMs: NOW + 50,
        }),
      ).toBe(true);
      expect(
        await storage.getReaction?.(PARTITION, reaction(1).idempotencyKey),
      ).toMatchObject({ status: 'pending', availableAtMs: NOW + 50 });
      await storage.claimReactions?.(PARTITION, {
        leaseOwner: 'lease-1',
        types: ['email.send'],
        nowMs: NOW + 50,
        leaseDurationMs: 100,
        limit: 1,
      });
      expect(
        await storage.failReaction?.(PARTITION, reaction(1).idempotencyKey, {
          leaseOwner: 'lease-1',
          failure: { code: 'email.invalid', atMs: NOW + 51 },
        }),
      ).toBe(true);
      expect(
        await storage.getReaction?.(PARTITION, reaction(1).idempotencyKey),
      ).toMatchObject({ status: 'dead-letter', attempts: 2 });
      expect(
        await storage.retryReaction?.(
          PARTITION,
          reaction(1).idempotencyKey,
          NOW + 60,
        ),
      ).toBe(true);
      expect(
        await storage.getReaction?.(PARTITION, reaction(1).idempotencyKey),
      ).toMatchObject({ status: 'pending', attempts: 0 });
    });

    test('reaction pruning is bounded and deletes only aged terminal rows', async () => {
      const storage = await make();
      const tx = await storage.begin(PARTITION);
      await tx.enqueueReactions?.([
        { ...reaction(0, 'pending'), type: 'reaction.pending' },
        { ...reaction(0, 'leased'), type: 'reaction.leased' },
        { ...reaction(0, 'a-completed-old'), type: 'reaction.completed-old' },
        {
          ...reaction(0, 'completed-boundary'),
          type: 'reaction.completed-boundary',
        },
        { ...reaction(0, 'b-dead-old'), type: 'reaction.dead-old' },
        {
          ...reaction(0, 'dead-boundary'),
          type: 'reaction.dead-boundary',
        },
      ]);
      await tx.commit();
      const claim = async (type: string, leaseOwner: string) => {
        const claimed = await storage.claimReactions?.(PARTITION, {
          leaseOwner,
          types: [type],
          nowMs: NOW,
          leaseDurationMs: 100,
          limit: 1,
        });
        expect(claimed).toHaveLength(1);
      };
      await claim('reaction.leased', 'leased-owner');
      await claim('reaction.completed-old', 'completed-old-owner');
      expect(
        await storage.completeReaction?.(
          PARTITION,
          'a-completed-old',
          'completed-old-owner',
          NOW + 10,
        ),
      ).toBe(true);
      await claim('reaction.completed-boundary', 'completed-boundary-owner');
      expect(
        await storage.completeReaction?.(
          PARTITION,
          'completed-boundary',
          'completed-boundary-owner',
          NOW + 200,
        ),
      ).toBe(true);
      await claim('reaction.dead-old', 'dead-old-owner');
      expect(
        await storage.failReaction?.(PARTITION, 'b-dead-old', {
          leaseOwner: 'dead-old-owner',
          failure: { code: 'reaction.dead_old', atMs: NOW + 20 },
        }),
      ).toBe(true);
      await claim('reaction.dead-boundary', 'dead-boundary-owner');
      expect(
        await storage.failReaction?.(PARTITION, 'dead-boundary', {
          leaseOwner: 'dead-boundary-owner',
          failure: { code: 'reaction.dead_boundary', atMs: NOW + 200 },
        }),
      ).toBe(true);

      expect(
        await storage.pruneReactions?.(PARTITION, {
          completedBeforeMs: NOW + 200,
          deadLetterBeforeMs: NOW + 200,
          limit: 1,
        }),
      ).toEqual({ completed: 1, deadLetter: 0 });
      expect(
        await storage.pruneReactions?.(PARTITION, {
          completedBeforeMs: NOW + 200,
          deadLetterBeforeMs: NOW + 200,
          limit: 10,
        }),
      ).toEqual({ completed: 0, deadLetter: 1 });
      expect(await storage.getReaction?.(PARTITION, 'pending')).toMatchObject({
        status: 'pending',
      });
      expect(await storage.getReaction?.(PARTITION, 'leased')).toMatchObject({
        status: 'leased',
      });
      expect(
        await storage.getReaction?.(PARTITION, 'completed-boundary'),
      ).toMatchObject({ status: 'completed' });
      expect(
        await storage.getReaction?.(PARTITION, 'dead-boundary'),
      ).toMatchObject({ status: 'dead-letter' });
    });

    test('commit-log pruning never deletes pending reactions', async () => {
      const storage = await make();
      const tx = await storage.begin(PARTITION);
      const commitSeq = await tx.appendCommit({
        clientId: 'c1',
        clientCommitId: 'commit-1',
        actorId: 'a1',
        createdAtMs: NOW,
        changes: [],
      });
      await tx.enqueueReactions?.([reaction(commitSeq)]);
      await tx.commit();
      const { logEpoch } = await storage.touchPartition(
        PARTITION,
        NOW,
        'prune-epoch',
      );
      expect(
        (
          await storage.pruneCommitsThrough(PARTITION, {
            logEpoch,
            throughSeq: commitSeq,
          })
        ).removedCommits,
      ).toBe(1);
      expect(
        await storage.getReaction?.(PARTITION, reaction(1).idempotencyKey),
      ).toMatchObject({ status: 'pending', sourceCommitSeq: 1 });
    });

    test('conflict push-result bytes round-trip', async () => {
      const storage = await make();
      const tx = await storage.begin(PARTITION);
      await tx.putPushResult('c1', 'commit-2', {
        status: 'rejected',
        results: [
          {
            opIndex: 0,
            status: 'conflict',
            code: 'sync.conflict',
            message: 'stale',
            serverVersion: 7,
            serverRow: bytes(200, 201, 202),
            conflictColumns: bytes(0b0100_0000),
          },
        ],
      });
      await tx.commit();
      const got = await storage.getPushResult(PARTITION, 'c1', 'commit-2');
      const record = got?.results[0];
      expect(record?.status).toBe('conflict');
      if (record?.status === 'conflict') {
        expect(record.serverVersion).toBe(7);
        expect(record.serverRow).toEqual(bytes(200, 201, 202));
        expect(record.conflictColumns).toEqual(bytes(0b0100_0000));
      }
    });

    // --- Inverted scope index (§3.1) — the reason Postgres storage exists ---

    test('readLiveWindow scans unit keys across tables, oldest first, never splitting a commit', async () => {
      const storage = await make();
      const changes: [string, string, Record<string, string>][][] = [
        [
          ['tasks', 't1', { project_id: 'p1' }],
          ['tasks', 'x1', { project_id: 'p2' }],
          ['docs', 'd1', { org_id: 'o1', project_id: 'p1' }],
        ],
        [['tasks', 't2', { project_id: 'p2' }]],
        [['docs', 'd3', { org_id: 'o1', project_id: 'p1' }]],
      ];
      for (const [i, commit] of changes.entries()) {
        const tx = await storage.begin(PARTITION);
        await tx.appendCommit({
          clientId: 'c',
          clientCommitId: `k${i}`,
          actorId: 'a',
          createdAtMs: NOW + i,
          changes: commit.map(([table, rowId, scopes]) => ({
            table,
            rowId,
            op: 'upsert',
            rowVersion: 1,
            scopes,
            payload: bytes(i),
          })),
        });
        await tx.commit();
      }
      const unit = {
        scopes: { project_id: 'p1' },
        afterSeq: 0,
        tables: new Map([
          ['tasks', { project_id: ['p1'] }],
          ['docs', { project_id: ['p1'] }],
        ]),
      };
      const window = await storage.readLiveWindow(PARTITION, {
        units: [unit],
        throughSeq: 3,
        limitChanges: 10,
      });
      // One commit per entry with every matching change in change order.
      expect(
        window.commits.map((commit) => [
          commit.commitSeq,
          commit.actorId,
          commit.createdAtMs,
          commit.changes.map((change) => change.rowId),
        ]),
      ).toEqual([
        [1, 'a', NOW, ['t1', 'd1']],
        [3, 'a', NOW + 2, ['d3']],
      ]);
      expect(window.throughSeq).toBe(3);
      // The budget stops after the commit that reaches it: T is that commit.
      const cut = await storage.readLiveWindow(PARTITION, {
        units: [unit],
        throughSeq: 3,
        limitChanges: 1,
      });
      expect(cut.commits.map((commit) => commit.commitSeq)).toEqual([1]);
      expect(cut.commits[0]?.changes).toHaveLength(2);
      expect(cut.throughSeq).toBe(1);
      // An empty scan set reads nothing and completes through the bound.
      expect(
        await storage.readLiveWindow(PARTITION, {
          units: [{ ...unit, tables: new Map() }],
          throughSeq: 3,
          limitChanges: 10,
        }),
      ).toEqual({ commits: [], throughSeq: 3 });
    });

    test('readLiveWindow applies each unit bound and its effective scopes', async () => {
      const storage = await make();
      const changes: [string, string, Record<string, string>][] = [
        ['tasks', 't1', { project_id: 'p1' }],
        ['tasks', 't2', { project_id: 'p2' }],
        ['docs', 'd1', { org_id: 'o1', project_id: 'p1' }],
        ['docs', 'd2', { org_id: 'o2', project_id: 'p1' }],
        ['docs', 'd3', { org_id: 'o1', project_id: 'p2' }],
      ];
      for (const [i, [table, rowId, scopes]] of changes.entries()) {
        const tx = await storage.begin(PARTITION);
        await tx.appendCommit({
          clientId: 'c',
          clientCommitId: `k${i}`,
          actorId: 'a',
          createdAtMs: NOW + i,
          changes: [
            {
              table,
              rowId,
              op: 'upsert',
              rowVersion: 1,
              scopes,
              payload: bytes(i),
            },
          ],
        });
        await tx.commit();
      }
      const window = await storage.readLiveWindow(PARTITION, {
        units: [
          // Post-bootstrap at 1: t1 lies at its bound. The wildcard fence
          // narrows docs to org o2.
          {
            scopes: { project_id: 'p1' },
            afterSeq: 1,
            tables: new Map([
              ['tasks', { project_id: ['p1'] }],
              ['docs', { project_id: ['p1'], org_id: ['o2'] }],
            ]),
          },
          // A two-variable unit: its first variable (org_id) is the index
          // key, and code verifies project_id.
          {
            scopes: { org_id: 'o1', project_id: 'p2' },
            afterSeq: 0,
            tables: new Map([['docs', { org_id: ['o1'], project_id: ['p2'] }]]),
          },
        ],
        throughSeq: 5,
        limitChanges: 10,
      });
      expect(
        window.commits.map((commit) => [
          commit.commitSeq,
          commit.changes.map((change) => change.rowId),
        ]),
      ).toEqual([
        [4, ['d2']],
        [5, ['d3']],
      ]);
      expect(window.throughSeq).toBe(5);
    });

    test('readLiveWindow pages past candidates that do not match', async () => {
      const storage = await make();
      for (let i = 0; i < 70; i++) {
        const tx = await storage.begin(PARTITION);
        await tx.appendCommit({
          clientId: 'c',
          clientCommitId: `k${i}`,
          actorId: 'a',
          createdAtMs: NOW + i,
          changes: [
            {
              table: 'docs',
              rowId: `d${i}`,
              op: 'upsert',
              rowVersion: 1,
              scopes: { org_id: i === 69 ? 'o1' : 'o9', project_id: 'p1' },
              payload: bytes(i),
            },
          ],
        });
        await tx.commit();
      }
      const window = await storage.readLiveWindow(PARTITION, {
        units: [
          {
            scopes: { project_id: 'p1' },
            afterSeq: 0,
            tables: new Map([['docs', { project_id: ['p1'], org_id: ['o1'] }]]),
          },
        ],
        throughSeq: 70,
        limitChanges: 1,
      });
      expect(window.commits.map((commit) => commit.commitSeq)).toEqual([70]);
      expect(window.throughSeq).toBe(70);
    });

    test('latestScopedChangeSeq reads the newest commit of a table for the unit key', async () => {
      const storage = await make();
      for (const [i, [table, project]] of [
        ['tasks', 'p1'],
        ['docs', 'p1'],
        ['tasks', 'p2'],
      ].entries()) {
        const tx = await storage.begin(PARTITION);
        await tx.appendCommit({
          clientId: 'c',
          clientCommitId: `k${i}`,
          actorId: 'a',
          createdAtMs: NOW + i,
          changes: [
            {
              table: table ?? 'tasks',
              rowId: `r${i}`,
              op: 'upsert',
              rowVersion: 1,
              scopes:
                table === 'docs'
                  ? { org_id: 'o1', project_id: project ?? '' }
                  : { project_id: project ?? '' },
              payload: bytes(i),
            },
          ],
        });
        await tx.commit();
      }
      const latest = (table: string, scopes: Record<string, string>) =>
        storage.latestScopedChangeSeq(PARTITION, { table, scopes });
      expect(await latest('tasks', { project_id: 'p1' })).toBe(1);
      expect(await latest('docs', { project_id: 'p1' })).toBe(2);
      expect(await latest('docs', { org_id: 'o1', project_id: 'p1' })).toBe(2);
      expect(await latest('tasks', { project_id: 'p9' })).toBe(0);
    });

    // --- Per-outbox acknowledged watermark (§6.3.2) and §9 settlement ---

    /**
     * One push request as the push path drives it: the first commit's
     * transaction carries the settlement and commits whatever the outcome; a
     * commit below the watermark without a result is expired, unpersisted.
     */
    async function push(
      storage: ServerStorage,
      outboxId: string,
      commits: readonly (readonly [string, number])[],
    ): Promise<{ watermark: number; outcomes: string[] }> {
      let watermark = 0;
      const outcomes: string[] = [];
      for (const [i, [clientCommitId, clientSeq]] of commits.entries()) {
        const tx = await storage.begin(PARTITION);
        const prepared = await tx.preparePushApply(
          'c1',
          clientCommitId,
          1,
          [],
          i === 0
            ? {
                outboxId,
                commits: commits.map(([id, seq]) => ({
                  clientCommitId: id,
                  clientSeq: seq,
                })),
              }
            : undefined,
        );
        if (i === 0) watermark = prepared.watermark ?? -1;
        if (prepared.persisted !== undefined) {
          outcomes.push(`cached:${prepared.persisted.commitSeq}`);
        } else if (clientSeq < watermark) {
          outcomes.push('expired');
        } else {
          const commitSeq = await tx.appendCommit({
            clientId: 'c1',
            clientCommitId,
            actorId: 'a1',
            createdAtMs: NOW,
            changes: [],
          });
          await tx.putPushResult(
            'c1',
            clientCommitId,
            {
              status: 'applied',
              commitSeq,
              results: [],
            },
            { outboxId, clientSeq },
          );
          outcomes.push(`applied:${commitSeq}`);
        }
        await tx.commit();
      }
      return { watermark, outcomes };
    }

    test('the watermark deletes results the replica cannot resend and refuses late duplicates', async () => {
      const storage = await make();
      expect(
        await push(storage, 'o1', [
          ['A', 1],
          ['B', 2],
        ]),
      ).toEqual({
        watermark: 1,
        outcomes: ['applied:1', 'applied:2'],
      });
      // Lost acknowledgement: A is still first, so both results replay.
      expect(
        await push(storage, 'o1', [
          ['A', 1],
          ['B', 2],
        ]),
      ).toEqual({
        watermark: 1,
        outcomes: ['cached:1', 'cached:2'],
      });
      expect(await push(storage, 'o1', [['C', 3]])).toEqual({
        watermark: 3,
        outcomes: ['applied:3'],
      });
      expect(await storage.getPushResult(PARTITION, 'c1', 'A')).toBeUndefined();
      expect(await storage.getPushResult(PARTITION, 'c1', 'B')).toBeUndefined();
      // A delayed copy of the first request neither lowers W nor applies.
      expect(
        await push(storage, 'o1', [
          ['A', 1],
          ['B', 2],
        ]),
      ).toEqual({
        watermark: 3,
        outcomes: ['expired', 'expired'],
      });
      expect(await storage.getMaxCommitSeq(PARTITION)).toBe(3);
      // A new outbox under the same clientId starts its own sequence.
      expect(await push(storage, 'o2', [['D', 1]])).toEqual({
        watermark: 1,
        outcomes: ['applied:4'],
      });
      expect(
        (await storage.getPushResult(PARTITION, 'c1', 'C'))?.commitSeq,
      ).toBe(3);
      expect(await storage.listPushWatermarks?.(PARTITION, 'A')).toEqual([
        { clientId: 'c1', outboxId: 'o1', throughSeq: 3 },
        { clientId: 'c1', outboxId: 'o2', throughSeq: 1 },
      ]);
      // A log epoch rotation deletes the client records and keeps watermarks.
      await storage.rotatePartitionLogEpoch(PARTITION, 'epoch-b', NOW);
      expect((await push(storage, 'o1', [['E', 2]])).outcomes).toEqual([
        'expired',
      ]);
    });

    test('after N requests one replica holds the last request results and one watermark row', async () => {
      const storage = await make();
      // A result without an outbox (a §6.10 producer) is never deleted.
      const producer = await storage.begin(PARTITION);
      await producer.putPushResult('producer', 'P', {
        status: 'applied',
        commitSeq: 0,
        results: [],
      });
      await producer.commit();
      for (let request = 0; request < 5; request++) {
        await push(storage, 'o1', [
          [`r${request}a`, 2 * request + 1],
          [`r${request}b`, 2 * request + 2],
        ]);
      }
      const retained: string[] = [];
      for (let request = 0; request < 5; request++) {
        for (const id of [`r${request}a`, `r${request}b`]) {
          if ((await storage.getPushResult(PARTITION, 'c1', id)) !== undefined)
            retained.push(id);
        }
      }
      expect(retained).toEqual(['r4a', 'r4b']);
      expect(await storage.listPushWatermarks?.(PARTITION, 'r4b')).toEqual([
        { clientId: 'c1', outboxId: 'o1', throughSeq: 9 },
      ]);
      expect(
        await storage.getPushResult(PARTITION, 'producer', 'P'),
      ).toBeDefined();
    });

    test('results stored before wire version 4 are sequenced by their request and deleted once the last commit holds none', async () => {
      const storage = await make();
      const before = await storage.begin(PARTITION);
      for (const [id, commitSeq] of [
        ['X', 1],
        ['Y', 2],
        ['Z', 3],
      ] as const) {
        await before.putPushResult('c1', id, {
          status: 'applied',
          commitSeq,
          results: [],
        });
      }
      await before.commit();
      // X left the outbox; a push budget cut the request after Y. Y's last
      // commit holds a pre-upgrade result, so Z stays.
      expect(await push(storage, 'o1', [['Y', 5]])).toEqual({
        watermark: 5,
        outcomes: ['cached:2'],
      });
      expect(await storage.getPushResult(PARTITION, 'c1', 'X')).toBeDefined();
      expect(await storage.getPushResult(PARTITION, 'c1', 'Z')).toBeDefined();
      // The next request ends with a new commit: X is deleted, Z takes its
      // sequence and replays, and the watermark deletes Y.
      expect(
        await push(storage, 'o1', [
          ['Z', 6],
          ['N', 7],
        ]),
      ).toEqual({
        watermark: 6,
        outcomes: ['cached:3', 'applied:1'],
      });
      expect(await storage.getPushResult(PARTITION, 'c1', 'X')).toBeUndefined();
      expect(await storage.getPushResult(PARTITION, 'c1', 'Y')).toBeUndefined();
      expect(await push(storage, 'o1', [['N', 7]])).toEqual({
        watermark: 7,
        outcomes: ['cached:1'],
      });
      expect(await storage.getPushResult(PARTITION, 'c1', 'Z')).toBeUndefined();
    });

    test('a late request expires a pre-upgrade result its watermark passed', async () => {
      const storage = await make();
      const before = await storage.begin(PARTITION);
      for (const [id, commitSeq] of [
        ['X', 1],
        ['Y', 2],
      ] as const) {
        await before.putPushResult('c1', id, {
          status: 'applied',
          commitSeq,
          results: [],
        });
      }
      await before.commit();
      // Y's request ends on a pre-upgrade result, so X keeps its result.
      expect(await push(storage, 'o1', [['Y', 4]])).toEqual({
        watermark: 4,
        outcomes: ['cached:2'],
      });
      // A delayed request built before Y's: X takes sequence 2, below W, and
      // its result is deleted in the same transaction, so X expires.
      expect(
        await push(storage, 'o1', [
          ['X', 2],
          ['Y', 4],
        ]),
      ).toEqual({
        watermark: 4,
        outcomes: ['expired', 'cached:2'],
      });
      expect(await storage.getPushResult(PARTITION, 'c1', 'X')).toBeUndefined();
    });

    test('the settlement survives a rejected first commit', async () => {
      const storage = await make();
      await push(storage, 'o1', [['A', 1]]);
      const tx = await storage.begin(PARTITION);
      const prepared = await tx.preparePushApply('c1', 'B', 1, [], {
        outboxId: 'o1',
        commits: [{ clientCommitId: 'B', clientSeq: 2 }],
      });
      expect(prepared).toMatchObject({ persisted: undefined, watermark: 2 });
      await tx.upsertRow('tasks', taskRow('candidate', 'p1'));
      await tx.commitRejectedPushResult(
        'c1',
        'B',
        {
          status: 'rejected',
          results: [
            {
              opIndex: 0,
              status: 'error',
              code: 'app.rejected',
              message: 'diagnostic only',
              retryable: false,
            },
          ],
        },
        { outboxId: 'o1', clientSeq: 2 },
      );
      expect(await storage.getPushResult(PARTITION, 'c1', 'A')).toBeUndefined();
      expect(
        await storage.getRow(PARTITION, 'tasks', 'candidate'),
      ).toBeUndefined();
      expect((await push(storage, 'o1', [['B', 2]])).outcomes).toEqual([
        'cached:undefined',
      ]);
    });

    test('scanRows selects by scope ordered by rowId, resumable', async () => {
      const storage = await make();
      const tx = await storage.begin(PARTITION);
      await tx.upsertRow('tasks', taskRow('r3', 'p1', 1, bytes(3)));
      await tx.upsertRow('tasks', taskRow('r1', 'p1', 1, bytes(1)));
      await tx.upsertRow('tasks', taskRow('r2', 'p2', 1, bytes(2)));
      await tx.upsertRow('tasks', taskRow('r4', 'p1', 1, bytes(4)));
      await tx.commit();
      const page1 = await storage.scanRows(PARTITION, {
        table: 'tasks',
        scopeFilter: { project_id: ['p1'] },
        afterRowId: null,
        limit: 2,
      });
      expect(page1.map((r) => r.rowId)).toEqual(['r1', 'r3']);
      const page2 = await storage.scanRows(PARTITION, {
        table: 'tasks',
        scopeFilter: { project_id: ['p1'] },
        afterRowId: 'r3',
        limit: 10,
      });
      expect(page2.map((r) => r.rowId)).toEqual(['r4']);
    });

    test('scanRows rejects an empty or omitted scope filter explicitly', async () => {
      const storage = await make();
      for (const scopeFilter of [{}, undefined]) {
        try {
          await storage.scanRows(PARTITION, {
            table: 'tasks',
            scopeFilter: scopeFilter as never,
            afterRowId: null,
            limit: 10,
          });
          throw new Error('expected scanRows to reject');
        } catch (error) {
          expect(error).toBeInstanceOf(StorageQueryError);
          expect((error as StorageQueryError).code).toBe(
            'sync.storage.scan_requires_scope',
          );
          expect((error as Error).message).not.toContain('tasks');
        }
      }
    });

    test('scanRowsByIndex is exact, ordered, and resumable', async () => {
      const storage = await make();
      expect(storage.scanRowsByIndex).toBeDefined();
      const tx = await storage.begin(PARTITION);
      await tx.upsertRow('tasks', taskRow('r3', 'p1'));
      await tx.upsertRow('tasks', taskRow('r1', 'p1'));
      await tx.upsertRow('tasks', taskRow('r2', 'p2'));
      await tx.upsertRow('tasks', taskRow('r4', 'p1'));
      await tx.commit();

      const page1 = await storage.scanRowsByIndex?.(PARTITION, {
        table: 'tasks',
        index: 'tasks_by_project',
        values: ['p1'],
        afterRowId: null,
        limit: 2,
      });
      expect(page1?.map((row) => row.rowId)).toEqual(['r1', 'r3']);
      const page2 = await storage.scanRowsByIndex?.(PARTITION, {
        table: 'tasks',
        index: 'tasks_by_project',
        values: ['p1'],
        afterRowId: 'r3',
        limit: 10,
      });
      expect(page2?.map((row) => row.rowId)).toEqual(['r4']);
    });

    test('trusted alternate lookup does not become a client-visible scope', async () => {
      const storage = await make();
      const table =
        compileSchema(CONTRACT_SCHEMA).tables.get('device_key_grants');
      expect([...(table?.declaredVariables ?? [])]).toEqual(['user_id']);

      const tx = await storage.begin(PARTITION);
      await tx.upsertRow(
        'device_key_grants',
        deviceKeyGrantRow('g1', 'user-1', 'workspace-1'),
      );
      await tx.upsertRow(
        'device_key_grants',
        deviceKeyGrantRow('g2', 'user-2', 'workspace-1'),
      );
      await tx.upsertRow(
        'device_key_grants',
        deviceKeyGrantRow('g3', 'user-3', 'workspace-2'),
      );
      await tx.commit();

      const grants = await storage.scanRowsByIndex?.(PARTITION, {
        table: 'device_key_grants',
        index: 'device_key_grants_by_workspace',
        values: ['workspace-1'],
        afterRowId: null,
        limit: 10,
      });
      expect(grants?.map((row) => row.rowId)).toEqual(['g1', 'g2']);
      expect(grants?.map((row) => row.scopes)).toEqual([
        { user_id: 'user-1' },
        { user_id: 'user-2' },
      ]);

      const exactCompound = await storage.scanRowsByIndex?.(PARTITION, {
        table: 'device_key_grants',
        index: 'device_key_grants_by_workspace_key',
        values: ['workspace-1', 'key-g2'],
        afterRowId: null,
        limit: 10,
      });
      expect(exactCompound?.map((row) => row.rowId)).toEqual(['g2']);
    });

    test('transaction index scans see staged upserts, moves, and deletes', async () => {
      const storage = await make();
      const seed = await storage.begin(PARTITION);
      await seed.upsertRow('tasks', taskRow('r1', 'p1'));
      await seed.upsertRow('tasks', taskRow('r2', 'p1'));
      await seed.commit();

      const tx = await storage.begin(PARTITION);
      expect(tx.scanRowsByIndex).toBeDefined();
      await tx.deleteRow('tasks', 'r1');
      await tx.upsertRow('tasks', taskRow('r2', 'p2', 2));
      await tx.upsertRow('tasks', taskRow('r3', 'p1'));
      const rows = await tx.scanRowsByIndex?.({
        table: 'tasks',
        index: 'tasks_by_project',
        values: ['p1'],
        afterRowId: null,
        limit: 10,
      });
      expect(rows?.map((row) => row.rowId)).toEqual(['r3']);
      await tx.rollback();
    });

    test('transaction getRows matches N getRow calls for stored, absent, and staged rows', async () => {
      const storage = await make();
      const seed = await storage.begin(PARTITION);
      await seed.upsertRow('tasks', taskRow('stored', 'p1'));
      await seed.upsertRow('tasks', taskRow('deleted', 'p1'));
      await seed.commit();

      const tx = await storage.begin(PARTITION);
      expect(tx.getRows).toBeDefined();
      await tx.deleteRow('tasks', 'deleted');
      await tx.upsertRow('tasks', taskRow('written', 'p1', 7));
      const ids = ['stored', 'absent', 'deleted', 'written', 'stored'];
      const batch = await tx.getRows?.('tasks', ids);
      for (const rowId of ['stored', 'absent', 'deleted', 'written']) {
        expect(batch?.get(rowId)).toEqual(await tx.getRow('tasks', rowId));
      }
      expect([...(batch?.keys() ?? [])].sort()).toEqual(['stored', 'written']);
      expect(batch?.get('written')?.serverVersion).toBe(7);
      expect((await tx.getRows?.('tasks', []))?.size).toBe(0);
      await tx.rollback();
    });

    test('scanRowsByIndex rejects undeclared, malformed, and unbounded lookups', async () => {
      const storage = await make();
      expect(storage.scanRowsByIndex).toBeDefined();
      const cases = [
        {
          query: {
            table: 'tasks',
            index: 'missing',
            values: ['p1'],
            afterRowId: null,
            limit: 10,
          },
          code: 'sync.storage.index_not_found',
        },
        {
          query: {
            table: 'tasks',
            index: 'tasks_by_project',
            values: [],
            afterRowId: null,
            limit: 10,
          },
          code: 'sync.storage.index_value_count_mismatch',
        },
        {
          // A leading value is not a SQL-style prefix scan. Hosts that need
          // all Workspace rows must declare the dedicated one-column index.
          query: {
            table: 'device_key_grants',
            index: 'device_key_grants_by_workspace_key',
            values: ['workspace-1'],
            afterRowId: null,
            limit: 10,
          },
          code: 'sync.storage.index_value_count_mismatch',
        },
        {
          query: {
            table: 'tasks',
            index: 'tasks_by_project',
            values: ['p1'],
            afterRowId: null,
            limit: 1_001,
          },
          code: 'sync.storage.invalid_limit',
        },
      ] as const;
      const expectRejection = async (
        run: () => Promise<unknown>,
        code: (typeof cases)[number]['code'],
      ) => {
        try {
          await run();
          throw new Error('expected scanRowsByIndex to reject');
        } catch (error) {
          expect(error).toBeInstanceOf(StorageQueryError);
          expect((error as StorageQueryError).code).toBe(code);
          expect((error as Error).message).not.toContain('tasks');
          expect((error as Error).message).not.toContain('p1');
        }
      };
      for (const { query, code } of cases) {
        await expectRejection(
          async () => storage.scanRowsByIndex?.(PARTITION, query),
          code,
        );
      }
      // The same contract holds on a push transaction, where the commit
      // readers call it.
      const tx = await storage.begin(PARTITION);
      for (const { query, code } of cases) {
        await expectRejection(async () => tx.scanRowsByIndex?.(query), code);
      }
      await tx.rollback();
    });

    test('deleting a row removes it from the scope scan', async () => {
      const storage = await make();
      const tx = await storage.begin(PARTITION);
      await tx.upsertRow('tasks', taskRow('r1', 'p1'));
      await tx.commit();
      const del = await storage.begin(PARTITION);
      await del.deleteRow('tasks', 'r1');
      await del.commit();
      const scan = await storage.scanRows(PARTITION, {
        table: 'tasks',
        scopeFilter: { project_id: ['p1'] },
        afterRowId: null,
        limit: 10,
      });
      expect(scan.length).toBe(0);
    });

    test('re-scoping a row moves it in the inverted index', async () => {
      const storage = await make();
      const tx = await storage.begin(PARTITION);
      await tx.upsertRow('tasks', taskRow('r1', 'p1'));
      await tx.commit();
      const move = await storage.begin(PARTITION);
      await move.upsertRow('tasks', taskRow('r1', 'p2', 2));
      await move.commit();
      const p1 = await storage.scanRows(PARTITION, {
        table: 'tasks',
        scopeFilter: { project_id: ['p1'] },
        afterRowId: null,
        limit: 10,
      });
      const p2 = await storage.scanRows(PARTITION, {
        table: 'tasks',
        scopeFilter: { project_id: ['p2'] },
        afterRowId: null,
        limit: 10,
      });
      expect(p1.length).toBe(0);
      expect(p2.map((r) => r.rowId)).toEqual(['r1']);
    });

    test('re-scoping one variable keeps the unchanged scope-index key', async () => {
      const storage = await make();
      const doc = (project: string, serverVersion: number): StoredRow => ({
        ...docRow('d1', project, serverVersion),
        scopes: { org_id: 'o1', project_id: project },
      });
      const tx = await storage.begin(PARTITION);
      await tx.upsertRow('docs', doc('p1', 1));
      await tx.commit();
      const move = await storage.begin(PARTITION);
      await move.upsertRow('docs', doc('p2', 2));
      await move.commit();
      // `scanRows` takes its candidates from the scope index, so a dropped
      // `org_id` key would hide the row from the first scan.
      const rows = async (variable: string, value: string) =>
        (
          await storage.scanRows(PARTITION, {
            table: 'docs',
            scopeFilter: { [variable]: [value] },
            afterRowId: null,
            limit: 10,
          })
        ).map((row) => row.rowId);
      expect(await rows('org_id', 'o1')).toEqual(['d1']);
      expect(await rows('project_id', 'p1')).toEqual([]);
      expect(await rows('project_id', 'p2')).toEqual(['d1']);
    });

    // --- Horizon / pruning (§4.6) ---

    test('the delete floor rises with each tombstoned delete and never falls (§2.2)', async () => {
      const storage = await make();
      const floor = async (): Promise<number> => {
        const tx = await storage.begin(PARTITION);
        const prepared = await tx.preparePushApply('c', 'floor-probe', 1);
        await tx.rollback();
        return prepared.deleteFloor;
      };
      const append = async (id: string, changes: NewChange[]) => {
        const tx = await storage.begin(PARTITION);
        await tx.appendCommit({
          clientId: 'c',
          clientCommitId: id,
          actorId: 'a',
          createdAtMs: NOW,
          changes,
        });
        await tx.commit();
      };
      const del = (rowId: string, rowVersion: number): NewChange => ({
        table: 'tasks',
        rowId,
        op: 'delete',
        rowVersion,
        scopes: { project_id: 'p1' },
      });
      expect(await floor()).toBe(0);
      await append('d1', [del('r1', 4), del('r2', 3)]);
      expect(await floor()).toBe(4);
      // A scope move's delete half leaves no tombstone and no floor.
      await append('move', [
        del('r3', 9),
        {
          table: 'tasks',
          rowId: 'r3',
          op: 'upsert',
          rowVersion: 9,
          scopes: { project_id: 'p2' },
          payload: bytes(3),
        },
      ]);
      expect(await floor()).toBe(4);
      await append('d2', [del('r4', 2)]);
      expect(await floor()).toBe(4);
      const { logEpoch } = await storage.touchPartition(
        PARTITION,
        NOW,
        'floor-epoch',
      );
      await storage.pruneCommitsThrough(PARTITION, { logEpoch, throughSeq: 3 });
      expect(await floor()).toBe(4);
    });

    test('horizon set/get and pruneCommitsThrough', async () => {
      const storage = await make();
      for (let i = 0; i < 5; i++) {
        const tx = await storage.begin(PARTITION);
        await tx.appendCommit({
          clientId: 'c',
          clientCommitId: `k${i}`,
          actorId: 'a',
          createdAtMs: NOW + i * 1000,
          changes: [
            {
              table: 'tasks',
              rowId: `r${i}`,
              op: 'upsert',
              rowVersion: 1,
              scopes: { project_id: 'p1' },
              payload: bytes(i),
            },
          ],
        });
        await tx.commit();
      }
      expect(await storage.getHorizonSeq(PARTITION)).toBe(0);
      await storage.setHorizonSeq(PARTITION, 2);
      expect(await storage.getHorizonSeq(PARTITION)).toBe(2);
      const { logEpoch } = await storage.touchPartition(
        PARTITION,
        NOW,
        'prune-epoch',
      );
      const removed = await storage.pruneCommitsThrough(PARTITION, {
        logEpoch,
        throughSeq: 2,
      });
      expect(removed).toEqual({
        previousHorizonSeq: 2,
        horizonSeq: 2,
        removedCommits: 2,
      });
      // Pruned commits vanish from the window; retained ones remain.
      const window = await storage.readLiveWindow(PARTITION, {
        units: [
          {
            scopes: { project_id: 'p1' },
            afterSeq: 0,
            tables: new Map([['tasks', { project_id: ['p1'] }]]),
          },
        ],
        throughSeq: 5,
        limitChanges: 100,
      });
      expect(window.commits.map((c) => c.commitSeq)).toEqual([3, 4, 5]);
    });

    test('atomic pruning is monotonic, epoch-fenced, and repeatable after a lost reply', async () => {
      const storage = await make();
      const { logEpoch } = await storage.touchPartition(
        PARTITION,
        NOW,
        'prune-epoch',
      );
      for (let i = 1; i <= 5; i += 1) {
        const tx = await storage.begin(PARTITION);
        await tx.appendCommit({
          clientId: 'c1',
          clientCommitId: `prune-${i}`,
          actorId: 'a1',
          createdAtMs: NOW,
          changes: [],
        });
        await tx.commit();
      }
      const results = await Promise.all([
        storage.pruneCommitsThrough(PARTITION, { logEpoch, throughSeq: 4 }),
        storage.pruneCommitsThrough(PARTITION, { logEpoch, throughSeq: 2 }),
      ]);
      expect(
        results.reduce((sum, result) => sum + result.removedCommits, 0),
      ).toBe(4);
      expect(
        results.every(
          (result) => result.horizonSeq >= result.previousHorizonSeq,
        ),
      ).toBe(true);
      expect(await storage.getHorizonSeq(PARTITION)).toBe(4);
      await storage.setHorizonSeq(PARTITION, 1);
      expect(await storage.getHorizonSeq(PARTITION)).toBe(4);
      expect(
        await storage.pruneCommitsThrough(PARTITION, {
          logEpoch,
          throughSeq: 2,
        }),
      ).toEqual({ previousHorizonSeq: 4, horizonSeq: 4, removedCommits: 0 });
      await storage.rotatePartitionLogEpoch(
        PARTITION,
        'restored-epoch',
        NOW + 1,
      );
      await expect(
        storage.pruneCommitsThrough(PARTITION, { logEpoch, throughSeq: 5 }),
      ).rejects.toMatchObject({ code: 'sync.storage.prune_epoch_mismatch' });
      expect(await storage.getHorizonSeq(PARTITION)).toBe(4);
      expect(await storage.getPartitionLogEpoch(PARTITION)).toBe(
        'restored-epoch',
      );
      expect(
        await storage.pruneCommitsThrough(PARTITION, {
          logEpoch: 'restored-epoch',
          throughSeq: 5,
        }),
      ).toEqual({ previousHorizonSeq: 4, horizonSeq: 5, removedCommits: 1 });
    });

    test('getCommitSeqBefore returns the newest commit before a timestamp', async () => {
      const storage = await make();
      for (let i = 0; i < 3; i++) {
        const tx = await storage.begin(PARTITION);
        await tx.appendCommit({
          clientId: 'c',
          clientCommitId: `k${i}`,
          actorId: 'a',
          createdAtMs: NOW + i * 100,
          changes: [
            {
              table: 'tasks',
              rowId: `r${i}`,
              op: 'upsert',
              rowVersion: 1,
              scopes: { project_id: 'p1' },
              payload: bytes(i),
            },
          ],
        });
        await tx.commit();
      }
      // Commits at NOW, NOW+100, NOW+200 → seq 1,2,3.
      expect(await storage.getCommitSeqBefore(PARTITION, NOW + 150)).toBe(2);
      expect(await storage.getCommitSeqBefore(PARTITION, NOW - 1)).toBe(0);
    });

    // --- Client records (§4.5, §8.1) ---

    test('active cursor floor is partition-bound, includes cutoff equality, and ignores bootstrap cursors', async () => {
      const storage = await make();
      expect(
        await storage.getActiveClientCursorFloor(PARTITION, NOW),
      ).toBeNull();
      const record: ClientRecord = {
        clientId: 'inactive',
        actorId: 'a',
        wireVersion: 4,
        cursor: -99,
        updatedAtMs: NOW - 1,
        catchingUp: [],
      };
      await storage.putClientRecord(PARTITION, record);
      expect(
        await storage.getActiveClientCursorFloor(PARTITION, NOW),
      ).toBeNull();
      await storage.putClientRecord(PARTITION, {
        ...record,
        clientId: 'boundary',
        cursor: 7,
        updatedAtMs: NOW,
      });
      await storage.putClientRecord('other', {
        ...record,
        cursor: -100,
        updatedAtMs: NOW,
      });
      expect(await storage.getActiveClientCursorFloor(PARTITION, NOW)).toBe(7);
      await storage.putClientRecord(PARTITION, {
        ...record,
        clientId: 'bootstrap',
        cursor: -1,
        updatedAtMs: NOW + 1,
      });
      // §4.6: a bootstrapping client (cursor -1) does not hold the floor.
      expect(await storage.getActiveClientCursorFloor(PARTITION, NOW)).toBe(7);
      expect(
        await storage.getActiveClientCursorFloor(PARTITION, NOW + 1),
      ).toBeNull();
    });

    test('a failed round is recorded on the client and reset by the next completed round', async () => {
      const storage = await make();
      const record: ClientRecord = {
        clientId: 'c1',
        actorId: 'a1',
        wireVersion: 4,
        cursor: 42,
        updatedAtMs: NOW,
        catchingUp: [],
      };
      await storage.putClientRecord(PARTITION, record);
      await storage.recordClientRoundFailure(
        PARTITION,
        'c1',
        'a1',
        'sync.schema_not_ready',
        NOW + 10,
      );
      await storage.recordClientRoundFailure(
        PARTITION,
        'c1',
        'a1',
        'sync.internal_error',
        NOW + 20,
      );
      expect(await storage.getClientRecord(PARTITION, 'c1')).toEqual({
        ...record,
        lastRoundAtMs: NOW + 20,
        lastErrorCode: 'sync.internal_error',
        consecutiveFailures: 2,
      });
      expect((await storage.listClientRecords?.(PARTITION))?.[0]).toEqual({
        ...record,
        lastRoundAtMs: NOW + 20,
        lastErrorCode: 'sync.internal_error',
        consecutiveFailures: 2,
      });
      // The liveness signal that pruning reads is not a round outcome.
      expect(await storage.listClientCursors(PARTITION)).toEqual([
        { clientId: 'c1', cursor: 42, updatedAtMs: NOW },
      ]);

      // Another actor, another partition and a missing client change nothing.
      await storage.recordClientRoundFailure(PARTITION, 'c1', 'other', 'x', 1);
      await storage.recordClientRoundFailure('other', 'c1', 'a1', 'x', 1);
      await storage.recordClientRoundFailure(PARTITION, 'ghost', 'a1', 'x', 1);
      expect(
        (await storage.getClientRecord(PARTITION, 'c1'))?.consecutiveFailures,
      ).toBe(2);
      expect(await storage.getClientRecord(PARTITION, 'ghost')).toBeUndefined();

      // A completed round that carried a ROUND_FAILURE report (§1.5) keeps the
      // reported code and streak; the round time moves to this completion.
      await storage.putClientRecord(
        PARTITION,
        { ...record, cursor: 43, updatedAtMs: NOW + 25 },
        { keepRoundOutcome: true },
      );
      expect(await storage.getClientRecord(PARTITION, 'c1')).toEqual({
        ...record,
        cursor: 43,
        updatedAtMs: NOW + 25,
        lastRoundAtMs: NOW + 25,
        lastErrorCode: 'sync.internal_error',
        consecutiveFailures: 2,
      });

      await storage.putClientRecord(PARTITION, {
        ...record,
        updatedAtMs: NOW + 30,
      });
      expect(await storage.getClientRecord(PARTITION, 'c1')).toEqual({
        ...record,
        updatedAtMs: NOW + 30,
        lastRoundAtMs: NOW + 30,
      });
    });

    test('client record + cursors round-trip; a list is written only when it travels', async () => {
      const storage = await make();
      const units = [{ project_id: 'p1' }, { project_id: 'p2' }];
      const record: ClientRecord = {
        clientId: 'c1',
        actorId: 'a1',
        wireVersion: 4,
        cursor: 42,
        updatedAtMs: NOW,
        schemaVersion: 1,
        registration: { units, digest: registrationDigest(units) },
        catchingUp: [{ id: unitId({ project_id: 'p2' }), cursor: 40 }],
      };
      await storage.putClientRecord(PARTITION, record);
      const got = await storage.getClientRecord(PARTITION, 'c1');
      expect(got).toEqual({ ...record, lastRoundAtMs: NOW });
      const cursors = await storage.listClientCursors(PARTITION);
      expect(cursors).toEqual([
        { clientId: 'c1', cursor: 42, updatedAtMs: NOW },
      ]);
      // A round whose list did not travel keeps the stored list and digest
      // and replaces the catching-up units, cursor and schema version.
      const { registration: _kept, ...referenced } = record;
      await storage.putClientRecord(PARTITION, {
        ...referenced,
        cursor: 99,
        schemaVersion: 2,
        catchingUp: [],
      });
      expect(await storage.getClientRecord(PARTITION, 'c1')).toEqual({
        ...record,
        cursor: 99,
        schemaVersion: 2,
        catchingUp: [],
        lastRoundAtMs: NOW,
      });
      // A traveling empty list replaces the stored one.
      const empty = { units: [], digest: registrationDigest([]) };
      await storage.putClientRecord(PARTITION, {
        ...record,
        registration: empty,
      });
      expect(
        (await storage.getClientRecord(PARTITION, 'c1'))?.registration,
      ).toEqual(empty);
      // A record created without a list holds none.
      await storage.putClientRecord(PARTITION, {
        ...referenced,
        clientId: 'c2',
      });
      expect(
        (await storage.getClientRecord(PARTITION, 'c2'))?.registration,
      ).toBeUndefined();
    });

    test('cursor acknowledgements advance atomically and preserve registration fields', async () => {
      const storage = await make();
      await storage.touchPartition(PARTITION, NOW, 'epoch-a');
      const units = [{ project_id: 'p2' }];
      const record: ClientRecord = {
        clientId: 'c1',
        actorId: 'a1',
        wireVersion: 4,
        cursor: -1,
        updatedAtMs: NOW,
        schemaVersion: 1,
        registration: { units, digest: registrationDigest(units) },
        catchingUp: [],
      };
      await storage.putClientRecord(PARTITION, record);
      await storage.putClientRecord('other', record);
      await storage.advanceClientCursor(
        PARTITION,
        'c1',
        'a1',
        'epoch-a',
        42,
        NOW + 2,
      );
      await storage.advanceClientCursor(
        PARTITION,
        'c1',
        'a1',
        'epoch-a',
        7,
        NOW + 1,
      );
      expect(await storage.getClientRecord(PARTITION, 'c1')).toEqual({
        ...record,
        lastRoundAtMs: record.updatedAtMs,
        cursor: 42,
        updatedAtMs: NOW + 2,
      });
      expect(await storage.getClientRecord('other', 'c1')).toEqual({
        ...record,
        lastRoundAtMs: record.updatedAtMs,
      });
      await storage.advanceClientCursor(
        PARTITION,
        'c1',
        'a1',
        'epoch-a',
        41,
        NOW + 3,
      );
      expect(await storage.getClientRecord(PARTITION, 'c1')).toEqual({
        ...record,
        lastRoundAtMs: record.updatedAtMs,
        cursor: 42,
        updatedAtMs: NOW + 3,
      });
    });

    test('an acknowledgement is capped at the lowest cursor of a catching-up unit', async () => {
      const storage = await make();
      await storage.touchPartition(PARTITION, NOW, 'epoch-a');
      const record: ClientRecord = {
        clientId: 'c1',
        actorId: 'a1',
        wireVersion: 4,
        cursor: 10,
        updatedAtMs: NOW,
        catchingUp: [
          { id: 'bootstrapping', cursor: -1 },
          { id: 'post-bootstrap', cursor: 15 },
          { id: 'pinned', cursor: 20 },
        ],
      };
      await storage.putClientRecord(PARTITION, record);
      const ack = (cursor: number, atMs: number) =>
        storage.advanceClientCursor(
          PARTITION,
          'c1',
          'a1',
          'epoch-a',
          cursor,
          atMs,
        );
      // §8.2: a unit without a cursor (-1) holds nothing; 15 caps the ack.
      await ack(30, NOW + 1);
      expect(await storage.getClientRecord(PARTITION, 'c1')).toMatchObject({
        cursor: 15,
        updatedAtMs: NOW + 1,
      });
      // Without a catching-up cursor the ack applies in full.
      await storage.putClientRecord(PARTITION, { ...record, catchingUp: [] });
      await ack(30, NOW + 2);
      expect((await storage.getClientRecord(PARTITION, 'c1'))?.cursor).toBe(30);
      // A record below the cap rises to it, never past it, never down.
      await storage.putClientRecord(PARTITION, {
        ...record,
        cursor: 18,
        catchingUp: [{ id: 'pinned', cursor: 12 }],
      });
      await ack(30, NOW + 3);
      expect((await storage.getClientRecord(PARTITION, 'c1'))?.cursor).toBe(18);
    });

    test('cursor acknowledgements require the registered actor and current epoch', async () => {
      const storage = await make();
      await storage.touchPartition(PARTITION, NOW, 'epoch-a');
      const record: ClientRecord = {
        clientId: 'c1',
        actorId: 'a1',
        wireVersion: 4,
        cursor: 0,
        updatedAtMs: NOW,
        catchingUp: [],
      };
      await storage.putClientRecord(PARTITION, record);
      await storage.advanceClientCursor(
        PARTITION,
        'c1',
        'wrong-actor',
        'epoch-a',
        42,
        NOW + 1,
      );
      await storage.advanceClientCursor(
        PARTITION,
        'c1',
        'a1',
        'wrong-epoch',
        42,
        NOW + 1,
      );
      await storage.advanceClientCursor(
        PARTITION,
        'missing',
        'a1',
        'epoch-a',
        42,
        NOW + 1,
      );
      expect(await storage.getClientRecord(PARTITION, 'c1')).toEqual({
        ...record,
        lastRoundAtMs: record.updatedAtMs,
      });
      expect(
        await storage.getClientRecord(PARTITION, 'missing'),
      ).toBeUndefined();
      await storage.rotatePartitionLogEpoch(PARTITION, 'epoch-b', NOW + 2);
      await storage.advanceClientCursor(
        PARTITION,
        'c1',
        'a1',
        'epoch-a',
        42,
        NOW + 3,
      );
      expect(await storage.getClientRecord(PARTITION, 'c1')).toBeUndefined();
      await storage.putClientRecord(PARTITION, record);
      await storage.advanceClientCursor(
        PARTITION,
        'c1',
        'a1',
        'epoch-a',
        42,
        NOW + 4,
      );
      expect(await storage.getClientRecord(PARTITION, 'c1')).toEqual({
        ...record,
        lastRoundAtMs: record.updatedAtMs,
      });
      await storage.advanceClientCursor(
        PARTITION,
        'c1',
        'a1',
        'epoch-b',
        1,
        NOW + 5,
      );
      expect(await storage.getClientRecord(PARTITION, 'c1')).toEqual({
        ...record,
        lastRoundAtMs: record.updatedAtMs,
        cursor: 1,
        updatedAtMs: NOW + 5,
      });
    });

    test('a traveling list can lower the record cursor after an ACK', async () => {
      const storage = await make();
      await storage.touchPartition(PARTITION, NOW, 'epoch-a');
      const original: ClientRecord = {
        clientId: 'changed-units',
        actorId: 'actor-1',
        wireVersion: 4,
        cursor: 10,
        updatedAtMs: NOW,
        registration: {
          units: [{ project_id: 'p1' }],
          digest: registrationDigest([{ project_id: 'p1' }]),
        },
        catchingUp: [],
      };
      await storage.putClientRecord(PARTITION, original);
      await storage.advanceClientCursor(
        PARTITION,
        original.clientId,
        original.actorId,
        'epoch-a',
        20,
        NOW + 1,
      );
      const replacement: ClientRecord = {
        ...original,
        cursor: 2,
        updatedAtMs: NOW + 2,
        registration: {
          units: [{ project_id: 'p2' }],
          digest: registrationDigest([{ project_id: 'p2' }]),
        },
        catchingUp: [{ id: unitId({ project_id: 'p2' }), cursor: 2 }],
      };
      await storage.putClientRecord(PARTITION, replacement);
      expect(
        await storage.getClientRecord(PARTITION, original.clientId),
      ).toEqual({ ...replacement, lastRoundAtMs: replacement.updatedAtMs });
    });

    // --- Blob reference index (§5.9.4, optional methods) ---

    test('setBlobRefs / listRowsReferencingBlob / listReferencedBlobIds round-trip', async () => {
      const storage = await make();
      if (
        storage.listRowsReferencingBlob === undefined ||
        storage.listReferencedBlobIds === undefined
      ) {
        // A backend may legitimately omit blob support; skip cleanly.
        return;
      }
      // Two rows in different scopes reference a shared blob; a third
      // references a distinct blob.
      const tx = await storage.begin(PARTITION);
      if (tx.setBlobRefs === undefined) {
        await tx.rollback();
        return;
      }
      await tx.upsertRow('docs', docRow('d1', 'p1'));
      await tx.upsertRow('docs', docRow('d2', 'p2'));
      await tx.upsertRow('docs', docRow('d3', 'p1'));
      await tx.setBlobRefs('docs', 'd1', ['sha256:aa', 'sha256:bb']);
      await tx.setBlobRefs('docs', 'd2', ['sha256:aa']);
      await tx.setBlobRefs('docs', 'd3', ['sha256:cc']);
      await tx.commit();

      // listRowsReferencingBlob carries each row's stored scopes (§3.4).
      const forAa = await storage.listRowsReferencingBlob(
        PARTITION,
        'sha256:aa',
      );
      expect(forAa.map((r) => `${r.table}/${r.rowId}`).sort()).toEqual([
        'docs/d1',
        'docs/d2',
      ]);
      const d2Ref = forAa.find((r) => r.rowId === 'd2');
      expect(d2Ref?.scopes).toEqual({ project_id: 'p2' });

      // The orphan-sweep keep-set is every referenced blobId (distinct).
      expect((await storage.listReferencedBlobIds(PARTITION)).sort()).toEqual([
        'sha256:aa',
        'sha256:bb',
        'sha256:cc',
      ]);
    });

    test('setBlobRefs replaces the prior set for a row', async () => {
      const storage = await make();
      if (
        storage.listRowsReferencingBlob === undefined ||
        storage.listReferencedBlobIds === undefined
      ) {
        return;
      }
      const tx = await storage.begin(PARTITION);
      if (tx.setBlobRefs === undefined) {
        await tx.rollback();
        return;
      }
      await tx.upsertRow('docs', docRow('d1', 'p1'));
      await tx.setBlobRefs('docs', 'd1', ['sha256:aa', 'sha256:bb']);
      await tx.commit();

      const replace = await storage.begin(PARTITION);
      await replace.setBlobRefs?.('docs', 'd1', ['sha256:cc']);
      await replace.commit();

      expect(
        await storage.listRowsReferencingBlob!(PARTITION, 'sha256:aa'),
      ).toEqual([]);
      expect(
        (await storage.listRowsReferencingBlob!(PARTITION, 'sha256:cc')).map(
          (r) => r.rowId,
        ),
      ).toEqual(['d1']);
      expect(await storage.listReferencedBlobIds!(PARTITION)).toEqual([
        'sha256:cc',
      ]);
    });

    test('setBlobRefs with empty array clears a row; deleting a row drops its refs', async () => {
      const storage = await make();
      if (
        storage.listRowsReferencingBlob === undefined ||
        storage.listReferencedBlobIds === undefined
      ) {
        return;
      }
      const tx = await storage.begin(PARTITION);
      if (tx.setBlobRefs === undefined) {
        await tx.rollback();
        return;
      }
      await tx.upsertRow('docs', docRow('d1', 'p1'));
      await tx.upsertRow('docs', docRow('d2', 'p1'));
      await tx.setBlobRefs('docs', 'd1', ['sha256:aa']);
      await tx.setBlobRefs('docs', 'd2', ['sha256:bb']);
      await tx.commit();

      // Clearing via empty set.
      const clear = await storage.begin(PARTITION);
      await clear.setBlobRefs?.('docs', 'd1', []);
      await clear.commit();
      expect(
        await storage.listRowsReferencingBlob!(PARTITION, 'sha256:aa'),
      ).toEqual([]);

      // Deleting the row drops its refs (§5.9.4).
      const del = await storage.begin(PARTITION);
      await del.deleteRow('docs', 'd2');
      await del.commit();
      expect(
        await storage.listRowsReferencingBlob!(PARTITION, 'sha256:bb'),
      ).toEqual([]);
      expect(await storage.listReferencedBlobIds!(PARTITION)).toEqual([]);
    });

    // --- Admin/console read surface (optional methods) ---

    test('listClientRecords / listCommitMetadata / scopeActivity / getCommit / listRowChanges', async () => {
      const storage = await make();
      if (
        storage.listClientRecords === undefined ||
        storage.listCommitMetadata === undefined ||
        storage.scopeActivity === undefined ||
        storage.getCommit === undefined ||
        storage.listRowChanges === undefined
      ) {
        // A backend may legitimately omit the admin surface; skip cleanly.
        return;
      }
      // Two commits (p1, then p2), plus a client record and a stored row.
      for (const [i, project] of ['p1', 'p2'].entries()) {
        const tx = await storage.begin(PARTITION);
        await tx.appendCommit({
          clientId: 'c1',
          clientCommitId: `k${i}`,
          actorId: 'a1',
          createdAtMs: NOW + i,
          changes: [
            {
              table: 'tasks',
              rowId: `r${i}`,
              op: 'upsert',
              rowVersion: 1,
              scopes: { project_id: project },
              payload: bytes(i),
            },
          ],
        });
        await tx.upsertRow('tasks', taskRow(`r${i}`, project, 1, bytes(i)));
        await tx.commit();
      }
      await storage.putClientRecord(PARTITION, {
        clientId: 'c1',
        actorId: 'a1',
        wireVersion: 4,
        cursor: 2,
        updatedAtMs: NOW,
        catchingUp: [],
      });

      const clients = await storage.listClientRecords(PARTITION);
      expect(clients).toHaveLength(1);
      expect(clients[0]).toMatchObject({ clientId: 'c1', cursor: 2 });

      const commits = await storage.listCommitMetadata(PARTITION, {
        afterSeq: 0,
        limit: 10,
      });
      // Newest first, metadata only, tables derived from the change index.
      expect(commits.map((c) => c.commitSeq)).toEqual([2, 1]);
      expect(commits[0]).toMatchObject({
        clientId: 'c1',
        changeCount: 1,
        tables: ['tasks'],
      });

      const filtered = await storage.listCommitMetadata(PARTITION, {
        afterSeq: 0,
        limit: 10,
        table: 'docs',
      });
      expect(filtered).toHaveLength(0);

      const activity = await storage.scopeActivity(PARTITION, {
        variable: 'project_id',
        value: 'p1',
        limit: 10,
      });
      expect(activity.map((a) => a.commitSeq)).toEqual([1]);
      expect(activity[0]).toMatchObject({ table: 'tasks', changeCount: 1 });

      // `beforeSeq` pages the log older, exclusive on both ends; the second
      // page must not overlap the first.
      const firstPage = await storage.listCommitMetadata(PARTITION, {
        afterSeq: 0,
        limit: 1,
      });
      expect(firstPage.map((c) => c.commitSeq)).toEqual([2]);
      const secondPage = await storage.listCommitMetadata(PARTITION, {
        afterSeq: 0,
        beforeSeq: firstPage[firstPage.length - 1]?.commitSeq ?? 0,
        limit: 10,
      });
      expect(secondPage.map((c) => c.commitSeq)).toEqual([1]);
      expect(
        secondPage.some((older) =>
          firstPage.some((newer) => newer.commitSeq === older.commitSeq),
        ),
      ).toBe(false);
      // The same bound applies to the table-filtered query.
      expect(
        await storage.listCommitMetadata(PARTITION, {
          afterSeq: 0,
          beforeSeq: 2,
          limit: 10,
          table: 'tasks',
        }),
      ).toHaveLength(1);

      // One commit with three changes across two tables, including a delete.
      const multi = await storage.begin(PARTITION);
      const multiSeq = await multi.appendCommit({
        clientId: 'c2',
        clientCommitId: 'k-multi',
        actorId: 'a2',
        createdAtMs: NOW + 10,
        changes: [
          {
            table: 'tasks',
            rowId: 'r0',
            op: 'upsert',
            rowVersion: 2,
            scopes: { project_id: 'p1' },
            payload: bytes(9),
          },
          {
            table: 'docs',
            rowId: 'd1',
            op: 'upsert',
            rowVersion: 1,
            scopes: { project_id: 'p1' },
            payload: bytes(7),
          },
          {
            table: 'tasks',
            rowId: 'r1',
            op: 'delete',
            rowVersion: 2,
            scopes: { project_id: 'p2' },
          },
        ],
      });
      await multi.commit();

      const detail = await storage.getCommit(PARTITION, multiSeq);
      expect(detail).toMatchObject({
        commitSeq: multiSeq,
        clientId: 'c2',
        clientCommitId: 'k-multi',
        actorId: 'a2',
        createdAtMs: NOW + 10,
        changeCount: 3,
        tables: ['docs', 'tasks'],
      });
      // Changes stay in change-index (`idx`) order, payloads and scopes decoded.
      expect(detail?.changes.map((c) => [c.table, c.rowId, c.op])).toEqual([
        ['tasks', 'r0', 'upsert'],
        ['docs', 'd1', 'upsert'],
        ['tasks', 'r1', 'delete'],
      ]);
      expect(detail?.changes[0]).toMatchObject({
        rowVersion: 2,
        scopes: { project_id: 'p1' },
      });
      expect(detail?.changes[0]?.payload).toEqual(bytes(9));
      expect(detail?.changes[1]).toMatchObject({
        rowVersion: 1,
        scopes: { project_id: 'p1' },
      });
      expect(detail?.changes[1]?.payload).toEqual(bytes(7));
      // §2.2: a delete carries its version.
      expect(detail?.changes[2]).toMatchObject({
        scopes: { project_id: 'p2' },
        rowVersion: 2,
      });
      expect(await storage.getCommit(PARTITION, multiSeq + 1)).toBeUndefined();

      // Row history: newest first, bounded by `limit`, one row only.
      const history = await storage.listRowChanges(PARTITION, {
        table: 'tasks',
        rowId: 'r0',
        limit: 10,
      });
      expect(history.map((h) => h.commitSeq)).toEqual([multiSeq, 1]);
      expect(history[0]).toMatchObject({
        op: 'upsert',
        rowVersion: 2,
        actorId: 'a2',
        clientId: 'c2',
        createdAtMs: NOW + 10,
      });
      expect(history[1]).toMatchObject({
        op: 'upsert',
        rowVersion: 1,
        actorId: 'a1',
        clientId: 'c1',
        createdAtMs: NOW,
      });
      expect(
        (
          await storage.listRowChanges(PARTITION, {
            table: 'tasks',
            rowId: 'r0',
            limit: 1,
          })
        ).map((h) => h.commitSeq),
      ).toEqual([multiSeq]);

      const deleted = await storage.listRowChanges(PARTITION, {
        table: 'tasks',
        rowId: 'r1',
        limit: 10,
      });
      // The earlier loop upserted r1 in commit 2; the delete is newest.
      expect(deleted.map((h) => h.commitSeq)).toEqual([multiSeq, 2]);
      expect(deleted[0]).toMatchObject({
        commitSeq: multiSeq,
        op: 'delete',
        rowVersion: 2,
      });
      expect(deleted[1]).toMatchObject({
        commitSeq: 2,
        op: 'upsert',
        rowVersion: 1,
      });
      // Other rows and other tables contribute nothing.
      expect(
        await storage.listRowChanges(PARTITION, {
          table: 'docs',
          rowId: 'r0',
          limit: 10,
        }),
      ).toEqual([]);
      expect(
        await storage.listRowChanges(PARTITION, {
          table: 'tasks',
          rowId: 'missing',
          limit: 10,
        }),
      ).toEqual([]);
    });

    test('changeSample / listRows / countRows / listPushResults', async () => {
      const storage = await make();
      if (
        storage.listCommitMetadata === undefined ||
        storage.listRows === undefined ||
        storage.countRows === undefined ||
        storage.listPushResults === undefined
      ) {
        // A backend may legitimately omit the admin surface; skip cleanly.
        return;
      }
      // One commit whose three changes interleave two tables and end in a
      // delete, so a sample ordered by anything but `idx` is visibly wrong.
      const tx = await storage.begin(PARTITION);
      const multiSeq = await tx.appendCommit({
        clientId: 'c1',
        clientCommitId: 'k-multi',
        actorId: 'a1',
        createdAtMs: NOW,
        changes: [
          {
            table: 'tasks',
            rowId: 'r0',
            op: 'upsert',
            rowVersion: 1,
            scopes: { project_id: 'p1' },
            payload: bytes(0),
          },
          {
            table: 'docs',
            rowId: 'd1',
            op: 'upsert',
            rowVersion: 1,
            scopes: { project_id: 'p1' },
            payload: bytes(1),
          },
          {
            table: 'tasks',
            rowId: 'r1',
            op: 'delete',
            rowVersion: 2,
            scopes: { project_id: 'p1' },
          },
        ],
      });
      await tx.commit();

      // Without `changeSample` the metadata carries no sample key at all.
      const plain = await storage.listCommitMetadata(PARTITION, {
        afterSeq: 0,
        limit: 10,
      });
      expect(plain.map((c) => c.commitSeq)).toEqual([multiSeq]);
      expect(Object.keys(plain[0] ?? {})).not.toContain('sample');

      // With it, the first N changes in `idx` order, per commit.
      const sampled = await storage.listCommitMetadata(PARTITION, {
        afterSeq: 0,
        limit: 10,
        changeSample: 2,
      });
      expect(sampled[0]).toMatchObject({
        commitSeq: multiSeq,
        changeCount: 3,
        sample: [
          { table: 'tasks', rowId: 'r0', op: 'upsert' },
          { table: 'docs', rowId: 'd1', op: 'upsert' },
        ],
      });
      // A sample wider than the commit returns every change, deletes included.
      const full = await storage.listCommitMetadata(PARTITION, {
        afterSeq: 0,
        limit: 10,
        changeSample: 10,
      });
      expect(full[0]?.sample).toEqual([
        { table: 'tasks', rowId: 'r0', op: 'upsert' },
        { table: 'docs', rowId: 'd1', op: 'upsert' },
        { table: 'tasks', rowId: 'r1', op: 'delete' },
      ]);

      // Rows: paging is rowId-ordered and exclusive on `afterRowId`.
      const rowsTx = await storage.begin(PARTITION);
      await rowsTx.upsertRow('tasks', taskRow('r3', 'p1', 3, bytes(3)));
      await rowsTx.upsertRow('tasks', taskRow('r1', 'p1', 1, bytes(1)));
      await rowsTx.upsertRow('tasks', taskRow('r2', 'p2', 2, bytes(2)));
      await rowsTx.commit();

      const firstPage = await storage.listRows(PARTITION, {
        table: 'tasks',
        afterRowId: null,
        limit: 2,
      });
      expect(firstPage.map((row) => row.rowId)).toEqual(['r1', 'r2']);
      expect(firstPage[0]).toMatchObject({
        serverVersion: 1,
        scopes: { project_id: 'p1' },
      });
      expect(firstPage[0]?.payload).toEqual(
        taskRow('r1', 'p1', 1, bytes(1)).payload,
      );
      expect(firstPage[1]).toMatchObject({
        serverVersion: 2,
        scopes: { project_id: 'p2' },
      });

      const secondPage = await storage.listRows(PARTITION, {
        table: 'tasks',
        afterRowId: firstPage[firstPage.length - 1]?.rowId ?? null,
        limit: 2,
      });
      expect(secondPage.map((row) => row.rowId)).toEqual(['r3']);
      expect(
        secondPage.some((row) =>
          firstPage.some((prev) => prev.rowId === row.rowId),
        ),
      ).toBe(false);
      // The page is partition- and table-bound.
      expect(
        await storage.listRows('other', {
          table: 'tasks',
          afterRowId: null,
          limit: 10,
        }),
      ).toEqual([]);
      expect(
        await storage.listRows(PARTITION, {
          table: 'docs',
          afterRowId: null,
          limit: 10,
        }),
      ).toEqual([]);

      expect(await storage.countRows(PARTITION, 'tasks')).toBe(3);
      expect(await storage.countRows(PARTITION, 'docs')).toBe(0);
      expect(await storage.countRows('other', 'tasks')).toBe(0);

      // Push outcomes: every client's stored result for one clientCommitId.
      const applied: StoredPushResult = {
        status: 'applied',
        commitSeq: 1,
        results: [{ opIndex: 0, status: 'applied' }],
      };
      const rejected: StoredPushResult = {
        status: 'rejected',
        results: [
          {
            opIndex: 0,
            status: 'error',
            code: 'app.conflict',
            message: 'rejected by policy',
            retryable: false,
          },
        ],
      };
      const pushTx = await storage.begin(PARTITION);
      // Inserted newest-client-last to prove the client_id ordering.
      await pushTx.putPushResult('c2', 'k-multi', rejected);
      await pushTx.putPushResult('c1', 'k-multi', applied);
      await pushTx.putPushResult('c1', 'k-other', applied);
      await pushTx.commit();

      expect(await storage.listPushResults(PARTITION, 'k-multi')).toEqual([
        { clientId: 'c1', result: applied },
        { clientId: 'c2', result: rejected },
      ]);
      expect(await storage.listPushResults(PARTITION, 'k-other')).toEqual([
        { clientId: 'c1', result: applied },
      ]);
      expect(await storage.listPushResults(PARTITION, 'k-missing')).toEqual([]);
      expect(await storage.listPushResults('other', 'k-multi')).toEqual([]);
    });

    test('authenticated partition registry refreshes, lists, and rotates', async () => {
      const storage = await make();
      expect(await storage.listPartitions()).toEqual([]);
      await storage.touchPartition('part-b', NOW, 'epoch-b');
      await storage.touchPartition('part-a', NOW + 1, 'epoch-a');
      // A touch less than the interval after the stored timestamp reads the
      // row back without writing it.
      expect(
        await storage.touchPartition(
          'part-a',
          NOW + PARTITION_TOUCH_INTERVAL_MS,
          'ignored-racing-epoch',
        ),
      ).toEqual({
        partition: 'part-a',
        logEpoch: 'epoch-a',
        epochRequired: false,
        lastAuthenticatedAtMs: NOW + 1,
      });
      const refreshed = await storage.touchPartition(
        'part-a',
        NOW + 1 + PARTITION_TOUCH_INTERVAL_MS,
        'ignored-racing-epoch',
      );
      expect(refreshed).toEqual({
        partition: 'part-a',
        logEpoch: 'epoch-a',
        epochRequired: false,
        lastAuthenticatedAtMs: NOW + 1 + PARTITION_TOUCH_INTERVAL_MS,
      });
      expect(await storage.listPartitions()).toEqual(['part-a', 'part-b']);
      expect(await storage.listPartitionRegistry()).toEqual([
        refreshed,
        {
          partition: 'part-b',
          logEpoch: 'epoch-b',
          epochRequired: false,
          lastAuthenticatedAtMs: NOW,
        },
      ]);

      await storage.putClientRecord('part-a', {
        clientId: 'c1',
        actorId: 'a1',
        wireVersion: 4,
        cursor: 12,
        updatedAtMs: NOW,
        catchingUp: [],
      });
      expect(
        await storage.rotatePartitionLogEpoch(
          'part-a',
          'epoch-after-restore',
          NOW + 3,
        ),
      ).toEqual({
        partition: 'part-a',
        logEpoch: 'epoch-after-restore',
        epochRequired: true,
        lastAuthenticatedAtMs: NOW + 3,
      });
      expect(await storage.getClientRecord('part-a', 'c1')).toBeUndefined();
    });
  });
}
