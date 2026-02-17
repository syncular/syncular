/**
 * Integration tests for avoiding "self-conflicts" on hot rows.
 *
 * This happens when UI code enqueues multiple updates quickly using the same
 * (stale) base_version value.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import {
  createIncrementingVersionPlugin,
  enqueueOutboxCommit,
} from '@syncular/client';
import {
  createTestClient,
  createTestServer,
  destroyTestClient,
  destroyTestServer,
  type TestClient,
  type TestServer,
} from './test-setup';

describe('Self-conflict avoidance', () => {
  let server: TestServer;
  let client: TestClient;

  const userId = 'self-conflict-user';

  beforeEach(async () => {
    server = await createTestServer();
    client = await createTestClient(server, {
      actorId: userId,
      clientId: 'client-a',
      plugins: [createIncrementingVersionPlugin()],
    });

    await client.engine.start();
  });

  afterEach(async () => {
    await destroyTestClient(client);
    await destroyTestServer(server);
  });

  it('advances base_version across rapid sequential updates', async () => {
    await enqueueOutboxCommit(client.db, {
      operations: [
        {
          table: 'tasks',
          row_id: 'hot-row',
          op: 'upsert',
          payload: { title: 'Hot Row', completed: 0, user_id: userId },
          base_version: null,
        },
      ],
    });
    await client.engine.sync();

    // Enqueue multiple updates that (incorrectly) all use base_version=1.
    for (let i = 0; i < 5; i++) {
      await enqueueOutboxCommit(client.db, {
        operations: [
          {
            table: 'tasks',
            row_id: 'hot-row',
            op: 'upsert',
            payload: { completed: i % 2 },
            base_version: 1,
          },
        ],
      });
    }

    await client.engine.sync();

    const conflicts = await client.db
      .selectFrom('sync_conflicts')
      .selectAll()
      .execute();
    expect(conflicts.length).toBe(0);

    const task = await client.db
      .selectFrom('tasks')
      .selectAll()
      .where('id', '=', 'hot-row')
      .executeTakeFirstOrThrow();

    // v1 after insert + 5 updates => v6
    expect(task.server_version).toBe(6);
    expect(task.completed).toBe(0);
  });
});
