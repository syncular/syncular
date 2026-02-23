/**
 * Large dataset scenario - Tests syncing 1K+ rows over HTTP
 */

import { expect } from 'bun:test';
import { syncPullOnce } from '@syncular/client';
import type { ScenarioContext } from '../harness/types';

export async function runLargeDatasetScenario(
  ctx: ScenarioContext & { rowCount?: number }
): Promise<void> {
  const { server } = ctx;
  const client = ctx.clients[0]!;
  const rowCount = ctx.rowCount ?? 1000;

  // Seed server with data in batches
  const rows = Array.from({ length: rowCount }, (_, i) => ({
    id: `task-${i + 1}`,
    title: `Task ${i + 1}`,
    completed: 0,
    user_id: ctx.userId,
    project_id: 'p1',
    server_version: 1,
  }));

  const batchSize = 500;
  for (let i = 0; i < rows.length; i += batchSize) {
    const batch = rows.slice(i, i + batchSize);
    await server.db.insertInto('tasks').values(batch).execute();
  }

  // Bootstrap client (may require multiple pages)
  let isBootstrapping = true;
  while (isBootstrapping) {
    const result = await syncPullOnce(
      client.db,
      client.transport,
      client.handlers,
      {
        clientId: client.clientId,
        subscriptions: [
          {
            id: 'my-tasks',
            table: 'tasks',
            scopes: { user_id: ctx.userId, project_id: 'p1' },
          },
        ],
        limitSnapshotRows: 1000,
      }
    );

    const subResult = result.subscriptions.find((s) => s.id === 'my-tasks');
    isBootstrapping = subResult?.bootstrapState != null;
  }

  // Verify all data synced to client
  const clientTasks = await client.db.selectFrom('tasks').selectAll().execute();
  expect(clientTasks.length).toBe(rowCount);

  // Verify first and last rows
  const sortedTasks = [...clientTasks].sort((a, b) => {
    const numA = Number.parseInt(a.id.replace('task-', ''), 10);
    const numB = Number.parseInt(b.id.replace('task-', ''), 10);
    return numA - numB;
  });
  expect(sortedTasks[0]?.id).toBe('task-1');
  expect(sortedTasks[rowCount - 1]?.id).toBe(`task-${rowCount}`);
}
