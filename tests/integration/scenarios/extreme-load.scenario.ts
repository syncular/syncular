/**
 * Extreme load scenario - Tests with 10K+ rows (gated: INTEGRATION_LOAD=true)
 */

import { expect } from 'bun:test';
import { syncPullOnce } from '@syncular/client';
import type { ScenarioContext } from '../harness/types';

export async function runExtremeLoadScenario(
  ctx: ScenarioContext
): Promise<void> {
  const client = ctx.clients[0]!;

  const subP1 = {
    id: 'p1',
    table: 'tasks',
    scopes: { user_id: ctx.userId, project_id: 'p1' },
  };

  // Generate 10K rows via push commits (100 commits x 100 rows each)
  for (let batch = 0; batch < 100; batch++) {
    await client.transport.sync({
      clientId: client.clientId,
      push: {
        clientCommitId: `load-${batch}`,
        schemaVersion: 1,
        operations: Array.from({ length: 100 }, (_, i) => ({
          table: 'tasks',
          row_id: `task-${batch * 100 + i}`,
          op: 'upsert' as const,
          payload: {
            title: `Task ${batch * 100 + i}`,
            completed: 0,
            project_id: 'p1',
          },
        })),
      },
    });
  }

  // Bootstrap client (may require multiple pages)
  const maxBootstrapMs = 30_000;
  const start = performance.now();

  let isBootstrapping = true;
  while (isBootstrapping) {
    const result = await syncPullOnce(
      client.db,
      client.transport,
      client.handlers,
      {
        clientId: client.clientId,
        subscriptions: [subP1],
        limitSnapshotRows: 2000,
      }
    );

    const subResult = result.subscriptions.find((s) => s.id === 'p1');
    isBootstrapping = subResult?.bootstrapState != null;
  }

  const bootstrapMs = performance.now() - start;

  // Verify all rows synced
  const countResult = await client.db
    .selectFrom('tasks')
    .select((eb) => eb.fn.count<number>('id').as('c'))
    .executeTakeFirstOrThrow();
  const count = Number(countResult.c);

  expect(count).toBe(10_000);
  expect(bootstrapMs).toBeLessThan(maxBootstrapMs);
}

export async function runParallelPushScenario(
  ctx: ScenarioContext
): Promise<void> {
  const { server } = ctx;

  // Create 10 clients pushing simultaneously
  const clients = await Promise.all(
    Array.from({ length: 10 }, async (_, i) => {
      return ctx.createClient({
        actorId: `u${i}`,
        clientId: `parallel-client-${i}`,
      });
    })
  );

  // Each client pushes 100 commits
  await Promise.all(
    clients.map(async (client, i) => {
      for (let j = 0; j < 100; j++) {
        await client.transport.sync({
          clientId: client.clientId,
          push: {
            clientCommitId: `c-${i}-${j}`,
            schemaVersion: 1,
            operations: [
              {
                table: 'tasks',
                row_id: `t-${i}-${j}`,
                op: 'upsert' as const,
                payload: {
                  title: `Task ${i}-${j}`,
                  completed: 0,
                  project_id: `p${client.actorId}`,
                },
              },
            ],
          },
        });
      }
    })
  );

  // Verify all 1000 commits recorded
  const countResult = await server.db
    .selectFrom('sync_commits')
    .select((eb) => eb.fn.count<number>('commit_seq').as('c'))
    .executeTakeFirstOrThrow();
  const commitCount = Number(countResult.c);

  expect(commitCount).toBe(1000);
}

export async function runIdempotencyScenario(
  ctx: ScenarioContext
): Promise<void> {
  const client = ctx.clients[0]!;
  const { server } = ctx;

  const commitId = 'retry-test';
  const operation = {
    table: 'tasks',
    row_id: 'idempotent-task',
    op: 'upsert' as const,
    payload: { title: 'Test', completed: 0, project_id: 'p1' },
  };

  // Send same commit 100 times
  const results = [];
  for (let i = 0; i < 100; i++) {
    const combined = await client.transport.sync({
      clientId: client.clientId,
      push: {
        clientCommitId: commitId,
        schemaVersion: 1,
        operations: [operation],
      },
    });
    results.push(combined.push!);
  }

  const applied = results.filter((r) => r.status === 'applied').length;
  const cached = results.filter((r) => r.status === 'cached').length;

  expect(applied).toBe(1);
  expect(cached).toBe(99);

  // Only one row should exist
  const rows = await server.db
    .selectFrom('tasks')
    .where('id', '=', 'idempotent-task')
    .execute();
  expect(rows.length).toBe(1);
}
