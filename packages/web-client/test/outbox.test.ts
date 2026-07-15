/**
 * Outbox unit tests: schema-agnostic persistence + encode-at-send (the §0
 * binary-push outbox rule), FIFO order, mutation validation, and the §3.3
 * revoked-scope drop helper.
 */
import { describe, expect, test } from 'bun:test';
import {
  appendOutboxCommit,
  type ClientSchema,
  ClientSyncError,
  compileClientSchema,
  dropOutboxCommitsInScope,
  encodeOutboxCommit,
  ensureLocalSchema,
  type JsonRowValue,
  jsonToRowValue,
  listOutbox,
  rowValueToJson,
} from '@syncular/client';
import { BunClientDatabase } from '@syncular/client/bun';
import { decodeRow, encodeRow } from '@syncular/core';
import {
  CLIENT_SCHEMA,
  makeClient,
  makeServer,
  TASK_COLUMNS,
  taskValues,
} from './helpers';

const compiled = compileClientSchema(CLIENT_SCHEMA);

describe('schema-agnostic persistence (§0 outbox rule)', () => {
  test('mutations are stored as JSON values, not encoded bytes', async () => {
    const server = makeServer();
    const a = await makeClient(server, { clientId: 'client-a' });
    a.client.mutate([
      {
        table: 'tasks',
        op: 'upsert',
        values: taskValues('t1', 'p1', 'title', true, 7, '{"k":1}'),
      },
    ]);
    const [commit] = a.client.pendingCommits();
    const op = commit?.operations[0];
    expect(op?.values).toEqual({
      id: 't1',
      project_id: 'p1',
      title: 'title',
      done: true,
      priority: 7,
      meta: '{"k":1}',
    });
    expect(op?.changedFields).toBeUndefined();
    // The persisted form is JSON-serializable — no binary in the outbox.
    expect(() => JSON.stringify(op)).not.toThrow();
  });

  test('bytes values round-trip through the JSON form', () => {
    const bytes = new Uint8Array([0, 1, 254, 255]);
    const json = rowValueToJson(bytes);
    expect(json).toEqual({ $bytes: '0001feff' });
    expect(jsonToRowValue(json)).toEqual(bytes);
  });

  test('a bytes column encodes at send time from the JSON form', async () => {
    const blobSchema: ClientSchema = {
      version: 1,
      tables: [
        {
          name: 'blobs',
          columns: [
            { name: 'id', type: 'string', nullable: false },
            { name: 'project_id', type: 'string', nullable: false },
            { name: 'data', type: 'bytes', nullable: true },
          ],
          primaryKey: 'id',
          scopes: ['project:{project_id}'],
        },
      ],
    };
    const schema = compileClientSchema(blobSchema);
    const frame = await encodeOutboxCommit(schema, {
      seq: 1,
      clientCommitId: 'c1',
      createdAtMs: 0,
      operations: [
        {
          table: 'blobs',
          rowId: 'b1',
          op: 'upsert',
          values: { id: 'b1', project_id: 'p1', data: { $bytes: 'cafe' } },
        },
      ],
    });
    const payload = frame.operations[0]?.payload;
    expect(payload).toBeDefined();
    const columns = blobSchema.tables[0]?.columns ?? [];
    const values = decodeRow(columns, payload ?? new Uint8Array());
    expect(values).toEqual(['b1', 'p1', new Uint8Array([0xca, 0xfe])]);
  });
});

