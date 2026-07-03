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
import type {
  ClientRecord,
  ServerStorage,
  StoredRow,
} from '@syncular-v2/server';

const PARTITION = 'part-1';
const NOW = 1_750_000_000_000;

function bytes(...values: number[]): Uint8Array {
  return new Uint8Array(values);
}

function row(
  rowId: string,
  scopes: Record<string, string>,
  serverVersion = 1,
  payload = bytes(1, 2, 3),
): StoredRow {
  return { rowId, serverVersion, scopes, payload };
}

export function runStorageContract(
  name: string,
  makeStorage: () => ServerStorage | Promise<ServerStorage>,
): void {
  describe(`ServerStorage contract (${name})`, () => {
    test('appendCommit allocates a dense per-partition commitSeq', async () => {
      const storage = await makeStorage();
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

    test('commitSeq is per-partition (independent counters)', async () => {
      const storage = await makeStorage();
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
      const storage = await makeStorage();
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
      const storage = await makeStorage();
      const tx = await storage.begin(PARTITION);
      await tx.upsertRow(
        'tasks',
        row('r1', { project_id: 'p1' }, 2, bytes(9, 8, 7)),
      );
      const inTx = await tx.getRow('tasks', 'r1');
      expect(inTx?.serverVersion).toBe(2);
      expect(inTx?.payload).toEqual(bytes(9, 8, 7));
      expect(inTx?.scopes).toEqual({ project_id: 'p1' });
      await tx.commit();

      const stored = await storage.getRow(PARTITION, 'tasks', 'r1');
      expect(stored?.payload).toEqual(bytes(9, 8, 7));

      const del = await storage.begin(PARTITION);
      await del.deleteRow('tasks', 'r1');
      await del.commit();
      expect(await storage.getRow(PARTITION, 'tasks', 'r1')).toBeUndefined();
    });

    test('idempotency result persists and reads back', async () => {
      const storage = await makeStorage();
      const tx = await storage.begin(PARTITION);
      await tx.putPushResult('c1', 'commit-1', {
        status: 'applied',
        commitSeq: 5,
        results: [{ opIndex: 0, status: 'applied' }],
      });
      await tx.commit();
      const got = await storage.getPushResult(PARTITION, 'c1', 'commit-1');
      expect(got?.status).toBe('applied');
      expect(got?.commitSeq).toBe(5);
      expect(got?.results).toEqual([{ opIndex: 0, status: 'applied' }]);
      expect(
        await storage.getPushResult(PARTITION, 'c1', 'missing'),
      ).toBeUndefined();
    });

    test('conflict push-result bytes round-trip', async () => {
      const storage = await makeStorage();
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
      }
    });

    // --- Inverted scope index (§3.1) — the reason Postgres storage exists ---

    test('readCommitWindow selects by scope, oldest first, honoring limit', async () => {
      const storage = await makeStorage();
      // Three commits: p1, p2, p1 again.
      for (const [i, project] of ['p1', 'p2', 'p1'].entries()) {
        const tx = await storage.begin(PARTITION);
        await tx.appendCommit({
          clientId: 'c',
          clientCommitId: `k${i}`,
          actorId: 'a',
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
        await tx.commit();
      }
      const window = await storage.readCommitWindow(PARTITION, {
        table: 'tasks',
        scopeFilter: { project_id: ['p1'] },
        afterSeq: 0,
        throughSeq: 3,
        limitChanges: 10,
      });
      // Only commits 1 and 3 (p1), oldest first, p2 excluded by the index.
      expect(window.map((c) => c.commitSeq)).toEqual([1, 3]);
      const limited = await storage.readCommitWindow(PARTITION, {
        table: 'tasks',
        scopeFilter: { project_id: ['p1'] },
        afterSeq: 0,
        throughSeq: 3,
        limitChanges: 1,
      });
      expect(limited.map((c) => c.commitSeq)).toEqual([1]);
    });

    test('readCommitWindow verifies the full multi-variable match', async () => {
      const storage = await makeStorage();
      const tx = await storage.begin(PARTITION);
      await tx.appendCommit({
        clientId: 'c',
        clientCommitId: 'k',
        actorId: 'a',
        createdAtMs: NOW,
        changes: [
          {
            table: 'docs',
            rowId: 'd1',
            op: 'upsert',
            rowVersion: 1,
            scopes: { org_id: 'o1', project_id: 'p1' },
            payload: bytes(1),
          },
          {
            table: 'docs',
            rowId: 'd2',
            op: 'upsert',
            rowVersion: 1,
            scopes: { org_id: 'o1', project_id: 'p2' },
            payload: bytes(2),
          },
        ],
      });
      await tx.commit();
      // org_id matches both, but project_id narrows to d1 only.
      const window = await storage.readCommitWindow(PARTITION, {
        table: 'docs',
        scopeFilter: { org_id: ['o1'], project_id: ['p1'] },
        afterSeq: 0,
        throughSeq: 1,
        limitChanges: 10,
      });
      expect(window.length).toBe(1);
      expect(window[0]?.changes.map((c) => c.rowId)).toEqual(['d1']);
    });

    test('scanRows selects by scope ordered by rowId, resumable', async () => {
      const storage = await makeStorage();
      const tx = await storage.begin(PARTITION);
      await tx.upsertRow('tasks', row('r3', { project_id: 'p1' }, 1, bytes(3)));
      await tx.upsertRow('tasks', row('r1', { project_id: 'p1' }, 1, bytes(1)));
      await tx.upsertRow('tasks', row('r2', { project_id: 'p2' }, 1, bytes(2)));
      await tx.upsertRow('tasks', row('r4', { project_id: 'p1' }, 1, bytes(4)));
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

    test('deleting a row removes it from the scope scan', async () => {
      const storage = await makeStorage();
      const tx = await storage.begin(PARTITION);
      await tx.upsertRow('tasks', row('r1', { project_id: 'p1' }));
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
      const storage = await makeStorage();
      const tx = await storage.begin(PARTITION);
      await tx.upsertRow('tasks', row('r1', { project_id: 'p1' }));
      await tx.commit();
      const move = await storage.begin(PARTITION);
      await move.upsertRow('tasks', row('r1', { project_id: 'p2' }, 2));
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

    // --- Horizon / pruning (§4.6) ---

    test('horizon set/get and pruneCommitsThrough', async () => {
      const storage = await makeStorage();
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
      const removed = await storage.pruneCommitsThrough(PARTITION, 2);
      expect(removed).toBe(2);
      // Pruned commits vanish from the window; retained ones remain.
      const window = await storage.readCommitWindow(PARTITION, {
        table: 'tasks',
        scopeFilter: { project_id: ['p1'] },
        afterSeq: 0,
        throughSeq: 5,
        limitChanges: 100,
      });
      expect(window.map((c) => c.commitSeq)).toEqual([3, 4, 5]);
    });

    test('getCommitSeqBefore returns the newest commit before a timestamp', async () => {
      const storage = await makeStorage();
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

    test('client record + cursors round-trip', async () => {
      const storage = await makeStorage();
      const record: ClientRecord = {
        clientId: 'c1',
        actorId: 'a1',
        cursor: 42,
        updatedAtMs: NOW,
        subscriptions: [
          { id: 's1', table: 'tasks', scopes: { project_id: ['p1'] } },
        ],
      };
      await storage.putClientRecord(PARTITION, record);
      const got = await storage.getClientRecord(PARTITION, 'c1');
      expect(got).toEqual(record);
      const cursors = await storage.listClientCursors(PARTITION);
      expect(cursors).toEqual([
        { clientId: 'c1', cursor: 42, updatedAtMs: NOW },
      ]);
      // Update in place.
      await storage.putClientRecord(PARTITION, { ...record, cursor: 99 });
      const updated = await storage.getClientRecord(PARTITION, 'c1');
      expect(updated?.cursor).toBe(99);
    });

    // --- Admin/console read surface (TODO §2.5, optional methods) ---

    test('listClientRecords / listCommitMetadata / scopeActivity / getRowScopes', async () => {
      const storage = await makeStorage();
      if (
        storage.listClientRecords === undefined ||
        storage.listCommitMetadata === undefined ||
        storage.scopeActivity === undefined ||
        storage.getRowScopes === undefined
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
        await tx.upsertRow(
          'tasks',
          row(`r${i}`, { project_id: project }, 1, bytes(i)),
        );
        await tx.commit();
      }
      await storage.putClientRecord(PARTITION, {
        clientId: 'c1',
        actorId: 'a1',
        cursor: 2,
        updatedAtMs: NOW,
        subscriptions: [
          { id: 's1', table: 'tasks', scopes: { project_id: ['p1'] } },
        ],
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

      const rowScopes = await storage.getRowScopes(PARTITION, 'tasks', 'r0');
      expect(rowScopes).toEqual({
        serverVersion: 1,
        scopes: { project_id: 'p1' },
      });
      expect(
        await storage.getRowScopes(PARTITION, 'tasks', 'missing'),
      ).toBeUndefined();
    });
  });
}
