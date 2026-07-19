import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ClientSyncError } from '@syncular/client';
import { makeClient, makeServer, tableRows, taskValues } from './helpers';

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
      retainedCommits: 0,
      resetSubscriptions: 0,
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
        retainedCommits: 0,
        resetSubscriptions: 0,
      });
      await reopened.client.close();
      reopened.db.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
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
