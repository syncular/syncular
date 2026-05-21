import { describe, expect, it } from 'bun:test';
import { createClientBridgeHarness } from '@syncular/testkit';
import { createSyncularTauriClient } from './index';

describe('@syncular/client-tauri', () => {
  it('drives the shared client API through Syncular testkit Tauri commands', async () => {
    const resource = await createClientBridgeHarness({
      seed: {
        tasks: [{ id: 'task-1', title: 'Tauri task', completed: 0 }],
      },
    });
    const harness = resource.value;
    const client = await createSyncularTauriClient<TestDb>({
      invoke: harness.tauri.invoke,
      listen: harness.tauri.listen,
    });

    try {
      expect(await client.db.selectFrom('tasks').selectAll().execute()).toEqual(
        [{ id: 'task-1', title: 'Tauri task', completed: 0 }]
      );

      await client.mutations.tasks.update('task-1', { completed: 1 });
      expect(harness.operations()).toEqual([
        {
          table: 'tasks',
          row_id: 'task-1',
          op: 'upsert',
          payload: { completed: 1 },
          base_version: null,
        },
      ]);
      expect(harness.tauri.invocations().map((call) => call.command)).toEqual([
        'syncular_execute_sql',
        'syncular_apply_mutations_commit',
        'syncular_sync',
      ]);

      const changedTables: string[][] = [];
      const unsubscribe = client.on('rowsChanged', (event) => {
        changedTables.push(event.changedTables);
      });
      await Promise.resolve();
      harness.emitRowsChanged({
        source: 'remotePull',
        changedTables: ['tasks'],
        changedRows: [],
      });
      unsubscribe();
      expect(changedTables).toEqual([['tasks']]);

      const presenceScopes: string[] = [];
      const unsubscribePresence = client.presence.onChange((event) => {
        presenceScopes.push(event.scopeKey);
      });
      await Promise.resolve();
      client.presence.join('document:one', { cursor: 1 });
      await Promise.resolve();
      unsubscribePresence();
      expect(client.presence.get('document:one')[0]?.metadata).toEqual({
        cursor: 1,
      });
      expect(presenceScopes).toEqual(['document:one']);
    } finally {
      await client.destroy();
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
