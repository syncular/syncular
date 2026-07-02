/**
 * Push apply, conflicts, idempotent replay, and rejection atomicity
 * (SPEC.md §6) plus §3.4 write-path authorization — driven through bytes.
 */
import { describe, expect, test } from 'bun:test';
import { decodeRow } from '@syncular-v2/core';
import { handleSyncRequest } from '@syncular-v2/server';
import {
  del,
  expectSyncError,
  makeContext,
  pushCommit,
  pushResults,
  requestBytes,
  seedTask,
  sync,
  TASK_COLUMNS,
  taskRow,
  upsert,
} from './helpers';

describe('push apply (§6.2)', () => {
  test('insert applies with server_version 1 and a commitSeq', async () => {
    const t = makeContext();
    const message = await sync(t, [
      pushCommit('c1', [upsert('tasks', 't1', taskRow('t1', 'p1'))]),
    ]);
    const results = pushResults(message);
    expect(results).toHaveLength(1);
    expect(results[0]?.status).toBe('applied');
    expect(results[0]?.commitSeq).toBe(1);
    expect(results[0]?.results).toEqual([{ opIndex: 0, status: 'applied' }]);
    const row = await t.storage.getRow('part-1', 'tasks', 't1');
    expect(row?.serverVersion).toBe(1);
    expect(row?.scopes).toEqual({ project_id: 'p1' });
  });

  test('last-write-wins upsert increments server_version', async () => {
    const t = makeContext();
    await seedTask(t, 'c1', 't1', 'p1');
    await sync(t, [
      pushCommit('c2', [upsert('tasks', 't1', taskRow('t1', 'p1', 'v2'))]),
    ]);
    const row = await t.storage.getRow('part-1', 'tasks', 't1');
    expect(row?.serverVersion).toBe(2);
  });

  test('matching baseVersion applies with version + 1', async () => {
    const t = makeContext();
    await seedTask(t, 'c1', 't1', 'p1');
    const message = await sync(t, [
      pushCommit('c2', [upsert('tasks', 't1', taskRow('t1', 'p1', 'v2'), 1)]),
    ]);
    expect(pushResults(message)[0]?.status).toBe('applied');
    const row = await t.storage.getRow('part-1', 'tasks', 't1');
    expect(row?.serverVersion).toBe(2);
  });

  test('mismatched baseVersion rejects with a conflict record', async () => {
    const t = makeContext();
    await seedTask(t, 'c1', 't1', 'p1', 'server-title');
    await sync(t, [
      pushCommit('c2', [upsert('tasks', 't1', taskRow('t1', 'p1', 'newer'))]),
    ]);
    const message = await sync(t, [
      pushCommit('c3', [upsert('tasks', 't1', taskRow('t1', 'p1', 'mine'), 1)]),
    ]);
    const result = pushResults(message)[0];
    expect(result?.status).toBe('rejected');
    expect(result?.commitSeq).toBeUndefined();
    const record = result?.results[0];
    if (record?.status !== 'conflict') throw new Error('expected conflict');
    expect(record.code).toBe('sync.version_conflict');
    expect(record.serverVersion).toBe(2);
    const serverRow = decodeRow(TASK_COLUMNS, record.serverRow);
    expect(serverRow[2]).toBe('newer');
  });

  test('baseVersion 0 against an existing row is a conflict', async () => {
    const t = makeContext();
    await seedTask(t, 'c1', 't1', 'p1');
    const message = await sync(t, [
      pushCommit('c2', [upsert('tasks', 't1', taskRow('t1', 'p1'), 0)]),
    ]);
    const record = pushResults(message)[0]?.results[0];
    expect(record?.status).toBe('conflict');
  });

  test('lost insert race against an unauthorized winner is forbidden, not a conflict (§6.2)', async () => {
    const t = makeContext();
    t.scopes.value = { project_id: ['p1', 'p2'] };
    await seedTask(t, 'c1', 't1', 'p2');
    t.scopes.value = { project_id: ['p1'] };
    const message = await sync(t, [
      pushCommit('c2', [upsert('tasks', 't1', taskRow('t1', 'p1'), 0)]),
    ]);
    const record = pushResults(message)[0]?.results[0];
    if (record?.status !== 'error') throw new Error('expected error record');
    expect(record.code).toBe('sync.forbidden');
  });

  test('baseVersion ≠ 0 against an absent row is sync.row_missing', async () => {
    const t = makeContext();
    const message = await sync(t, [
      pushCommit('c1', [upsert('tasks', 'nope', taskRow('nope', 'p1'), 3)]),
    ]);
    const record = pushResults(message)[0]?.results[0];
    if (record?.status !== 'error') throw new Error('expected error record');
    expect(record.code).toBe('sync.row_missing');
  });

  test('deleting an absent row is applied (idempotent)', async () => {
    const t = makeContext();
    const message = await sync(t, [pushCommit('c1', [del('tasks', 'ghost')])]);
    expect(pushResults(message)[0]?.status).toBe('applied');
  });

  test('delete removes the row and emits a delete change with stored scopes', async () => {
    const t = makeContext();
    const seq = await seedTask(t, 'c1', 't1', 'p1');
    await sync(t, [pushCommit('c2', [del('tasks', 't1')])]);
    expect(await t.storage.getRow('part-1', 'tasks', 't1')).toBeUndefined();
    const commits = await t.storage.readCommitWindow('part-1', {
      table: 'tasks',
      scopeFilter: { project_id: ['p1'] },
      afterSeq: seq,
      throughSeq: seq + 1,
      limitChanges: 10,
    });
    expect(commits).toHaveLength(1);
    expect(commits[0]?.changes[0]?.op).toBe('delete');
    expect(commits[0]?.changes[0]?.scopes).toEqual({ project_id: 'p1' });
  });
});

