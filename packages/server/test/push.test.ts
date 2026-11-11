/**
 * Push apply, conflicts, idempotent replay, and rejection atomicity
 * (SPEC.md §6) plus §3.4 write-path authorization — driven through bytes.
 */
import { describe, expect, test } from 'bun:test';
import { decodeRow, serializeBlobRef } from '@syncular/core';
import {
  type BlobStore,
  CommitValidationRejection,
  compileSchema,
  handleSyncRequest,
  MemoryBlobStore,
  ValidationRejection,
} from '@syncular/server';
import {
  del,
  DOC_COLUMNS,
  expectSyncError,
  makeContext,
  overlapDuplicateDeliveries,
  pushCommit,
  pushResults,
  requestBytes,
  seedTask,
  sync,
  TASK_COLUMNS,
  taskRow,
  upsert,
} from './helpers';
import { encodeSparseRow } from '@syncular/core';

describe('push apply (§6.2)', () => {
  test('an independent read scope does not block an explicitly scoped write', async () => {
    const schema = {
      version: 1,
      tables: [
        {
          name: 'docs',
          columns: DOC_COLUMNS,
          primaryKey: 'id',
          scopes: [
            'org:{org_id}',
            { pattern: 'project:{projectId}', column: 'project_id' },
          ],
          writeScopeVariables: ['org_id'],
        },
      ],
    };
    const t = makeContext({ schema });
    t.scopes.value = { org_id: ['o1'], projectId: ['old'] };
    const row = encodeSparseRow(DOC_COLUMNS, 0, ['d1', 'o1', 'new', 'offline']);
    const message = await sync(t, [
      pushCommit('new', [upsert('docs', 'd1', row, 0)]),
    ]);
    expect(pushResults(message)[0]?.status).toBe('applied');
  });

  test('a cached conflict does not disclose a row after its scope is revoked', async () => {
    const t = makeContext();
    await seedTask(t, 'seed', 't1', 'p1', 'private');
    const request = pushCommit('conflict-before-revoke', [
      upsert('tasks', 't1', taskRow('t1', 'p1', 'mine'), 0),
    ]);
    expect(pushResults(await sync(t, [request]))[0]?.results[0]?.status).toBe(
      'conflict',
    );
    t.scopes.value = { project_id: ['p2'] };
    expect(pushResults(await sync(t, [request]))[0]?.results[0]).toMatchObject({
      status: 'error',
      code: 'sync.forbidden',
    });
    t.scopes.value = { project_id: ['p1'] };
    expect(pushResults(await sync(t, [request]))[0]?.results[0]?.status).toBe(
      'conflict',
    );
    t.storage.db
      .query(
        "UPDATE sync_push_results SET result = json_set(result, '$.conflictAuthorization.schemaVersion', 0) WHERE client_commit_id = ?",
      )
      .run('conflict-before-revoke');
    expect(pushResults(await sync(t, [request]))[0]?.results[0]).toMatchObject({
      status: 'error',
      code: 'sync.forbidden',
    });
    t.storage.db
      .query(
        "UPDATE sync_push_results SET result = json_remove(result, '$.conflictAuthorization') WHERE client_commit_id = ?",
      )
      .run('conflict-before-revoke');
    expect(pushResults(await sync(t, [request]))[0]?.results[0]).toMatchObject({
      status: 'error',
      code: 'sync.forbidden',
    });
  });

  test('write variables must be distinct, nonempty, declared variables', () => {
    const table = {
      name: 'docs',
      columns: DOC_COLUMNS,
      primaryKey: 'id',
      scopes: [
        'org:{org_id}',
        { pattern: 'project:{projectId}', column: 'project_id' },
      ],
    };
    for (const writeScopeVariables of [[], ['org_id', 'org_id'], ['missing']]) {
      expect(() =>
        compileSchema({
          version: 1,
          tables: [{ ...table, writeScopeVariables }],
        }),
      ).toThrow('writeScopeVariables');
    }
  });
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

  test('an identical-payload commit still advances the sequence, version, and change log', async () => {
    const t = makeContext();
    const firstSeq = await seedTask(t, 'c1', 't1', 'p1', 'same');
    const first = await t.storage.getRow('part-1', 'tasks', 't1');
    expect(first?.serverVersion).toBe(1);
    // The second commit carries a NEW client commit id and the same content.
    // The server must still apply it: skipping it would freeze the version,
    // defeat column-version conflict tracking, drop the change event, and (for
    // an encrypted column) discard a fresh ciphertext that the row must carry.
    const message = await sync(t, [
      pushCommit('c2', [upsert('tasks', 't1', taskRow('t1', 'p1', 'same'))]),
    ]);
    const result = pushResults(message)[0];
    expect(result?.status).toBe('applied');
    expect(result?.commitSeq).toBe(firstSeq + 1);
    const row = await t.storage.getRow('part-1', 'tasks', 't1');
    expect(row?.serverVersion).toBe(2);
    expect(row?.payload).toEqual(first?.payload);
    const { commits } = await t.storage.readLiveWindow('part-1', {
      units: [
        {
          scopes: { project_id: 'p1' },
          afterSeq: firstSeq,
          tables: new Map([['tasks', { project_id: ['p1'] }]]),
        },
      ],
      throughSeq: firstSeq + 1,
      limitChanges: 10,
    });
    expect(commits).toHaveLength(1);
    expect(commits[0]?.changes[0]?.op).toBe('upsert');
    expect(commits[0]?.changes[0]?.rowVersion).toBe(2);
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
    const { commits } = await t.storage.readLiveWindow('part-1', {
      units: [
        {
          scopes: { project_id: 'p1' },
          afterSeq: seq,
          tables: new Map([['tasks', { project_id: ['p1'] }]]),
        },
      ],
      throughSeq: seq + 1,
      limitChanges: 10,
    });
    expect(commits).toHaveLength(1);
    expect(commits[0]?.changes[0]?.op).toBe('delete');
    expect(commits[0]?.changes[0]?.scopes).toEqual({ project_id: 'p1' });
    // §2.2: the delete advances the version, and its tombstone records it.
    expect(commits[0]?.changes[0]?.rowVersion).toBe(2);
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
    // Move the row to v2 so a baseVersion 1 push is a genuine column
    // conflict (§6.2), not a baseVersion-above-server invalid request.
    await sync(t, [
      pushCommit('c-bump', [upsert('tasks', 't1', taskRow('t1', 'p1', 'v2'))]),
    ]);
    const rejected = pushCommit('c2', [
      upsert('tasks', 't1', taskRow('t1', 'p1'), 1),
    ]);
    const first = await sync(t, [rejected]);
    expect(pushResults(first)[0]?.status).toBe('rejected');
    const replay = await sync(t, [rejected]);
    const result = pushResults(replay)[0];
    expect(result?.status).toBe('rejected');
    expect(result?.commitSeq).toBeUndefined();
    expect(result?.results[0]?.status).toBe('conflict');
  });

  test('a changed-operations replay of an applied ID replays the original result without validating (§2.3)', async () => {
    let validatorCalls = 0;
    const t = makeContext({
      validators: {
        tasks: () => {
          validatorCalls += 1;
        },
      },
    });
    const applied = await sync(t, [
      pushCommit('changed', [
        upsert('tasks', 't1', taskRow('t1', 'p1', 'first')),
      ]),
    ]);
    const first = pushResults(applied)[0];
    expect(first?.status).toBe('applied');
    const seq = first?.commitSeq;
    if (seq === undefined) throw new Error('applied push lacks a commitSeq');
    expect(validatorCalls).toBe(1);

    // Same (partition, clientId, clientCommitId) with different operations:
    // a new row, a changed payload, and a delete of the original row. §2.3
    // keys idempotency on the ID alone, so the persisted result replays and
    // the changed operations never reach `buildOperations`, the validators,
    // or the transaction.
    const beforeReplay = await t.storage.getRow('part-1', 'tasks', 't1');
    const replay = await sync(t, [
      pushCommit('changed', [
        upsert('tasks', 't2', taskRow('t2', 'p1', 'second')),
        del('tasks', 't1'),
      ]),
    ]);
    const result = pushResults(replay)[0];
    expect(result?.status).toBe('cached');
    expect(result?.commitSeq).toBe(seq);
    expect(result?.results).toEqual([{ opIndex: 0, status: 'applied' }]);
    expect(validatorCalls).toBe(1); // not rerun
    const original = await t.storage.getRow('part-1', 'tasks', 't1');
    expect(original?.serverVersion).toBe(1); // original apply survived
    expect(original?.payload).toEqual(beforeReplay?.payload); // bytes unchanged
    expect(await t.storage.getRow('part-1', 'tasks', 't2')).toBeUndefined();
    expect(await t.storage.getMaxCommitSeq('part-1')).toBe(seq);
  });

  test('baseVersion above server_version rejects with sync.invalid_request (§6.2)', async () => {
    const t = makeContext();
    await seedTask(t, 'c1', 't1', 'p1');
    const message = await sync(t, [
      pushCommit('c2', [upsert('tasks', 't1', taskRow('t1', 'p1'), 99)]),
    ]);
    const record = pushResults(message)[0]?.results[0];
    if (record?.status !== 'error') throw new Error('expected error record');
    expect(record.code).toBe('sync.invalid_request');
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

  test('overlapping applied deliveries cross the same locked recheck exactly once', async () => {
    let validatorCalls = 0;
    let notifications = 0;
    const base = makeContext({
      validators: {
        tasks: () => {
          validatorCalls += 1;
        },
      },
      realtime: {
        notifyCommit: () => {
          notifications += 1;
        },
      },
    });
    const storage = overlapDuplicateDeliveries(base.storage);
    const t = { ...base, ctx: { ...base.ctx, storage } };
    const commit = pushCommit('overlap-applied', [
      upsert('tasks', 'overlap-row', taskRow('overlap-row', 'p1')),
    ]);

    const [left, right] = await Promise.all([
      sync(t, [commit]),
      sync(t, [commit]),
    ]);
    const statuses = [
      pushResults(left)[0]?.status,
      pushResults(right)[0]?.status,
    ].sort();
    expect(statuses).toEqual(['applied', 'cached']);
    expect(validatorCalls).toBe(1);
    expect(notifications).toBe(1);
    expect(
      (await base.storage.getRow('part-1', 'tasks', 'overlap-row'))
        ?.serverVersion,
    ).toBe(1);
    expect(await base.storage.getMaxCommitSeq('part-1')).toBe(1);
  });

  test('overlapping conflict deliveries read the row once and replay byte-equivalent evidence', async () => {
    const base = makeContext();
    await seedTask(base, 'conflict-seed', 'conflict-row', 'p1');
    let operationReads = 0;
    const storage = overlapDuplicateDeliveries(base.storage, () => {
      operationReads += 1;
    });
    const t = { ...base, ctx: { ...base.ctx, storage } };
    const commit = pushCommit('overlap-conflict', [
      upsert(
        'tasks',
        'conflict-row',
        taskRow('conflict-row', 'p1', 'stale'),
        99,
      ),
    ]);

    const [left, right] = await Promise.all([
      sync(t, [commit]),
      sync(t, [commit]),
    ]);
    const leftResult = pushResults(left)[0];
    const rightResult = pushResults(right)[0];
    expect(leftResult).toEqual(rightResult);
    expect(leftResult?.status).toBe('rejected');
    expect(operationReads).toBe(1);
    expect(await base.storage.getMaxCommitSeq('part-1')).toBe(1);
  });

  test('overlapping row-validator rejections execute the host callback once', async () => {
    let validatorCalls = 0;
    const base = makeContext({
      validators: {
        tasks: () => {
          validatorCalls += 1;
          throw new ValidationRejection('tasks.rejected');
        },
      },
    });
    const storage = overlapDuplicateDeliveries(base.storage);
    const t = { ...base, ctx: { ...base.ctx, storage } };
    const commit = pushCommit('overlap-row-rejection', [
      upsert('tasks', 'rejected-row', taskRow('rejected-row', 'p1')),
    ]);

    const [left, right] = await Promise.all([
      sync(t, [commit]),
      sync(t, [commit]),
    ]);
    expect(pushResults(left)[0]).toEqual(pushResults(right)[0]);
    expect(validatorCalls).toBe(1);
    expect(
      await base.storage.getRow('part-1', 'tasks', 'rejected-row'),
    ).toBeUndefined();
  });

  test('overlapping whole-commit rejections execute the aggregate callback once', async () => {
    let validatorCalls = 0;
    const base = makeContext({
      commitValidator: () => {
        validatorCalls += 1;
        throw new CommitValidationRejection(0, 'tasks.aggregate_rejected');
      },
    });
    const storage = overlapDuplicateDeliveries(base.storage);
    const t = { ...base, ctx: { ...base.ctx, storage } };
    const commit = pushCommit('overlap-aggregate-rejection', [
      upsert('tasks', 'aggregate-row', taskRow('aggregate-row', 'p1')),
    ]);

    const [left, right] = await Promise.all([
      sync(t, [commit]),
      sync(t, [commit]),
    ]);
    expect(pushResults(left)[0]).toEqual(pushResults(right)[0]);
    expect(validatorCalls).toBe(1);
    expect(
      await base.storage.getRow('part-1', 'tasks', 'aggregate-row'),
    ).toBeUndefined();
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

  test('a present scope column rejects a value change (§3.4 rule 5)', async () => {
    const t = makeContext();
    t.scopes.value = { project_id: ['p1', 'p2'] };
    await seedTask(t, 'c1', 't1', 'p1');
    // Attempt to re-home the row to p2 via LWW update: rejected, never
    // silently stripped (wire version 3).
    const lww = await sync(t, [
      pushCommit('c2', [upsert('tasks', 't1', taskRow('t1', 'p2', 'moved'))]),
    ]);
    const lwwRecord = pushResults(lww)[0]?.results[0];
    if (lwwRecord?.status !== 'error')
      throw new Error('expected an error record');
    expect(lwwRecord.code).toBe('sync.invalid_request');
    let row = await t.storage.getRow('part-1', 'tasks', 't1');
    expect(row?.scopes).toEqual({ project_id: 'p1' });
    expect(decodeRow(TASK_COLUMNS, row?.payload ?? new Uint8Array())[2]).toBe(
      'task',
    );
    // And via the baseVersion path.
    const versioned = await sync(t, [
      pushCommit('c3', [
        upsert('tasks', 't1', taskRow('t1', 'p2', 'again'), 1),
      ]),
    ]);
    const versionedRecord = pushResults(versioned)[0]?.results[0];
    if (versionedRecord?.status !== 'error')
      throw new Error('expected an error record');
    expect(versionedRecord.code).toBe('sync.invalid_request');
    // A present scope column equal to the stored value applies as a no-op.
    const same = await sync(t, [
      pushCommit('c4', [upsert('tasks', 't1', taskRow('t1', 'p1', 'kept'))]),
    ]);
    expect(pushResults(same)[0]?.status).toBe('applied');
    row = await t.storage.getRow('part-1', 'tasks', 't1');
    expect(row?.scopes).toEqual({ project_id: 'p1' });
    expect(decodeRow(TASK_COLUMNS, row?.payload ?? new Uint8Array())[2]).toBe(
      'kept',
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

  test('replaying a conflicted clientCommitId with fewer operations returns cached conflict without throwing', async () => {
    const t = makeContext();
    await seedTask(t, 'seed-1', 't1', 'p1', 'v1');
    await sync(t, [
      pushCommit('seed-2', [upsert('tasks', 't1', taskRow('t1', 'p1', 'v2'))]),
    ]);
    const first = await sync(t, [
      pushCommit('conflict-replay', [
        upsert('tasks', 't2', taskRow('t2', 'p1', 'ok')),
        upsert('tasks', 't1', taskRow('t1', 'p1', 'stale'), 1),
      ]),
    ]);
    expect(pushResults(first)[0]?.status).toBe('rejected');
    expect(pushResults(first)[0]?.results[0]?.status).toBe('conflict');
    expect(pushResults(first)[0]?.results[0]?.opIndex).toBe(1);
    const replay = await sync(t, [
      pushCommit('conflict-replay', [
        upsert('tasks', 't2', taskRow('t2', 'p1', 'ok')),
      ]),
    ]);
    expect(pushResults(replay)[0]?.status).toBe('rejected');
    expect(pushResults(replay)[0]?.results[0]?.status).toBe('conflict');
    expect(pushResults(replay)[0]?.results[0]?.opIndex).toBe(1);
  });
});

describe('conflict snapshot after rollback (§6.4)', () => {
  test('a conflict reports the row as stored before the commit, not an earlier operation of it', async () => {
    const t = makeContext();
    await seedTask(t, 'c1', 't1', 'p1', 'stored');
    const message = await sync(t, [
      pushCommit('c2', [
        upsert('tasks', 't1', taskRow('t1', 'p1', 'candidate')),
        upsert('tasks', 't1', taskRow('t1', 'p1', 'mine'), 1),
      ]),
    ]);
    const record = pushResults(message)[0]?.results[0];
    if (record?.status !== 'conflict') throw new Error('expected conflict');
    expect(record.opIndex).toBe(1);
    expect(record.serverVersion).toBe(1);
    expect(decodeRow(TASK_COLUMNS, record.serverRow)[2]).toBe('stored');
    // The replay returns the persisted rolled-back snapshot (§2.3).
    const replay = await sync(t, [
      pushCommit('c2', [upsert('tasks', 't1', taskRow('t1', 'p1', 'x'))]),
    ]);
    expect(pushResults(replay)[0]?.results[0]).toEqual(record);
  });

  test('a conflict against a row only an earlier operation inserted is sync.row_missing', async () => {
    const t = makeContext();
    const message = await sync(t, [
      pushCommit('c1', [
        upsert('tasks', 't9', taskRow('t9', 'p1', 'first'), 0),
        upsert('tasks', 't9', taskRow('t9', 'p1', 'second'), 0),
      ]),
    ]);
    expect(pushResults(message)[0]?.results).toEqual([
      {
        opIndex: 1,
        status: 'error',
        code: 'sync.row_missing',
        message:
          'the conflicting row exists only through an earlier operation of the same commit (§6.4)',
        retryable: false,
      },
    ]);
    expect(await t.storage.getRow('part-1', 'tasks', 't9')).toBeUndefined();
  });
});

describe('tombstone disclosure (§6.2)', () => {
  test('an unauthorized unversioned upsert is forbidden whether or not the row was deleted', async () => {
    const t = makeContext();
    t.scopes.value = { project_id: ['p1', 'p2'] };
    await seedTask(t, 'c1', 'deleted', 'p2');
    await sync(t, [pushCommit('c2', [del('tasks', 'deleted')])]);
    t.scopes.value = { project_id: ['p1'] };
    const answer = async (rowId: string) => {
      const message = await sync(t, [
        pushCommit(`probe-${rowId}`, [
          upsert('tasks', rowId, taskRow(rowId, 'p2')),
        ]),
      ]);
      const record = pushResults(message)[0]?.results[0];
      if (record?.status !== 'error') throw new Error('expected error record');
      return { code: record.code, message: record.message };
    };
    const deleted = await answer('deleted');
    expect(deleted.code).toBe('sync.forbidden');
    expect(deleted).toEqual(await answer('never-existed'));
  });

  test('an authorized unversioned upsert still loses to the tombstone', async () => {
    const t = makeContext();
    await seedTask(t, 'c1', 't1', 'p1');
    await sync(t, [pushCommit('c2', [del('tasks', 't1')])]);
    const message = await sync(t, [
      pushCommit('c3', [upsert('tasks', 't1', taskRow('t1', 'p1'))]),
    ]);
    const record = pushResults(message)[0]?.results[0];
    if (record?.status !== 'error') throw new Error('expected error record');
    expect(record.code).toBe('sync.row_deleted');
  });

  // A patch that omits its scope columns: only the tombstone's stored scopes
  // can authorize it.
  let patches = 0;
  const patchAnswer = async (
    t: ReturnType<typeof makeContext>,
    rowId: string,
  ) => {
    const payload = encodeSparseRow(TASK_COLUMNS, 0, [
      rowId,
      undefined,
      'patched',
      undefined,
      undefined,
      undefined,
    ]);
    const message = await sync(t, [
      pushCommit(`patch-${++patches}`, [upsert('tasks', rowId, payload)]),
    ]);
    const record = pushResults(message)[0]?.results[0];
    if (record?.status !== 'error') throw new Error('expected error record');
    return { code: record.code, message: record.message };
  };

  test('a partial upsert from an actor outside the tombstone scope sees a row that never existed', async () => {
    const t = makeContext();
    t.scopes.value = { project_id: ['p1', 'p2'] };
    await seedTask(t, 'c1', 'deleted', 'p2');
    await sync(t, [pushCommit('c2', [del('tasks', 'deleted')])]);
    t.scopes.value = { project_id: ['p1'] };
    const deleted = await patchAnswer(t, 'deleted');
    expect(deleted.code).toBe('sync.row_missing');
    expect(deleted).toEqual(await patchAnswer(t, 'never-existed'));
    t.scopes.value = { project_id: ['p2'] };
    expect((await patchAnswer(t, 'deleted')).code).toBe('sync.row_deleted');
  });

  test('a tombstone without stored scopes answers sync.row_deleted to any actor', async () => {
    const t = makeContext();
    t.scopes.value = { project_id: ['p1', 'p2'] };
    await seedTask(t, 'c1', 'deleted', 'p2');
    await sync(t, [pushCommit('c2', [del('tasks', 'deleted')])]);
    t.storage.db.exec(
      'UPDATE sync_tombstones SET server_version = NULL, scopes = NULL',
    );
    t.scopes.value = { project_id: ['p1'] };
    expect((await patchAnswer(t, 'deleted')).code).toBe('sync.row_deleted');
  });
});

describe('versions across deletes and incarnations (§2.2, §6.2)', () => {
  const version = async (t: ReturnType<typeof makeContext>, rowId: string) =>
    (await t.storage.getRow('part-1', 'tasks', rowId))?.serverVersion;

  test('a recreate starts above the delete floor, so a stale baseVersion conflicts', async () => {
    const t = makeContext();
    await seedTask(t, 'c1', 't1', 'p1');
    for (const title of ['v2', 'v3']) {
      await sync(t, [
        pushCommit(title, [upsert('tasks', 't1', taskRow('t1', 'p1', title))]),
      ]);
    }
    // The delete advances 3 to 4; the tombstone and the floor record 4.
    await sync(t, [pushCommit('delete', [del('tasks', 't1')])]);
    expect(
      t.storage.db.query('SELECT server_version FROM sync_tombstones').get(),
    ).toEqual({ server_version: 4 });
    const recreated = await sync(t, [
      pushCommit('recreate', [
        upsert('tasks', 't1', taskRow('t1', 'p1', 'new'), 0),
      ]),
    ]);
    expect(pushResults(recreated)[0]?.status).toBe('applied');
    expect(await version(t, 't1')).toBe(5);
    const stale = await sync(t, [
      pushCommit('stale', [
        upsert('tasks', 't1', taskRow('t1', 'p1', 'stale'), 3),
      ]),
    ]);
    const record = pushResults(stale)[0]?.results[0];
    if (record?.status !== 'conflict') throw new Error('expected conflict');
    expect(record.serverVersion).toBe(5);
    expect(decodeRow(TASK_COLUMNS, record.serverRow)[2]).toBe('new');
  });

  test('an insert starts above a delete earlier in its commit (§2.2)', async () => {
    const t = makeContext();
    await seedTask(t, 'c1', 't1', 'p1');
    // The delete writes t1 at 2, so the insert of t3 starts at 3.
    await sync(t, [
      pushCommit('both', [
        del('tasks', 't1'),
        upsert('tasks', 't3', taskRow('t3', 'p1')),
      ]),
    ]);
    expect(await version(t, 't3')).toBe(3);
  });

  test('every insert starts above the floor; a pruned tombstone leaves the floor', async () => {
    const t = makeContext();
    t.scopes.value = { project_id: ['p1', 'p2'] };
    await seedTask(t, 'c1', 'fresh', 'p1');
    expect(await version(t, 'fresh')).toBe(1);
    await seedTask(t, 'c2', 'gone', 'p2');
    await sync(t, [pushCommit('c3', [del('tasks', 'gone')])]);
    // Another row id, an actor without the tombstone's scope: both start at 3.
    await seedTask(t, 'c4', 'other', 'p1');
    expect(await version(t, 'other')).toBe(3);
    t.scopes.value = { project_id: ['p1'] };
    const inserted = await sync(t, [
      pushCommit('c5', [upsert('tasks', 'gone', taskRow('gone', 'p1'))]),
    ]);
    expect(pushResults(inserted)[0]?.status).toBe('applied');
    expect(await version(t, 'gone')).toBe(3);
    expect(
      t.storage.db.query('SELECT count(*) AS n FROM sync_tombstones').get(),
    ).toEqual({ n: 0 });
    t.scopes.value = { project_id: ['p1', 'p2'] };
    await sync(t, [pushCommit('c6', [del('tasks', 'gone')])]);
    const logEpoch = await t.storage.getPartitionLogEpoch('part-1');
    await t.storage.pruneCommitsThrough('part-1', {
      logEpoch: logEpoch!,
      throughSeq: 6,
    });
    await sync(t, [
      pushCommit('c7', [upsert('tasks', 'gone', taskRow('gone', 'p1'))]),
    ]);
    expect(await version(t, 'gone')).toBe(5);
  });

  test('a delete and a recreate in one commit advance past each other', async () => {
    const t = makeContext();
    await seedTask(t, 'c1', 't1', 'p1');
    const message = await sync(t, [
      pushCommit('c2', [
        del('tasks', 't1'),
        upsert('tasks', 't1', taskRow('t1', 'p1', 'again'), 0),
      ]),
    ]);
    expect(pushResults(message)[0]?.status).toBe('applied');
    expect(await version(t, 't1')).toBe(3);
  });

  test('a tombstone without a stored version still recreates above the floor', async () => {
    const t = makeContext();
    await seedTask(t, 'c1', 't1', 'p1');
    await sync(t, [pushCommit('delete', [del('tasks', 't1')])]);
    t.storage.db.exec(
      'UPDATE sync_tombstones SET server_version = NULL, scopes = NULL',
    );
    await sync(t, [
      pushCommit('recreate', [upsert('tasks', 't1', taskRow('t1', 'p1'), 0)]),
    ]);
    expect(await version(t, 't1')).toBe(3);
  });
});

describe('rowId admission (§6.1)', () => {
  test('a rowId holding U+0000 rejects its operation with sync.invalid_request', async () => {
    const t = makeContext();
    const message = await sync(t, [
      pushCommit('c1', [del('tasks', 'a\u0000b')]),
      pushCommit('c2', [upsert('tasks', 't1', taskRow('t1', 'p1'))]),
    ]);
    const [rejected, applied] = pushResults(message);
    expect(rejected?.status).toBe('rejected');
    expect(rejected?.results[0]).toMatchObject({
      opIndex: 0,
      status: 'error',
      code: 'sync.invalid_request',
      message: 'rowId holds U+0000',
    });
    expect(applied?.status).toBe('applied');
  });
});

describe('blob existence check (§6.6)', () => {
  const BLOB_COLUMNS = [
    { name: 'id', type: 'string', nullable: false },
    { name: 'project_id', type: 'string', nullable: false },
    { name: 'cover', type: 'blob_ref', nullable: true },
    { name: 'thumb', type: 'blob_ref', nullable: true },
  ] as const;
  const BLOB_SCHEMA = {
    version: 1,
    tables: [
      {
        name: 'files',
        columns: BLOB_COLUMNS,
        primaryKey: 'id',
        scopes: ['project:{project_id}'],
      },
    ],
  };
  const ref = (digit: string) =>
    serializeBlobRef({ blobId: `sha256:${digit.repeat(64)}`, byteLength: 1 });

  test('a commit checks each distinct blob once, concurrently', async () => {
    const store = new MemoryBlobStore();
    for (const digit of ['a', 'b']) {
      await store.put(
        'part-1',
        `sha256:${digit.repeat(64)}`,
        new Uint8Array([1]),
        0,
      );
    }
    const lookups: string[] = [];
    let inFlight = 0;
    let maxInFlight = 0;
    const counting: BlobStore = new Proxy(store, {
      get(target, property) {
        if (property === 'has') {
          return async (partition: string, blobId: string) => {
            lookups.push(blobId);
            inFlight += 1;
            maxInFlight = Math.max(maxInFlight, inFlight);
            await Promise.resolve();
            await Promise.resolve();
            inFlight -= 1;
            return target.has(partition, blobId);
          };
        }
        const value = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const t = makeContext({
      schema: BLOB_SCHEMA,
      blobs: counting,
      resolveScopes: () => ({ project_id: ['p1'] }),
    });
    const row = (id: string, cover: string, thumb: string) =>
      upsert(
        'files',
        id,
        encodeSparseRow(BLOB_COLUMNS, 0, [id, 'p1', cover, thumb]),
      );
    const message = await sync(t, [
      pushCommit('c1', [
        row('f1', ref('a'), ref('b')),
        row('f2', ref('a'), ref('a')),
        row('f3', ref('b'), ref('a')),
      ]),
    ]);
    expect(pushResults(message)[0]?.status).toBe('applied');
    expect(lookups.sort()).toEqual([
      `sha256:${'a'.repeat(64)}`,
      `sha256:${'b'.repeat(64)}`,
    ]);
    expect(maxInFlight).toBe(2);
  });

  test('an absent blob still rejects the referencing operation', async () => {
    const t = makeContext({
      schema: BLOB_SCHEMA,
      blobs: new MemoryBlobStore(),
      resolveScopes: () => ({ project_id: ['p1'] }),
    });
    const message = await sync(t, [
      pushCommit('c1', [
        upsert(
          'files',
          'f1',
          encodeSparseRow(BLOB_COLUMNS, 0, ['f1', 'p1', null, ref('c')]),
        ),
      ]),
    ]);
    expect(pushResults(message)[0]?.results[0]).toMatchObject({
      opIndex: 0,
      status: 'error',
      code: 'blob.not_found',
    });
  });
});

describe('per-outbox watermark (§6.3.2)', () => {
  const task = (id: string) => [upsert('tasks', id, taskRow(id, 'p1'))];
  const push = (
    t: ReturnType<typeof makeContext>,
    commits: ReturnType<typeof pushCommit>[],
    outboxId: string | null = 'outbox-1',
  ) => sync(t, commits, outboxId === null ? {} : { outboxId });

  test('the clientSeq rules fail the request before any commit (§6.1)', async () => {
    const t = makeContext();
    const cases: [string | undefined, number[]][] = [
      ['outbox-1', [0]],
      ['outbox-1', [2, 2]],
      ['outbox-1', [3, 1]],
      [undefined, [1]],
    ];
    for (const [outboxId, seqs] of cases) {
      const error = await expectSyncError(
        handleSyncRequest(
          requestBytes(
            seqs.map((seq, i) => pushCommit(`c${i}`, task(`t${i}`), seq)),
            'client-1',
            1,
            undefined,
            outboxId,
          ),
          t.ctx,
        ),
        'sync.invalid_request',
      );
      expect(JSON.parse(error.details ?? '{}')).toEqual({
        outbox: outboxId !== undefined,
        clientSeqs: seqs,
      });
    }
    expect(await t.storage.getRow('part-1', 'tasks', 't0')).toBeUndefined();
  });

  test('a request raises the watermark to its first clientSeq and deletes the results below it', async () => {
    const t = makeContext();
    await push(t, [pushCommit('c1', task('t1'), 1)]);
    await push(t, [pushCommit('c2', task('t2'), 2)]);
    // A lost-ack retry of a commit still in the outbox replays its result.
    expect(
      pushResults(await push(t, [pushCommit('c2', task('t2'), 2)])),
    ).toEqual([expect.objectContaining({ status: 'cached', commitSeq: 2 })]);
    await push(t, [pushCommit('c3', task('t3'), 3)]);
    expect(
      await t.storage.getPushResult('part-1', 'client-1', 'c1'),
    ).toBeUndefined();
    expect(
      await t.storage.getPushResult('part-1', 'client-1', 'c2'),
    ).toBeUndefined();
    expect(
      await t.storage.getPushResult('part-1', 'client-1', 'c3'),
    ).toBeDefined();
    expect(await t.storage.listPushWatermarks?.('part-1', 'c3')).toEqual([
      { clientId: 'client-1', outboxId: 'outbox-1', throughSeq: 3 },
    ]);
  });

  test('a commit below the watermark without a result answers sync.commit_expired, unpersisted', async () => {
    const t = makeContext();
    await push(t, [pushCommit('c1', task('t1'), 1)]);
    await push(t, [pushCommit('c3', task('t3'), 3)]);
    // A delayed copy of an abandoned request: c1 was deleted, c2 never applied.
    const delayed = await push(t, [
      pushCommit('c1', task('t1'), 1),
      pushCommit('c2', task('t2'), 2),
      pushCommit('c4', task('t4'), 4),
    ]);
    const expired = {
      type: 'PUSH_RESULT',
      status: 'rejected',
      results: [
        {
          opIndex: 0,
          status: 'error',
          code: 'sync.commit_expired',
          message: 'the commit lies below its outbox watermark (§6.3.2)',
          retryable: false,
        },
      ],
    };
    expect(pushResults(delayed)).toEqual([
      { ...expired, clientCommitId: 'c1' },
      { ...expired, clientCommitId: 'c2' },
      expect.objectContaining({ clientCommitId: 'c4', status: 'applied' }),
    ] as never);
    expect(await t.storage.getRow('part-1', 'tasks', 't2')).toBeUndefined();
    expect(
      await t.storage.getPushResult('part-1', 'client-1', 'c2'),
    ).toBeUndefined();
    expect(
      (await t.storage.getRow('part-1', 'tasks', 't1'))?.serverVersion,
    ).toBe(1);
    // The lower first sequence did not lower W: c3 keeps its result.
    expect(
      await t.storage.getPushResult('part-1', 'client-1', 'c3'),
    ).toBeDefined();
  });

  test('a first commit that rejects still settles the watermark', async () => {
    const t = makeContext();
    await push(t, [pushCommit('c1', task('t1'), 1)]);
    const rejected = await push(t, [
      pushCommit('c2', [upsert('nope', 'x', taskRow('x', 'p1'))], 2),
    ]);
    expect(pushResults(rejected)[0]?.status).toBe('rejected');
    expect(
      await t.storage.getPushResult('part-1', 'client-1', 'c1'),
    ).toBeUndefined();
    expect(
      pushResults(await push(t, [pushCommit('c1', task('t1'), 1)]))[0],
    ).toMatchObject({
      results: [{ code: 'sync.commit_expired' }],
    });
  });

  test('results without an outbox stay, and a replica settles its pre-upgrade results (§9)', async () => {
    const t = makeContext();
    await push(t, [pushCommit('old-1', task('t1'))], null);
    await push(t, [pushCommit('old-2', task('t2'))], null);
    await push(t, [pushCommit('service', task('t9'))], null);
    expect(
      await t.storage.getPushResult('part-1', 'client-1', 'old-1'),
    ).toBeDefined();
    // The first version 4 request carries the surviving prefix [old-2].
    const upgraded = await push(t, [
      pushCommit('old-2', task('t2'), 5),
      pushCommit('new-1', task('t3'), 6),
    ]);
    expect(pushResults(upgraded).map((r) => r.status)).toEqual([
      'cached',
      'applied',
    ]);
    expect(
      await t.storage.getPushResult('part-1', 'client-1', 'old-1'),
    ).toBeUndefined();
    expect(
      await t.storage.getPushResult('part-1', 'client-1', 'service'),
    ).toBeUndefined();
    await push(t, [pushCommit('new-2', task('t4'), 7)]);
    expect(
      await t.storage.getPushResult('part-1', 'client-1', 'old-2'),
    ).toBeUndefined();
    // Another client's results are never touched.
    await sync(t, [pushCommit('other', task('t5'))], { clientId: 'client-2' });
    await push(t, [pushCommit('new-3', task('t6'), 8)]);
    expect(
      await t.storage.getPushResult('part-1', 'client-2', 'other'),
    ).toBeDefined();
  });
});
