import { describe, expect, it } from 'bun:test';
import { createClientBridgeHarness } from '@syncular/testkit';
import { createSyncularExpoClient } from './index';

describe('@syncular/client-expo', () => {
  it('keeps Expo aliases wired to the React Native bridge behavior', async () => {
    const resource = await createClientBridgeHarness({
      seed: {
        tasks: [{ id: 'task-1', title: 'Expo task', completed: 0 }],
      },
    });
    const harness = resource.value;
    const client = await createSyncularExpoClient<TestDb>({
      module: harness.reactNative.module,
    });

    try {
      expect(await client.db.selectFrom('tasks').selectAll().execute()).toEqual(
        [{ id: 'task-1', title: 'Expo task', completed: 0 }]
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
