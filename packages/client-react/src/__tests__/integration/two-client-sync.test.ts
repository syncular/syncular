/**
 * Integration tests for two-client sync
 *
 * Tests that two clients with the same user ID can sync data between each other
 * through a shared server.
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

describe('Two Client Sync', () => {
  let server: TestServer;
  let clientA: TestClient;
  let clientB: TestClient;

  // Both clients use the same userId so they share the same scope
  const sharedUserId = 'shared-user';

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

    // Start both engines
    await clientA.engine.start();
    await clientB.engine.start();
  });

  afterEach(async () => {
    await destroyTestClient(clientA);
    await destroyTestClient(clientB);
    await destroyTestServer(server);
  });

  it('changes from client A appear in client B after sync', async () => {
    // Client A creates a task via outbox
    await enqueueOutboxCommit(clientA.db, {
      operations: [
        {
          table: 'tasks',
          row_id: 'task-1',
          op: 'upsert',
          payload: {
            title: 'Task from Client A',
            completed: 0,
            user_id: sharedUserId,
          },
          base_version: null,
        },
      ],
    });

    // Sync client A (push to server)
    await clientA.engine.sync();

    // Sync client B (pull from server)
    await clientB.engine.sync();

    // Check client B has the task
    const tasksB = await clientB.db.selectFrom('tasks').selectAll().execute();

    expect(tasksB.length).toBe(1);
    expect(tasksB[0]!.id).toBe('task-1');
    expect(tasksB[0]!.title).toBe('Task from Client A');
  });

  it('changes sync bidirectionally', async () => {
    // Client A creates task-1
    await enqueueOutboxCommit(clientA.db, {
      operations: [
        {
          table: 'tasks',
          row_id: 'task-1',
          op: 'upsert',
          payload: {
            title: 'Task from A',
            completed: 0,
            user_id: sharedUserId,
          },
          base_version: null,
        },
      ],
    });

    // Client B creates task-2
    await enqueueOutboxCommit(clientB.db, {
      operations: [
        {
          table: 'tasks',
          row_id: 'task-2',
          op: 'upsert',
          payload: {
            title: 'Task from B',
            completed: 1,
            user_id: sharedUserId,
          },
          base_version: null,
        },
      ],
    });

    // Sync both clients
    await clientA.engine.sync();
    await clientB.engine.sync();
    // Sync again to ensure A gets B's changes
    await clientA.engine.sync();

    // Check both clients have both tasks
    const tasksA = await clientA.db
      .selectFrom('tasks')
      .selectAll()
      .orderBy('id', 'asc')
      .execute();

    const tasksB = await clientB.db
      .selectFrom('tasks')
      .selectAll()
      .orderBy('id', 'asc')
      .execute();

    expect(tasksA.length).toBe(2);
    expect(tasksB.length).toBe(2);

    expect(tasksA.map((t) => t.id)).toEqual(['task-1', 'task-2']);
    expect(tasksB.map((t) => t.id)).toEqual(['task-1', 'task-2']);
  });

  it('offline client queues changes until reconnect', async () => {
    // Client A goes offline (stop engine)
    clientA.engine.stop();

    // Client A creates a task while offline
    await enqueueOutboxCommit(clientA.db, {
      operations: [
        {
          table: 'tasks',
          row_id: 'offline-task',
          op: 'upsert',
          payload: {
            title: 'Created while offline',
            completed: 0,
            user_id: sharedUserId,
          },
          base_version: null,
        },
      ],
    });

    // Verify task is in outbox (pending)
    const outbox = await clientA.db
      .selectFrom('sync_outbox_commits')
      .selectAll()
      .execute();
    expect(outbox.length).toBe(1);
    expect(outbox[0]!.status).toBe('pending');

    // Client B syncs - should not see the task
    await clientB.engine.sync();
    const tasksBefore = await clientB.db
      .selectFrom('tasks')
      .selectAll()
      .execute();
    expect(tasksBefore.length).toBe(0);

    // Client A reconnects
    await clientA.engine.start();
    await clientA.engine.sync();

    // Now client B syncs and should see the task
    await clientB.engine.sync();
    const tasksAfter = await clientB.db
      .selectFrom('tasks')
      .selectAll()
      .execute();
    expect(tasksAfter.length).toBe(1);
    expect(tasksAfter[0]!.title).toBe('Created while offline');
  });

  it('updates to existing tasks sync correctly', async () => {
    // Client A creates a task
    await enqueueOutboxCommit(clientA.db, {
      operations: [
        {
          table: 'tasks',
          row_id: 'task-1',
          op: 'upsert',
          payload: {
            title: 'Original title',
            completed: 0,
            user_id: sharedUserId,
          },
          base_version: null,
        },
      ],
    });
    await clientA.engine.sync();
    await clientB.engine.sync();

    // Verify client B has the task with original title
    let taskB = await clientB.db
      .selectFrom('tasks')
      .where('id', '=', 'task-1')
      .selectAll()
      .executeTakeFirst();
    expect(taskB!.title).toBe('Original title');
    expect(taskB!.server_version).toBe(1);

    // Client A updates the task
    await enqueueOutboxCommit(clientA.db, {
      operations: [
        {
          table: 'tasks',
          row_id: 'task-1',
          op: 'upsert',
          payload: {
            title: 'Updated title',
            completed: 1,
            user_id: sharedUserId,
          },
          base_version: 1, // Current server version
        },
      ],
    });
    await clientA.engine.sync();
    await clientB.engine.sync();

    // Verify client B has the updated task
    taskB = await clientB.db
      .selectFrom('tasks')
      .where('id', '=', 'task-1')
      .selectAll()
      .executeTakeFirst();
    expect(taskB!.title).toBe('Updated title');
    expect(taskB!.completed).toBe(1);
    expect(taskB!.server_version).toBe(2);
  });

  it('deletes sync correctly', async () => {
    // Client A creates a task
    await enqueueOutboxCommit(clientA.db, {
      operations: [
        {
          table: 'tasks',
          row_id: 'task-to-delete',
          op: 'upsert',
          payload: {
            title: 'Will be deleted',
            completed: 0,
            user_id: sharedUserId,
          },
          base_version: null,
        },
      ],
    });
    await clientA.engine.sync();
    await clientB.engine.sync();

    // Verify both clients have the task
    let countA = await clientA.db
      .selectFrom('tasks')
      .select((eb) => eb.fn.count('id').as('count'))
      .executeTakeFirst();
    let countB = await clientB.db
      .selectFrom('tasks')
      .select((eb) => eb.fn.count('id').as('count'))
      .executeTakeFirst();
    expect(Number(countA!.count)).toBe(1);
    expect(Number(countB!.count)).toBe(1);

    // Client A deletes the task
    await enqueueOutboxCommit(clientA.db, {
      operations: [
        {
          table: 'tasks',
          row_id: 'task-to-delete',
          op: 'delete',
          payload: {},
          base_version: 1,
        },
      ],
    });
    await clientA.engine.sync();
    await clientB.engine.sync();

    // Verify both clients no longer have the task
    countA = await clientA.db
      .selectFrom('tasks')
      .select((eb) => eb.fn.count('id').as('count'))
      .executeTakeFirst();
    countB = await clientB.db
      .selectFrom('tasks')
      .select((eb) => eb.fn.count('id').as('count'))
      .executeTakeFirst();
    expect(Number(countA!.count)).toBe(0);
    expect(Number(countB!.count)).toBe(0);
  });

  it('clients with different user IDs do NOT see each other data', async () => {
    // Create a third client with a different user ID
    const clientC = await createTestClient(server, {
      actorId: 'different-user',
      clientId: 'client-c',
    });
    await clientC.engine.start();

    try {
      // Client A creates a task (for shared-user scope)
      await enqueueOutboxCommit(clientA.db, {
        operations: [
          {
            table: 'tasks',
            row_id: 'task-for-shared-user',
            op: 'upsert',
            payload: {
              title: 'Shared user task',
              completed: 0,
              user_id: sharedUserId,
            },
            base_version: null,
          },
        ],
      });

      // Client C creates a task (for different-user scope)
      await enqueueOutboxCommit(clientC.db, {
        operations: [
          {
            table: 'tasks',
            row_id: 'task-for-different-user',
            op: 'upsert',
            payload: {
              title: 'Different user task',
              completed: 0,
              user_id: 'different-user',
            },
            base_version: null,
          },
        ],
      });

      // Sync all clients
      await clientA.engine.sync();
      await clientB.engine.sync();
      await clientC.engine.sync();

      // Client B should ONLY see shared-user's task
      const tasksB = await clientB.db.selectFrom('tasks').selectAll().execute();
      expect(tasksB.length).toBe(1);
      expect(tasksB[0]!.title).toBe('Shared user task');

      // Client C should ONLY see different-user's task
      const tasksC = await clientC.db.selectFrom('tasks').selectAll().execute();
      expect(tasksC.length).toBe(1);
      expect(tasksC[0]!.title).toBe('Different user task');
    } finally {
      await destroyTestClient(clientC);
    }
  });
});