describe('encode-at-send (§6.1)', () => {
  test('the encoded payload is exactly the current codec output', async () => {
    const server = makeServer();
    const a = await makeClient(server, { clientId: 'client-a' });
    a.client.mutate([
      {
        table: 'tasks',
        op: 'upsert',
        values: taskValues('t1', 'p1', 'x', false, null, null),
        baseVersion: 3,
      },
    ]);
    const [commit] = a.client.pendingCommits();
    if (commit === undefined) throw new Error('missing outbox commit');
    const frame = await encodeOutboxCommit(compiled, commit);
    expect(frame.clientCommitId).toBe(commit.clientCommitId);
    const op = frame.operations[0];
    expect(op?.baseVersion).toBe(3);
    expect(op?.payload).toEqual(
      encodeRow(TASK_COLUMNS, ['t1', 'p1', 'x', false, null, null]),
    );
  });

  test('deletes carry no payload; upserts without values fail loud', async () => {
    const del = await encodeOutboxCommit(compiled, {
      seq: 1,
      clientCommitId: 'c1',
      createdAtMs: 0,
      operations: [{ table: 'tasks', rowId: 't1', op: 'delete' }],
    });
    expect(del.operations[0]?.payload).toBeUndefined();
    await expect(
      encodeOutboxCommit(compiled, {
        seq: 2,
        clientCommitId: 'c2',
        createdAtMs: 0,
        operations: [{ table: 'tasks', rowId: 't1', op: 'upsert' }],
      }),
    ).rejects.toThrow(ClientSyncError);
  });

  test('outbox order is FIFO by creation (§7.1)', async () => {
    const server = makeServer();
    const a = await makeClient(server, { clientId: 'client-a' });
    const first = a.client.mutate([
      { table: 'tasks', op: 'upsert', values: taskValues('t1', 'p1') },
    ]);
    const second = a.client.mutate([
      { table: 'tasks', op: 'delete', rowId: 't1' },
    ]);
    const third = a.client.mutate([
      { table: 'tasks', op: 'upsert', values: taskValues('t2', 'p1') },
    ]);
    expect(a.client.pendingCommits().map((c) => c.clientCommitId)).toEqual([
      first,
      second,
      third,
    ]);
  });

  test('patch records normalized field intent locally without changing the wire', async () => {
    const server = makeServer();
    const a = await makeClient(server, { clientId: 'patch-intent' });
    a.client.mutate([
      { table: 'tasks', op: 'upsert', values: taskValues('t1', 'p1') },
    ]);
    await a.client.syncUntilIdle();
    a.client.patch('tasks', 't1', { title: 'changed', projectId: 'p1' });
    const commit = a.client.pendingCommits()[0];
    expect(commit?.operations[0]?.changedFields).toEqual([
      'project_id',
      'title',
    ]);
    const frame = await encodeOutboxCommit(
      compiled,
      commit as NonNullable<typeof commit>,
    );
    expect(frame.operations[0]).not.toHaveProperty('changedFields');
  });
});

describe('mutation validation', () => {
  test('unknown columns, missing non-nullables, and bad keys fail loud', async () => {
    const server = makeServer();
    const a = await makeClient(server, { clientId: 'client-a' });
    expect(() =>
      a.client.mutate([
        {
          table: 'tasks',
          op: 'upsert',
          values: { ...taskValues('t1', 'p1'), typo_column: 1 },
        },
      ]),
    ).toThrow('unknown column');
    expect(() =>
      a.client.mutate([
        {
          table: 'tasks',
          op: 'upsert',
          values: { id: 't1', project_id: 'p1' },
        },
      ]),
    ).toThrow('not nullable');
    expect(() =>
      a.client.mutate([
        {
          table: 'tasks',
          op: 'upsert',
          values: { ...taskValues('t1', 'p1'), id: null },
        },
      ]),
    ).toThrow('not nullable');
    expect(() =>
      a.client.mutate([{ table: 'nope', op: 'delete', rowId: 'x' }]),
    ).toThrow('unknown local table');
    // Failed mutations leave no partial state behind.
    expect(a.client.pendingCommits()).toHaveLength(0);
  });
});

describe('revoked-scope drop (§3.3)', () => {
  test('drops whole commits with an upsert in the revoked scope, keeps the rest', () => {
    const db = new BunClientDatabase();
    ensureLocalSchema(db, compiled);
    const table = compiled.tables.get('tasks');
    if (table === undefined) throw new Error('missing table');
    const values = (id: string, project: string) =>
      taskValues(id, project) as Record<string, JsonRowValue>;
    appendOutboxCommit(
      db,
      'in-scope',
      [
        {
          table: 'tasks',
          rowId: 't1',
          op: 'upsert',
          values: values('t1', 'p1'),
        },
      ],
      0,
    );
    appendOutboxCommit(
      db,
      'other-scope',
      [
        {
          table: 'tasks',
          rowId: 't2',
          op: 'upsert',
          values: values('t2', 'p2'),
        },
      ],
      1,
    );
    appendOutboxCommit(
      db,
      'delete-only',
      [{ table: 'tasks', rowId: 't3', op: 'delete' }],
      2,
    );
    appendOutboxCommit(
      db,
      'mixed',
      [
        {
          table: 'tasks',
          rowId: 't4',
          op: 'upsert',
          values: values('t4', 'p2'),
        },
        {
          table: 'tasks',
          rowId: 't5',
          op: 'upsert',
          values: values('t5', 'p1'),
        },
      ],
      3,
    );
    const dropped = dropOutboxCommitsInScope(db, table, {
      project_id: ['p1'],
    });
    // Commits are atomic and content-pinned (§2.3): 'mixed' goes as a whole.
    expect(dropped.sort()).toEqual(['in-scope', 'mixed']);
    expect(listOutbox(db).map((c) => c.clientCommitId)).toEqual([
      'other-scope',
      'delete-only',
    ]);
  });
});
