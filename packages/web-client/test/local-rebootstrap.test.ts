import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ClientSyncError,
  createSyncClientHandle,
  decodeLocalDataRebootstrapResult,
  INVALID_HOST_RESPONSE_CODE,
} from '@syncular/client';
import {
  decodeLocalDataRebootstrapReceipt,
  encodeLocalDataRebootstrapReceipt,
} from '../src/local-rebootstrap-receipt';
import { makeClient, makeServer, tableRows, taskValues } from './helpers';

const MALFORMED_RESULTS: unknown[] = [
  null,
  { retainedCommits: 1, resetSubscriptions: 1 },
  {
    alreadyApplied: false,
    retainedCommits: 1,
    resetSubscriptions: 1,
    extra: true,
  },
  { alreadyApplied: false, retainedCommits: -1, resetSubscriptions: 1 },
  { alreadyApplied: false, retainedCommits: 1.5, resetSubscriptions: 1 },
  { alreadyApplied: false, retainedCommits: Number.NaN, resetSubscriptions: 1 },
  { alreadyApplied: false, retainedCommits: '1', resetSubscriptions: 1 },
  {
    alreadyApplied: false,
    retainedCommits: Number.MAX_SAFE_INTEGER + 1,
    resetSubscriptions: 1,
  },
];

function malformedResultWorker(value: unknown): Worker {
  const listeners = new Set<(event: MessageEvent) => void>();
  const emit = (data: unknown): void => {
    for (const listener of listeners) listener({ data } as MessageEvent);
  };
  queueMicrotask(() => emit({ t: 'ready' }));
  return {
    addEventListener: (
      type: string,
      listener: EventListenerOrEventListenerObject,
    ) => {
      if (type === 'message' && typeof listener === 'function') {
        listeners.add(listener as (event: MessageEvent) => void);
      }
    },
    postMessage: (message: {
      readonly t: string;
      readonly id?: number;
      readonly method?: string;
    }) => {
      if (message.t === 'init') {
        queueMicrotask(() =>
          emit({ t: 'result', id: message.id, value: { clientId: 'host' } }),
        );
      } else if (message.t === 'call') {
        queueMicrotask(() =>
          emit({
            t: 'result',
            id: message.id,
            value:
              message.method === 'rebootstrapLocalData' ? value : undefined,
          }),
        );
      }
    },
    terminate: () => {},
  } as unknown as Worker;
}

describe('local rebootstrap acknowledgement decoder', () => {
  test('accepts the exact public result shape', () => {
    expect(
      decodeLocalDataRebootstrapResult({
        alreadyApplied: false,
        retainedCommits: Number.MAX_SAFE_INTEGER,
        resetSubscriptions: 0,
      }),
    ).toEqual({
      alreadyApplied: false,
      retainedCommits: Number.MAX_SAFE_INTEGER,
      resetSubscriptions: 0,
    });
  });

  test.each(MALFORMED_RESULTS)('rejects malformed value %#', (value) => {
    expect(() => decodeLocalDataRebootstrapResult(value)).toThrow(
      expect.objectContaining({ code: INVALID_HOST_RESPONSE_CODE }),
    );
  });

  test.each(
    MALFORMED_RESULTS,
  )('the Worker adapter rejects malformed value %#', async (value) => {
    const handle = await createSyncClientHandle({
      worker: () => malformedResultWorker(value),
      schema: { version: 1, tables: [] },
      database: { mode: 'custom' },
      endpoints: { syncUrl: 'https://invalid.test/sync' },
      autoSync: false,
      multiTab: false,
    });
    await expect(
      handle.rebootstrapLocalData({ rebootstrapId: 'repair-001' }),
    ).rejects.toMatchObject({ code: INVALID_HOST_RESPONSE_CODE });
    await handle.close();
  });
});

describe('durable local rebootstrap receipt', () => {
  test('round-trips bounded counts and preserves the legacy marker contract', () => {
    expect(
      decodeLocalDataRebootstrapReceipt(
        encodeLocalDataRebootstrapReceipt({
          retainedCommits: 3,
          resetSubscriptions: 4,
        }),
      ),
    ).toEqual({ retainedCommits: 3, resetSubscriptions: 4 });
    expect(decodeLocalDataRebootstrapReceipt('v1')).toEqual({
      retainedCommits: 0,
      resetSubscriptions: 0,
    });
  });

  test.each([
    '',
    '{}',
    '{"version":3,"retainedCommits":1,"resetSubscriptions":1}',
    '{"version":2,"retainedCommits":-1,"resetSubscriptions":1}',
    `{"version":2,"retainedCommits":${Number.MAX_SAFE_INTEGER + 1},"resetSubscriptions":1}`,
    '{"version":2,"retainedCommits":1,"resetSubscriptions":1,"extra":true}',
  ])('rejects malformed persisted receipt %#', (value) => {
    expect(() => decodeLocalDataRebootstrapReceipt(value)).toThrow(
      expect.objectContaining({ code: 'sync.local_corrupt' }),
    );
  });
});

