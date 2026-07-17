/**
 * Integration: the generated module drives the real B2 server through
 * bytes (loopback doctrine — no HTTP): construct a server with the
 * generated ServerSchema-compatible object, push one row, pull it back
 * via the generated subscription helper, decode it with the generated
 * column order.
 */
import { describe, expect, test } from 'bun:test';
import {
  type CommitFrame,
  decodeMessage,
  decodeRow,
  encodeMessage,
  encodeRow,
  PROTOCOL_WIRE_VERSION,
  type PushResultFrame,
  type RequestFrame,
  type ResponseMessage,
} from '@syncular/core';
import {
  handleSyncRequest,
  MemorySegmentStore,
  SqliteServerStorage,
  type SyncRequestContext,
} from '@syncular/server';
import { snakeToCamel } from '../src';
import {
  projectTasksSubscription,
  schema,
  type TasksRow,
} from './fixtures/basic/syncular.generated';

function makeContext(): SyncRequestContext {
  return {
    partition: 'part-1',
    actorId: 'actor-1',
    schema,
    storage: new SqliteServerStorage(),
    segments: new MemorySegmentStore(),
    resolveScopes: () => ({ project_id: ['p1'], projectId: ['p1'] }),
    clock: () => 1_750_000_000_000,
  };
}

async function sync(
  ctx: SyncRequestContext,
  frames: RequestFrame[],
): Promise<ResponseMessage> {
  const bytes = encodeMessage({
    wireVersion: PROTOCOL_WIRE_VERSION,
    msgKind: 'request',
    frames: [
      {
        type: 'REQ_HEADER',
        clientId: 'client-1',
        schemaVersion: schema.version,
      },
      ...frames,
    ],
  });
  const message = decodeMessage(await handleSyncRequest(bytes, ctx));
  if (message.msgKind !== 'response') throw new Error('expected a response');
  return message;
}

describe('generated schema against the B2 server', () => {
  test('push + pull one row through bytes', async () => {
    const ctx = makeContext();
    const tasks = schema.tables[0];
    const row: TasksRow = {
      id: 't1',
      projectId: 'p1',
      title: 'generated end to end',
      done: false,
      reviewed: null,
      priority: 3,
      meta: null,
      estimate: 1.5,
      estimatedAt: null,
    };
    // Generated row keys are camelCase (§5); the wire codec wants schema
    // (snake) order — map through the pinned naming function.
    const payload = encodeRow(
      tasks.columns,
      tasks.columns.map(
        (column) => row[snakeToCamel(column.name) as keyof TasksRow],
      ),
    );

    const pushed = await sync(ctx, [
      {
        type: 'PUSH_COMMIT',
        clientCommitId: 'c1',
        operations: [
          { table: tasks.name, rowId: row.id, op: 'upsert', payload },
        ],
      },
    ]);
    const result = pushed.frames.find(
      (f): f is PushResultFrame => f.type === 'PUSH_RESULT',
    );
    expect(result?.status).toBe('applied');

    const pulled = await sync(ctx, [
      {
        type: 'PULL_HEADER',
        limitCommits: 0,
        limitSnapshotRows: 0,
        maxSnapshotPages: 0,
        accept: 0b0011,
      },
      {
        type: 'SUBSCRIPTION',
        id: 's1',
        table: projectTasksSubscription.table,
        scopes: projectTasksSubscription.scopes({ projectId: 'p1' }),
        cursor: 0,
      },
    ]);
    const commit = pulled.frames.find(
      (f): f is CommitFrame => f.type === 'COMMIT',
    );
    expect(commit?.tables).toEqual([tasks.name]);
    const change = commit?.changes[0];
    expect(change?.rowId).toBe('t1');
    expect(change?.scopes).toEqual({ project_id: 'p1' });

    const values = decodeRow(tasks.columns, change?.row ?? new Uint8Array());
    const decoded = Object.fromEntries(
      tasks.columns.map((column, i) => [snakeToCamel(column.name), values[i]]),
    ) as unknown as TasksRow;
    expect(decoded).toEqual(row);
  });
});