describe('rejection atomicity (§6.4)', () => {
  test('a rejected commit rolls back every write and reports only the terminating record', async () => {
    const t = makeContext();
    await seedTask(t, 'c1', 't1', 'p1');
    const before = await t.storage.getMaxCommitSeq('part-1');
    const message = await sync(t, [
      pushCommit('c2', [
        upsert('tasks', 't2', taskRow('t2', 'p1')),
        upsert('tasks', 't1', taskRow('t1', 'p1'), 99),
      ]),
    ]);
    const result = pushResults(message)[0];
    expect(result?.status).toBe('rejected');
    expect(result?.results).toHaveLength(1);
    expect(result?.results[0]?.opIndex).toBe(1);
    expect(await t.storage.getRow('part-1', 'tasks', 't2')).toBeUndefined();
    expect(await t.storage.getMaxCommitSeq('part-1')).toBe(before);
  });

  test('a rejected commit does not stop the batch (§6.4)', async () => {
    const t = makeContext();
    await seedTask(t, 'c1', 't1', 'p1');
    const message = await sync(t, [
      pushCommit('c2', [upsert('tasks', 't1', taskRow('t1', 'p1'), 99)]),
      pushCommit('c3', [upsert('tasks', 't3', taskRow('t3', 'p1'))]),
    ]);
    const results = pushResults(message);
    expect(results[0]?.status).toBe('rejected');
    expect(results[1]?.status).toBe('applied');
  });
});

describe('idempotent replay (§2.3, §6.3)', () => {
  test('replaying an applied commit returns cached with the original results', async () => {
    const t = makeContext();
    const seq = await seedTask(t, 'c1', 't1', 'p1');
    const replay = await sync(t, [
      pushCommit('c1', [upsert('tasks', 't1', taskRow('t1', 'p1'))]),
    ]);
    const result = pushResults(replay)[0];
    expect(result?.status).toBe('cached');
    expect(result?.commitSeq).toBe(seq);
    expect(result?.results).toEqual([{ opIndex: 0, status: 'applied' }]);
    const row = await t.storage.getRow('part-1', 'tasks', 't1');
    expect(row?.serverVersion).toBe(1); // no double apply
    expect(await t.storage.getMaxCommitSeq('part-1')).toBe(seq);
  });

  test('replaying a rejected commit returns rejected, not cached', async () => {
    const t = makeContext();
    await seedTask(t, 'c1', 't1', 'p1');
    const rejected = pushCommit('c2', [
      upsert('tasks', 't1', taskRow('t1', 'p1'), 99),
    ]);
    const first = await sync(t, [rejected]);
    expect(pushResults(first)[0]?.status).toBe('rejected');
    const replay = await sync(t, [rejected]);
    const result = pushResults(replay)[0];
    expect(result?.status).toBe('rejected');
    expect(result?.commitSeq).toBeUndefined();
    expect(result?.results[0]?.status).toBe('conflict');
  });

  test('a clientCommitId duplicated within one request applies once (§6.3)', async () => {
    const t = makeContext();
    const commit = pushCommit('dup', [
      upsert('tasks', 't1', taskRow('t1', 'p1')),
    ]);
    const message = await sync(t, [commit, commit]);
    const results = pushResults(message);
    expect(results[0]?.status).toBe('applied');
    expect(results[1]?.status).toBe('cached');
    expect(results[1]?.commitSeq).toBe(results[0]?.commitSeq);
    const row = await t.storage.getRow('part-1', 'tasks', 't1');
    expect(row?.serverVersion).toBe(1);
  });
});