describe('application-authorized local projection rebootstrap', () => {
  test('atomically rewinds subscriptions and retains identity, outcomes, and optimistic work', async () => {
    const server = makeServer();
    const local = await makeClient(server, {
      clientId: 'repair-client',
    });
    local.client.subscribe({
      id: 'repair-tasks',
      table: 'tasks',
      scopes: { project_id: ['p1'] },
    });
    await local.client.syncUntilIdle();

    const accepted = local.client.mutate([
      {
        table: 'tasks',
        op: 'upsert',
        values: taskValues('server-row', 'p1', 'accepted'),
      },
    ]);
    await local.client.syncUntilIdle();
    const pending = local.client.mutate([
      {
        table: 'tasks',
        op: 'upsert',
        values: taskValues('offline-row', 'p1', 'offline'),
      },
    ]);
    expect(tableRows(local.db, 'tasks').map((row) => row.id)).toEqual([
      'offline-row',
      'server-row',
    ]);

    const changes: string[][] = [];
    local.client.onChange((change) =>
      changes.push(change.tables.map((table) => table.table)),
    );
    expect(
      local.client.rebootstrapLocalData({
        rebootstrapId: 'support-case-001',
      }),
    ).toEqual({
      alreadyApplied: false,
      retainedCommits: 1,
      resetSubscriptions: 1,
    });

    expect(local.client.clientId).toBe('repair-client');
    expect(
      local.client.pendingCommits().map((commit) => commit.clientCommitId),
    ).toEqual([pending]);
    expect(local.client.commitOutcome(accepted)?.status).toBe('applied');
    expect(tableRows(local.db, 'tasks').map((row) => row.id)).toEqual([
      'offline-row',
    ]);
    expect(local.client.subscription('repair-tasks')).toMatchObject({
      cursor: -1,
      status: 'active',
    });
    expect(
      local.client.subscription('repair-tasks')?.bootstrapState,
    ).toBeUndefined();
    expect(local.client.upgrading).toBe(true);
    expect(local.client.syncNeeded).toBe(true);
    expect(changes).toHaveLength(1);
    expect(changes[0]).toContain('tasks');

    expect(
      local.client.rebootstrapLocalData({
        rebootstrapId: 'support-case-001',
      }),
    ).toEqual({
      alreadyApplied: true,
      retainedCommits: 1,
      resetSubscriptions: 1,
    });
    expect(changes).toHaveLength(1);

    await local.client.syncUntilIdle();
    expect(tableRows(local.db, 'tasks').map((row) => row.id)).toEqual([
      'offline-row',
      'server-row',
    ]);
    expect(local.client.pendingCommits()).toEqual([]);
    expect(local.client.upgrading).toBe(false);
    await local.client.close();
    local.db.close();
  });

  test('persists the atomic reset, replay, and idempotency marker across restart', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'syncular-rebootstrap-'));
    const databasePath = join(directory, 'client.sqlite');
    const server = makeServer();
    try {
      const first = await makeClient(server, {
        clientId: 'repair-restart-client',
        databasePath,
      });
      first.client.subscribe({
        id: 'repair-restart-tasks',
        table: 'tasks',
        scopes: { project_id: ['p1'] },
      });
      await first.client.syncUntilIdle();
      first.client.mutate([
        {
          table: 'tasks',
          op: 'upsert',
          values: taskValues('pending-after-restart', 'p1', 'offline'),
        },
      ]);
      first.client.rebootstrapLocalData({ rebootstrapId: 'restart-001' });
      await first.client.close();
      first.db.close();

      const reopened = await makeClient(server, {
        clientId: 'repair-restart-client',
        databasePath,
      });
      expect(tableRows(reopened.db, 'tasks').map((row) => row.id)).toEqual([
        'pending-after-restart',
      ]);
      expect(reopened.client.pendingCommits()).toHaveLength(1);
      expect(
        reopened.client.rebootstrapLocalData({ rebootstrapId: 'restart-001' }),
      ).toEqual({
        alreadyApplied: true,
        retainedCommits: 1,
        resetSubscriptions: 1,
      });
      await reopened.client.close();
      reopened.db.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test('fails closed on a malformed persisted receipt without resetting the projection', async () => {
    const server = makeServer();
    const local = await makeClient(server, {
      clientId: 'repair-corrupt-receipt-client',
    });
    local.client.subscribe({
      id: 'repair-corrupt-receipt-tasks',
      table: 'tasks',
      scopes: { project_id: ['p1'] },
    });
    local.client.mutate([
      {
        table: 'tasks',
        op: 'upsert',
        values: taskValues('server-row', 'p1', 'accepted'),
      },
    ]);
    await local.client.syncUntilIdle();
    local.db.exec('INSERT INTO _syncular_meta(key, value) VALUES (?, ?)', [
      'localRebootstrap:corrupt-receipt',
      '{"version":2}',
    ]);

    expect(() =>
      local.client.rebootstrapLocalData({
        rebootstrapId: 'corrupt-receipt',
      }),
    ).toThrow(expect.objectContaining({ code: 'sync.local_corrupt' }));
    expect(tableRows(local.db, 'tasks').map((row) => row.id)).toEqual([
      'server-row',
    ]);
    expect(
      local.client.subscription('repair-corrupt-receipt-tasks')?.cursor,
    ).toBeGreaterThanOrEqual(0);

    await local.client.close();
    local.db.close();
  });

  test('fails closed for unsafe operation ids', async () => {
    const local = await makeClient(makeServer(), {
      clientId: 'repair-validation-client',
    });
    try {
      local.client.rebootstrapLocalData({ rebootstrapId: '../unsafe' });
      throw new Error('expected rebootstrap validation to fail');
    } catch (error) {
      expect(error).toBeInstanceOf(ClientSyncError);
      expect((error as ClientSyncError).code).toBe('sync.invalid_request');
    }
    await local.client.close();
    local.db.close();
  });
});
