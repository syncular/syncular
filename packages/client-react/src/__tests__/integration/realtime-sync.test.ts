/**
 * Integration tests for realtime sync
 *
 * These tests focus on multi-client correctness. Realtime wake-ups are handled
 * via WebSocket in production, but correctness remains pull-driven.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { enqueueOutboxCommit } from '@syncular/client';
import {
  createTestClient,
  createTestServer,
  destroyTestClient,
  destroyTestServer,
  type TestClient,
  type TestServer,
} from './test-setup';

describe('Realtime Sync via WebSocket', () => {
  let server: TestServer;
  let clientA: TestClient;
  let clientB: TestClient;

  const sharedUserId = 'realtime-user';

  beforeEach(async () => {
    server = await createTestServer();
    clientA = await createTestClient(server, {
      actorId: sharedUserId,
      clientId: 'client-a',
    });
    clientB = await createTestClient(server, {
      actorId: sharedUserId,
      clientId: 'client-b',
    });

    await clientA.engine.start();
    await clientB.engine.start();
  });

  afterEach(async () => {
    await destroyTestClient(clientA);
    await destroyTestClient(clientB);
    await destroyTestServer(server);
  });

  it('client B receives data pushed by client A', async () => {
    // Client A creates a task
    await enqueueOutboxCommit(clientA.db, {
      operations: [
        {
          table: 'tasks',
          row_id: 'realtime-task-1',
          op: 'upsert',
          payload: {
            title: 'Realtime Task',
            completed: 0,
            user_id: sharedUserId,
          },
          base_version: null,
        },
      ],
    });

    // Client A syncs (pushes to server)
    await clientA.engine.sync();

    // Client B syncs (pulls from server)
    await clientB.engine.sync();

    // Check client B has the task
    const tasksB = await clientB.db.selectFrom('tasks').selectAll().execute();

    expect(tasksB.length).toBe(1);
    expect(tasksB[0]!.title).toBe('Realtime Task');
  });

  it('updates propagate between clients', async () => {
    // Create initial task
    await enqueueOutboxCommit(clientA.db, {
      operations: [
        {
          table: 'tasks',
          row_id: 'update-test',
          op: 'upsert',
          payload: {
            title: 'Original',
            completed: 0,
            user_id: sharedUserId,
          },
          base_version: null,
        },
      ],
    });
    await clientA.engine.sync();
    await clientB.engine.sync();

    // Verify B has original
    let taskB = await clientB.db
      .selectFrom('tasks')
      .where('id', '=', 'update-test')
      .selectAll()
      .executeTakeFirst();
    expect(taskB!.title).toBe('Original');

    // A updates the task
    await enqueueOutboxCommit(clientA.db, {
      operations: [
        {
          table: 'tasks',
          row_id: 'update-test',
          op: 'upsert',
          payload: {
            title: 'Updated',
            completed: 1,
            user_id: sharedUserId,
          },
          base_version: 1,
        },
      ],
    });
    await clientA.engine.sync();
    await clientB.engine.sync();

    // Verify B has update
    taskB = await clientB.db
      .selectFrom('tasks')
      .where('id', '=', 'update-test')
      .selectAll()
      .executeTakeFirst();
    expect(taskB!.title).toBe('Updated');
    expect(taskB!.completed).toBe(1);
  });

  it('deletes propagate between clients', async () => {
    // Create task
    await enqueueOutboxCommit(clientA.db, {
      operations: [
        {
          table: 'tasks',
          row_id: 'delete-test',
          op: 'upsert',
          payload: {
            title: 'To Delete',
            completed: 0,
            user_id: sharedUserId,
          },
          base_version: null,
        },
      ],
    });
    await clientA.engine.sync();
    await clientB.engine.sync();

    // Verify B has task
    let countB = await clientB.db
      .selectFrom('tasks')
      .where('id', '=', 'delete-test')
      .select((eb) => eb.fn.count('id').as('count'))
      .executeTakeFirst();
    expect(Number(countB!.count)).toBe(1);

    // A deletes the task
    await enqueueOutboxCommit(clientA.db, {
      operations: [
        {
          table: 'tasks',
          row_id: 'delete-test',
          op: 'delete',
          payload: {},
          base_version: 1,
        },
      ],
    });
    await clientA.engine.sync();
    await clientB.engine.sync();

    // Verify B no longer has task
    countB = await clientB.db
      .selectFrom('tasks')
      .where('id', '=', 'delete-test')
      .select((eb) => eb.fn.count('id').as('count'))
      .executeTakeFirst();
    expect(Number(countB!.count)).toBe(0);
  });

  it('multiple rapid changes sync correctly', async () => {
    // Create 5 tasks rapidly
    for (let i = 0; i < 5; i++) {
      await enqueueOutboxCommit(clientA.db, {
        operations: [
          {
            table: 'tasks',
            row_id: `rapid-${i}`,
            op: 'upsert',
            payload: {
              title: `Task ${i}`,
              completed: 0,
              user_id: sharedUserId,
            },
            base_version: null,
          },
        ],
      });
    }

    // Sync A
    await clientA.engine.sync();

    // Sync B
    await clientB.engine.sync();

    // Verify B has all 5 tasks
    const tasksB = await clientB.db
      .selectFrom('tasks')
      .where('id', 'like', 'rapid-%')
      .selectAll()
      .execute();

    expect(tasksB.length).toBe(5);
  });
});
