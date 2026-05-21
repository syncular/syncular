import { describe, expect, it } from 'bun:test';
import { createClientBridgeHarness } from '../../../../packages/testkit/src/client-bridge';
import { createSyncularBridgeClient } from './bridge-client';

describe('Syncular bridge client', () => {
  it('exposes the shared ergonomic client shape over a Syncular bridge harness', async () => {
    const resource = await createClientBridgeHarness({
      seed: {
        tasks: [{ id: 'task-1', title: 'Bridge query', completed: 0 }],
      },
    });
    const harness = resource.value;
    const client = await createSyncularBridgeClient<TestDb>({
      bridge: harness.bridge,
    });

    try {
      const rows = await client.db.selectFrom('tasks').selectAll().execute();
      expect(rows).toEqual([
        { id: 'task-1', title: 'Bridge query', completed: 0 },
      ]);
      expect(harness.queries()[0]?.sql).toContain('select * from "tasks"');

      await client.mutations.tasks.update('task-1', { completed: 1 });
      await client.leasedMutations.tasks.update('task-1', { title: 'Leased' });
      expect(harness.operations()).toEqual([
        {
          table: 'tasks',
          row_id: 'task-1',
          op: 'upsert',
          payload: { completed: 1 },
          base_version: null,
        },
        {
          table: 'tasks',
          row_id: 'task-1',
          op: 'upsert',
          payload: { title: 'Leased' },
          base_version: null,
        },
      ]);
      expect(harness.leasedBatches()).toHaveLength(1);
      expect(harness.syncCount()).toBe(2);
      expect(harness.rows('tasks')).toEqual([
        { id: 'task-1', title: 'Leased', completed: 1 },
      ]);

      const lease = await client.issueAuthLease({
        schemaVersion: 1,
        scopes: [
          {
            subscriptionId: 'tasks',
            table: 'tasks',
            values: { user_id: 'user-1' },
            operations: ['upsert'],
          },
        ],
      });
      expect(await client.authLease(lease.leaseId)).toMatchObject({
        leaseId: lease.leaseId,
      });
      expect(await client.activeAuthLeases('actor-test')).toHaveLength(1);

      const changedTables: string[][] = [];
      const unsubscribe = client.on('rowsChanged', (event) => {
        changedTables.push(event.changedTables);
      });
      harness.emitRowsChanged({
        source: 'remotePull',
        changedTables: ['tasks'],
        changedRows: [],
      });
      unsubscribe();
      expect(changedTables).toEqual([['tasks']]);

      harness.setStatus({
        connection: {
          closed: false,
          pendingRequests: 0,
          realtime: 'connected',
        },
        outbox: {
          pending: 1,
          sending: 0,
          failed: 0,
          acked: 0,
          total: 1,
        },
      });
      expect(client.getStatus().isConnected).toBe(true);
      expect(client.getStatus().hasPendingMutations).toBe(true);
      await expect(client.diagnosticSnapshot()).resolves.toMatchObject({
        runtime: { packageName: '@syncular/testkit' },
        outboxStats: { pending: 1 },
      });

      await client.resumeFromBackground();
      expect(client.getStatus().isConnected).toBe(true);

      await client.destroy();
      expect(harness.listenerCount('rowsChanged')).toBe(0);
    } finally {
      await resource.dispose();
    }
  });
});

interface TestDb {
  tasks: {
    id: string;
    title: string;
    completed?: number;
  };
}
