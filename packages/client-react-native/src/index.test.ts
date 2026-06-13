import { describe, expect, it } from 'bun:test';
import { createClientBridgeHarness } from '@syncular/testkit';
import { createSyncularNativeClient } from './index';

describe('@syncular/client-react-native', () => {
  it('drives the shared client API through a Syncular testkit native module', async () => {
    const resource = await createClientBridgeHarness({
      seed: {
        tasks: [{ id: 'task-1', title: 'Native task', completed: 0 }],
      },
    });
    const harness = resource.value;
    const client = await createSyncularNativeClient<TestDb>({
      module: harness.reactNative.module,
    });

    try {
      expect(await client.db.selectFrom('tasks').selectAll().execute()).toEqual(
        [{ id: 'task-1', title: 'Native task', completed: 0 }]
      );

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
      expect(harness.rows('tasks')).toEqual([
        { id: 'task-1', title: 'Leased', completed: 1 },
      ]);
      expect(harness.leasedBatches()).toHaveLength(1);

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
      await expect(client.diagnosticSnapshot()).resolves.toMatchObject({
        runtime: { packageName: '@syncular/testkit' },
      });
      await client.resumeFromBackground();

      const changedTables: string[][] = [];
      const unsubscribe = client.on('rowsChanged', (event) => {
        changedTables.push(event.changedTables);
      });
      expect(harness.listenerCount('rowsChanged')).toBe(1);
      unsubscribe();
      expect(harness.listenerCount('rowsChanged')).toBe(0);
      harness.emitRowsChanged({
        source: 'remotePull',
        changedTables: ['tasks'],
        changedRows: [],
      });
      expect(changedTables).toEqual([]);

      client.presence.join('document:one', { cursor: 1 });
      client.presence.updateMetadata('document:one', { cursor: 2 });
      expect(client.presence.get('document:one')[0]?.metadata).toEqual({
        cursor: 2,
      });
    } finally {
      await client.close();
      await resource.dispose();
    }
  });
});

interface TestDb {
  tasks: {
    id: string;
    title: string;
    completed: number;
  };
}
