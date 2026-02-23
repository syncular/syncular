/**
 * Integration tests for push flow
 *
 * Tests that verify the full push flow from mutation to server.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import {
  enqueueOutboxCommit,
  getClientHandlerOrThrow,
  getNextSendableOutboxCommit,
} from '@syncular/client';

import {
  createTestClient,
  createTestServer,
  destroyTestClient,
  destroyTestServer,
  type TestClient,
  type TestServer,
} from './test-setup';

describe('Push Flow', () => {
  let server: TestServer;
  let client: TestClient;

  const userId = 'test-user';

  beforeEach(async () => {
    server = await createTestServer();
    client = await createTestClient(server, {
      actorId: userId,
      clientId: 'test-client',
    });
    await client.engine.start();
  });

  afterEach(async () => {
    await destroyTestClient(client);
    await destroyTestServer(server);
  });

  it('enqueue creates outbox commit with pending status', async () => {
    // Enqueue a commit
    const result = await enqueueOutboxCommit(client.db, {
      operations: [
        {
          table: 'tasks',
          row_id: 'task-1',
          op: 'upsert',
          payload: { title: 'Test Task', completed: 0, user_id: userId },
          base_version: null,
        },
      ],
    });

    expect(result.id).toBeTruthy();
    expect(result.clientCommitId).toBeTruthy();

    // Verify the commit is in the outbox
    // Note: getNextSendableOutboxCommit atomically claims the commit, so it returns with 'sending' status
    const nextCommit = await getNextSendableOutboxCommit(client.db);
    expect(nextCommit).not.toBeNull();
    expect(nextCommit!.status).toBe('sending');
    expect(nextCommit!.operations.length).toBe(1);
  });

  it('sync pushes outbox commits to server', async () => {
    // Enqueue a commit
    await enqueueOutboxCommit(client.db, {
      operations: [
        {
          table: 'tasks',
          row_id: 'push-task-1',
          op: 'upsert',
          payload: { title: 'Pushed Task', completed: 0, user_id: userId },
          base_version: null,
        },
      ],
    });

    // Before sync, verify commit exists with pending status (using direct query to avoid claiming)
    const pendingCommit = await client.db
      .selectFrom('sync_outbox_commits')
      .selectAll()
      .where('status', '=', 'pending')
      .executeTakeFirst();
    expect(pendingCommit).not.toBeNull();

    // Sync
    const result = await client.engine.sync();
    expect(result.success).toBe(true);
    expect(result.pushedCommits).toBe(1);

    // After sync, outbox should be empty (commit acked)
    const remainingCommit = await getNextSendableOutboxCommit(client.db);
    expect(remainingCommit).toBeNull();

    // Verify task is on server
    const serverTasks = await server.db
      .selectFrom('tasks')
      .where('id', '=', 'push-task-1')
      .selectAll()
      .execute();

    expect(serverTasks.length).toBe(1);
    expect(serverTasks[0]!.title).toBe('Pushed Task');
    expect(serverTasks[0]!.server_version).toBe(1);
  });

  it('sync updates local row with server version after push', async () => {
    // First, apply the mutation locally (this is what useMutation does)
    const handler = getClientHandlerOrThrow(client.handlers, 'tasks');

    await client.db.transaction().execute(async (trx) => {
      await handler.applyChange(
        { trx },
        {
          table: 'tasks',
          row_id: 'version-test',
          op: 'upsert',
          row_json: { title: 'Local Task', completed: 0, user_id: userId },
          row_version: null, // Local optimistic - no server version yet
          scopes: { user_id: userId },
        }
      );
    });

    // Verify local row has version 0
    let localRow = await client.db
      .selectFrom('tasks')
      .where('id', '=', 'version-test')
      .selectAll()
      .executeTakeFirst();
    expect(localRow).toBeTruthy();
    expect(localRow!.server_version).toBe(0);

    // Enqueue the commit
    await enqueueOutboxCommit(client.db, {
      operations: [
        {
          table: 'tasks',
          row_id: 'version-test',
          op: 'upsert',
          payload: { title: 'Local Task', completed: 0, user_id: userId },
          base_version: null,
        },
      ],
    });

    // Sync (push + pull)
    await client.engine.sync();

    // After sync, local row should have server version
    localRow = await client.db
      .selectFrom('tasks')
      .where('id', '=', 'version-test')
      .selectAll()
      .executeTakeFirst();
    expect(localRow).toBeTruthy();
    expect(localRow!.server_version).toBe(1);
  });

  it('multiple syncs push multiple commits', async () => {
    // Enqueue first commit
    await enqueueOutboxCommit(client.db, {
      operations: [
        {
          table: 'tasks',
          row_id: 'multi-1',
          op: 'upsert',
          payload: { title: 'Task 1', completed: 0, user_id: userId },
          base_version: null,
        },
      ],
    });

    // First sync
    let result = await client.engine.sync();
    expect(result.pushedCommits).toBe(1);

    // Enqueue second commit
    await enqueueOutboxCommit(client.db, {
      operations: [
        {
          table: 'tasks',
          row_id: 'multi-2',
          op: 'upsert',
          payload: { title: 'Task 2', completed: 0, user_id: userId },
          base_version: null,
        },
      ],
    });

    // Second sync
    result = await client.engine.sync();
    expect(result.pushedCommits).toBe(1);

    // Verify both on server
    const serverTasks = await server.db
      .selectFrom('tasks')
      .where('user_id', '=', userId)
      .selectAll()
      .execute();

    expect(serverTasks.length).toBe(2);
  });

  it('outbox stats reflect pending commits', async () => {
    // Initially no pending
    let stats = await client.engine.refreshOutboxStats();
    expect(stats.pending).toBe(0);

    // Enqueue a commit
    await enqueueOutboxCommit(client.db, {
      operations: [
        {
          table: 'tasks',
          row_id: 'stats-test',
          op: 'upsert',
          payload: { title: 'Stats Task', completed: 0, user_id: userId },
          base_version: null,
        },
      ],
    });

    // Should show 1 pending
    stats = await client.engine.refreshOutboxStats();
    expect(stats.pending).toBe(1);

    // Sync
    await client.engine.sync();

    // Should show 0 pending
    stats = await client.engine.refreshOutboxStats();
    expect(stats.pending).toBe(0);
  });

  it('keeps commit pending when server returns retriable error', async () => {
    // Create a client with a transport that returns retriable errors
    const retriableClient = await createTestClient(server, {
      actorId: userId,
      clientId: 'retriable-client',
    });

    // Override the transport to return retriable errors on push
    const originalSync = retriableClient.transport.sync.bind(
      retriableClient.transport
    );
    let retriableErrorCount = 0;
    retriableClient.transport.sync = async (request) => {
      if (request.push && retriableErrorCount < 2) {
        // Return retriable error for first two push attempts
        retriableErrorCount++;
        return {
          ok: true as const,
          push: {
            ok: true as const,
            status: 'rejected' as const,
            results: request.push.operations.map((_, i) => ({
              opIndex: i,
              status: 'error' as const,
              error: 'TEMPORARY_FAILURE',
              code: 'TEMPORARY',
              retriable: true,
            })),
          },
        };
      }
      // After that, use the real transport
      return originalSync(request);
    };

    await retriableClient.engine.start();

    try {
      // Enqueue a commit
      await enqueueOutboxCommit(retriableClient.db, {
        operations: [
          {
            table: 'tasks',
            row_id: 'retriable-task',
            op: 'upsert',
            payload: { title: 'Retriable Task', completed: 0, user_id: userId },
            base_version: null,
          },
        ],
      });

      // Verify commit is pending before sync
      let stats = await retriableClient.engine.refreshOutboxStats();
      expect(stats.pending).toBe(1);
      expect(stats.failed).toBe(0);

      // First sync - will hit retriable error but commit stays pending (not failed)
      await retriableClient.engine.sync();

      // Commit should still be pending (not failed) after retriable error
      stats = await retriableClient.engine.refreshOutboxStats();
      expect(stats.failed).toBe(0);
      // Commit may still be pending since it wasn't terminal failure
      // Note: pushedCommits counts attempts, which may be > 0

      // After enough retries, the commit should eventually succeed
      // Keep syncing until successful or we've tried enough times
      for (let i = 0; i < 5 && stats.pending > 0; i++) {
        await retriableClient.engine.sync();
        stats = await retriableClient.engine.refreshOutboxStats();
      }

      // Now should be empty (commit succeeded) and no failures
      expect(stats.pending).toBe(0);
      expect(stats.failed).toBe(0);

      // Verify the retriable error was actually returned (at least twice before success)
      expect(retriableErrorCount).toBe(2);
    } finally {
      await destroyTestClient(retriableClient);
    }
  });
});