describe('write-path authorization (§3.4)', () => {
  test('inserting into a scope the actor does not hold is forbidden', async () => {
    const t = makeContext();
    const message = await sync(t, [
      pushCommit('c1', [upsert('tasks', 't1', taskRow('t1', 'p9'))]),
    ]);
    const record = pushResults(message)[0]?.results[0];
    if (record?.status !== 'error') throw new Error('expected error record');
    expect(record.code).toBe('sync.forbidden');
  });

  test('updates authorize against the STORED row, never the pushed payload (§3.4 step 2)', async () => {
    const t = makeContext();
    t.scopes.value = { project_id: ['p2'] };
    await seedTask(t, 'c1', 't1', 'p2');
    t.scopes.value = { project_id: ['p1'] };
    // Payload claims project p1 (held); the stored row lives in p2 (not held).
    const message = await sync(t, [
      pushCommit('c2', [upsert('tasks', 't1', taskRow('t1', 'p1'))]),
    ]);
    const record = pushResults(message)[0]?.results[0];
    if (record?.status !== 'error') throw new Error('expected error record');
    expect(record.code).toBe('sync.forbidden');
    const row = await t.storage.getRow('part-1', 'tasks', 't1');
    expect(row?.scopes).toEqual({ project_id: 'p2' });
  });

  test('scope columns are stripped from every update path (§3.4 rule 5)', async () => {
    const t = makeContext();
    t.scopes.value = { project_id: ['p1', 'p2'] };
    await seedTask(t, 'c1', 't1', 'p1');
    // Attempt to re-home the row to p2 via LWW update.
    const lww = await sync(t, [
      pushCommit('c2', [upsert('tasks', 't1', taskRow('t1', 'p2', 'moved'))]),
    ]);
    expect(pushResults(lww)[0]?.status).toBe('applied');
    let row = await t.storage.getRow('part-1', 'tasks', 't1');
    expect(row?.scopes).toEqual({ project_id: 'p1' });
    expect(decodeRow(TASK_COLUMNS, row?.payload ?? new Uint8Array())[1]).toBe(
      'p1',
    );
    // And via the baseVersion path.
    const versioned = await sync(t, [
      pushCommit('c3', [
        upsert('tasks', 't1', taskRow('t1', 'p2', 'again'), 2),
      ]),
    ]);
    expect(pushResults(versioned)[0]?.status).toBe('applied');
    row = await t.storage.getRow('part-1', 'tasks', 't1');
    expect(row?.scopes).toEqual({ project_id: 'p1' });
    expect(decodeRow(TASK_COLUMNS, row?.payload ?? new Uint8Array())[1]).toBe(
      'p1',
    );
  });

  test('an empty scope column value on insert is denied (§3.4 step 2)', async () => {
    const t = makeContext();
    const message = await sync(t, [
      pushCommit('c1', [upsert('tasks', 't1', taskRow('t1', ''))]),
    ]);
    const record = pushResults(message)[0]?.results[0];
    if (record?.status !== 'error') throw new Error('expected error record');
    expect(record.code).toBe('sync.forbidden');
  });

  test('a throwing resolveScopes rejects writes with sync.forbidden (§3.4 step 4)', async () => {
    const t = makeContext();
    t.scopes.error = true;
    const message = await sync(t, [
      pushCommit('c1', [upsert('tasks', 't1', taskRow('t1', 'p1'))]),
    ]);
    const record = pushResults(message)[0]?.results[0];
    if (record?.status !== 'error') throw new Error('expected error record');
    expect(record.code).toBe('sync.forbidden');
  });
});

describe('push request validation (§1.7, §6.1)', () => {
  test('an operation naming an unknown table rejects the commit with sync.unknown_table', async () => {
    const t = makeContext();
    const message = await sync(t, [
      pushCommit('c1', [upsert('nope', 'x', taskRow('x', 'p1'))]),
    ]);
    const result = pushResults(message)[0];
    expect(result?.status).toBe('rejected');
    const record = result?.results[0];
    if (record?.status !== 'error') throw new Error('expected error record');
    expect(record.code).toBe('sync.unknown_table');
  });

  test('a payload that fails row-codec decode rejects with sync.invalid_request', async () => {
    const t = makeContext();
    const message = await sync(t, [
      pushCommit('c1', [upsert('tasks', 't1', new Uint8Array([0xff, 0x01]))]),
    ]);
    const record = pushResults(message)[0]?.results[0];
    if (record?.status !== 'error') throw new Error('expected error record');
    expect(record.code).toBe('sync.invalid_request');
  });

  test('a payload whose primary key mismatches rowId rejects', async () => {
    const t = makeContext();
    const message = await sync(t, [
      pushCommit('c1', [upsert('tasks', 't1', taskRow('OTHER', 'p1'))]),
    ]);
    const record = pushResults(message)[0]?.results[0];
    if (record?.status !== 'error') throw new Error('expected error record');
    expect(record.code).toBe('sync.invalid_request');
  });

  test('exceeding the operation cap fails the whole request (§6.1)', async () => {
    const t = makeContext({ limits: { maxOperationsPerRequest: 2 } });
    const bytes = requestBytes([
      pushCommit('c1', [
        upsert('tasks', 't1', taskRow('t1', 'p1')),
        upsert('tasks', 't2', taskRow('t2', 'p1')),
        upsert('tasks', 't3', taskRow('t3', 'p1')),
      ]),
    ]);
    await expectSyncError(
      handleSyncRequest(bytes, t.ctx),
      'sync.too_many_operations',
    );
    // Whole batch unapplied.
    expect(await t.storage.getRow('part-1', 'tasks', 't1')).toBeUndefined();
  });
});
