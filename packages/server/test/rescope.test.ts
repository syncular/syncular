import { describe, expect, test } from 'bun:test';
import {
  decodeRemoteOperationResponse,
  encodeRemoteOperationRequest,
  type RowValue,
} from '@syncular/core';
import {
  handleRemoteOperation,
  registerRemoteCommand,
  RemoteOperationRegistry,
  remoteCommand,
} from '@syncular/server';
import {
  makeContext,
  pushCommit,
  sync,
  taskRow,
  type TestContext,
  upsert,
} from './helpers';

const command = registerRemoteCommand<{
  readonly table: string;
  readonly values: Readonly<Record<string, RowValue>>;
}>(
  remoteCommand<{
    readonly table: string;
    readonly values: Readonly<Record<string, RowValue>>;
  }>('test-rescope'),
  {
    authorize: () => true,
    run: (_context, input) => [
      { table: input.table, op: 'rescope', values: input.values },
    ],
  },
);

function taskValues(projectId: string, title: string) {
  return {
    id: 't1',
    project_id: projectId,
    title,
    done: false,
    priority: null,
    meta: null,
  };
}

async function rescope(
  t: TestContext,
  requestId: string,
  values: Readonly<Record<string, RowValue>>,
) {
  const response = decodeRemoteOperationResponse(
    await handleRemoteOperation(
      encodeRemoteOperationRequest({
        revision: 1,
        kind: 'command',
        clientId: 'rescope-test',
        operationId: 'test-rescope',
        requestId,
        params: { table: 'tasks', values },
      }),
      { ...t.ctx, actorId: 'actor-1' },
      new RemoteOperationRegistry([command]),
    ),
  );
  expect(response.kind).toBe('command');
  if (response.kind !== 'command') throw new Error('expected a command result');
  expect(response.status).toBe('applied');
  return response;
}

async function rowState(t: TestContext) {
  const tx = await t.storage.begin('part-1');
  const row = await tx.getRow('tasks', 't1');
  const tombstone = await tx.getTombstoneSeq('tasks', 't1');
  await tx.rollback();
  return { row, tombstone };
}

describe('explicit rescope (§2.2)', () => {
  test('moves twice and back without resetting the version or leaving a tombstone', async () => {
    const t = makeContext();
    t.scopes.value = { project_id: ['p1', 'p2'] };
    await sync(t, [
      pushCommit('seed', [upsert('tasks', 't1', taskRow('t1', 'p1', 'row'))]),
    ]);
    await sync(t, [
      pushCommit('bump', [upsert('tasks', 't1', taskRow('t1', 'p1', 'row2'))]),
    ]);
    const first = await rescope(t, 'r1', taskValues('p2', 'row2'));
    const firstCommit = await t.storage.getCommit(
      'part-1',
      first.commitSeq as number,
    );
    expect(
      firstCommit?.changes.map((change) => ({
        op: change.op,
        scopes: change.scopes,
      })),
    ).toEqual([
      { op: 'delete', scopes: { project_id: 'p1' } },
      { op: 'upsert', scopes: { project_id: 'p2' } },
    ]);
    let state = await rowState(t);
    expect(state.row?.scopes).toEqual({ project_id: 'p2' });
    expect(state.row?.serverVersion).toBe(2);
    expect(state.tombstone).toBeUndefined();

    await rescope(t, 'r2', taskValues('p1', 'row2'));
    state = await rowState(t);
    expect(state.row?.scopes).toEqual({ project_id: 'p1' });
    expect(state.row?.serverVersion).toBe(2);
    expect(state.tombstone).toBeUndefined();

    await rescope(t, 'r3', taskValues('p2', 'row2'));
    state = await rowState(t);
    expect(state.row?.scopes).toEqual({ project_id: 'p2' });
    expect(state.row?.serverVersion).toBe(2);
    expect(state.tombstone).toBeUndefined();
    expect(await t.storage.getMaxCommitSeq('part-1')).toBe(5);
  });

  test('a command batch read applies getRow scope authorization', async () => {
    const t = makeContext();
    t.scopes.value = { project_id: ['p1', 'p2'] };
    await sync(t, [
      pushCommit('seed-batch-read', [
        upsert('tasks', 't1', taskRow('t1', 'p1', 'visible')),
        upsert('tasks', 't2', taskRow('t2', 'p2', 'hidden')),
      ]),
    ]);
    t.scopes.value = { project_id: ['p1'] };

    let seen:
      | ReadonlyMap<string, Readonly<Record<string, RowValue>>>
      | undefined;
    type EmptyInput = Readonly<Record<string, never>>;
    const read = registerRemoteCommand<EmptyInput>(
      remoteCommand<EmptyInput>('test-batch-read'),
      {
        authorize: () => true,
        run: async (context) => {
          seen = await context.getRows('tasks', ['t1', 't2', 'absent', 't1']);
          return [
            {
              table: 'tasks',
              op: 'upsert',
              values: {
                id: 't3',
                project_id: 'p1',
                title: 'written',
                done: false,
                priority: null,
                meta: null,
              },
            },
          ];
        },
      },
    );
    const response = decodeRemoteOperationResponse(
      await handleRemoteOperation(
        encodeRemoteOperationRequest({
          revision: 1,
          kind: 'command',
          clientId: 'batch-read-test',
          operationId: 'test-batch-read',
          requestId: 'batch',
          params: {},
        }),
        { ...t.ctx, actorId: 'actor-1' },
        new RemoteOperationRegistry([read]),
      ),
    );
    expect(response).toMatchObject({ kind: 'command', status: 'applied' });
    expect([...(seen?.keys() ?? [])]).toEqual(['t1']);
    expect(seen?.get('t1')?.title).toBe('visible');
  });

  test('refuses a move to a scope the actor does not hold', async () => {
    const t = makeContext();
    t.scopes.value = { project_id: ['p1', 'p2'] };
    await sync(t, [
      pushCommit('seed', [upsert('tasks', 't1', taskRow('t1', 'p1', 'row'))]),
    ]);
    const response = decodeRemoteOperationResponse(
      await handleRemoteOperation(
        encodeRemoteOperationRequest({
          revision: 1,
          kind: 'command',
          clientId: 'rescope-test',
          operationId: 'test-rescope',
          requestId: 'bad',
          params: {
            table: 'tasks',
            values: taskValues('p3', 'row'),
          },
        }),
        { ...t.ctx, actorId: 'actor-1' },
        new RemoteOperationRegistry([command]),
      ),
    );
    expect(response).toMatchObject({
      kind: 'command',
      status: 'rejected',
    });
    if (response.kind !== 'command') return;
    expect(response.status).toBe('rejected');
    const state = await rowState(t);
    expect(state.row?.scopes).toEqual({ project_id: 'p1' });
    expect(state.tombstone).toBeUndefined();
  });
});
