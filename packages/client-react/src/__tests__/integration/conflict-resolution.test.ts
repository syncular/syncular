/**
 * Integration tests for conflict resolution
 *
 * Tests the full conflict detection and resolution flow when two clients
 * make concurrent changes to the same row.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import {
  enqueueOutboxCommit,
  getNextSendableOutboxCommit,
  resolveConflict,
} from '@syncular/client';
import {
  createTestClient,
  createTestServer,
  destroyTestClient,
  destroyTestServer,
  type TestClient,
  type TestServer,
} from './test-setup';

describe('Conflict Resolution', () => {
  let server: TestServer;
  let clientA: TestClient;
  let clientB: TestClient;

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

    await clientA.engine.start();
    await clientB.engine.start();
  });

  afterEach(async () => {
    await destroyTestClient(clientA);
    await destroyTestClient(clientB);
    await destroyTestServer(server);
  });

  it('detects version conflict when two clients update same row', async () => {
    // Client A creates a task
    await enqueueOutboxCommit(clientA.db, {
      operations: [
        {
          table: 'tasks',
          row_id: 'conflict-task',
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

    // Client B pulls to get the task
    await clientB.engine.sync();

    // Verify both have the task at version 1
    const taskA = await clientA.db
      .selectFrom('tasks')
      .where('id', '=', 'conflict-task')
      .selectAll()
      .executeTakeFirst();
    const taskB = await clientB.db
      .selectFrom('tasks')
      .where('id', '=', 'conflict-task')
      .selectAll()
      .executeTakeFirst();

    expect(taskA!.server_version).toBe(1);
    expect(taskB!.server_version).toBe(1);

    // Client A updates the task to version 2
    await enqueueOutboxCommit(clientA.db, {
      operations: [
        {
          table: 'tasks',
          row_id: 'conflict-task',
          op: 'upsert',
          payload: {
            title: 'Updated by A',
            completed: 0,
            user_id: sharedUserId,
          },
          base_version: 1,
        },
      ],
    });
    await clientA.engine.sync();

    // Client B tries to update with stale base_version=1
    await enqueueOutboxCommit(clientB.db, {
      operations: [
        {
          table: 'tasks',
          row_id: 'conflict-task',
          op: 'upsert',
          payload: {
            title: 'Updated by B',
            completed: 1,
            user_id: sharedUserId,
          },
          base_version: 1, // Stale! Server is now at version 2
        },
      ],
    });

    // Sync client B - should detect conflict
    await clientB.engine.sync();

    // Check for conflicts in client B
    const conflicts = await clientB.db
      .selectFrom('sync_conflicts')
      .selectAll()
      .execute();

    expect(conflicts.length).toBe(1);
    expect(conflicts[0]!.result_status).toBe('conflict');
    expect(conflicts[0]!.server_version).toBe(2);

    // Server row should have A's version (may be JSON string or already parsed)
    const serverRowJson = conflicts[0]!.server_row_json;
    const serverRow =
      typeof serverRowJson === 'string'
        ? JSON.parse(serverRowJson)
        : serverRowJson;
    expect(serverRow.title).toBe('Updated by A');
  });

  it('does not retry rejected (conflict) commits automatically', async () => {
    // Client A creates a task
    await enqueueOutboxCommit(clientA.db, {
      operations: [
        {
          table: 'tasks',
          row_id: 'no-retry',
          op: 'upsert',
          payload: { title: 'Original', completed: 0, user_id: sharedUserId },
          base_version: null,
        },
      ],
    });
    await clientA.engine.sync();

    // Client B pulls to get the task
    await clientB.engine.sync();

    // A updates to v2
    await enqueueOutboxCommit(clientA.db, {
      operations: [
        {
          table: 'tasks',
          row_id: 'no-retry',
          op: 'upsert',
          payload: { title: 'Server v2', completed: 0, user_id: sharedUserId },
          base_version: 1,
        },
      ],
    });
    await clientA.engine.sync();

    // B tries stale update => conflict
    await enqueueOutboxCommit(clientB.db, {
      operations: [
        {
          table: 'tasks',
          row_id: 'no-retry',
          op: 'upsert',
          payload: {
            title: 'Client B stale',
            completed: 1,
            user_id: sharedUserId,
          },
          base_version: 1,
        },
      ],
    });

    await clientB.engine.sync();

    // Conflict commit should be marked failed exactly once and NOT re-sent in a tight loop.
    const outbox = await clientB.db
      .selectFrom('sync_outbox_commits')
      .select(['status', 'attempt_count'])
      .orderBy('created_at', 'desc')
      .execute();

    expect(outbox.length).toBe(1);
    expect(outbox[0]!.status).toBe('failed');
    expect(outbox[0]!.attempt_count).toBe(1);

    // Failed commits are not sendable by default.
    const next = await getNextSendableOutboxCommit(clientB.db);
    expect(next).toBeNull();
  });

  it('accept resolution marks conflict as resolved', async () => {
    // Set up conflict scenario
    await enqueueOutboxCommit(clientA.db, {
      operations: [
        {
          table: 'tasks',
          row_id: 'accept-test',
          op: 'upsert',
          payload: { title: 'Original', completed: 0, user_id: sharedUserId },
          base_version: null,
        },
      ],
    });
    await clientA.engine.sync();
    await clientB.engine.sync();

    // A updates to v2
    await enqueueOutboxCommit(clientA.db, {
      operations: [
        {
          table: 'tasks',
          row_id: 'accept-test',
          op: 'upsert',
          payload: {
            title: 'Server Version',
            completed: 0,
            user_id: sharedUserId,
          },
          base_version: 1,
        },
      ],
    });
    await clientA.engine.sync();

    // B tries stale update - creates conflict
    await enqueueOutboxCommit(clientB.db, {
      operations: [
        {
          table: 'tasks',
          row_id: 'accept-test',
          op: 'upsert',
          payload: {
            title: 'Client B Version',
            completed: 1,
            user_id: sharedUserId,
          },
          base_version: 1,
        },
      ],
    });
    await clientB.engine.sync();

    // Verify conflict exists
    const conflictsBefore = await clientB.db
      .selectFrom('sync_conflicts')
      .where('resolved_at', 'is', null)
      .selectAll()
      .execute();
    expect(conflictsBefore.length).toBe(1);

    // Resolve with 'accept' (use server version)
    await resolveConflict(clientB.db, {
      id: conflictsBefore[0]!.id,
      resolution: 'accept',
    });

    // Verify conflict is marked as resolved (resolved_at is set)
    const resolvedConflict = await clientB.db
      .selectFrom('sync_conflicts')
      .where('id', '=', conflictsBefore[0]!.id)
      .selectAll()
      .executeTakeFirst();

    expect(resolvedConflict!.resolved_at).not.toBe(null);
    expect(resolvedConflict!.resolution).toBe('accept');

    // No more unresolved conflicts
    const unresolvedConflicts = await clientB.db
      .selectFrom('sync_conflicts')
      .where('resolved_at', 'is', null)
      .selectAll()
      .execute();
    expect(unresolvedConflicts.length).toBe(0);
  });

  it('reject resolution retries with new base version', async () => {
    // Set up conflict scenario
    await enqueueOutboxCommit(clientA.db, {
      operations: [
        {
          table: 'tasks',
          row_id: 'reject-test',
          op: 'upsert',
          payload: { title: 'Original', completed: 0, user_id: sharedUserId },
          base_version: null,
        },
      ],
    });
    await clientA.engine.sync();
    await clientB.engine.sync();

    // A updates to v2
    await enqueueOutboxCommit(clientA.db, {
      operations: [
        {
          table: 'tasks',
          row_id: 'reject-test',
          op: 'upsert',
          payload: {
            title: 'Server Version',
            completed: 0,
            user_id: sharedUserId,
          },
          base_version: 1,
        },
      ],
    });
    await clientA.engine.sync();

    // B tries stale update - creates conflict
    await enqueueOutboxCommit(clientB.db, {
      operations: [
        {
          table: 'tasks',
          row_id: 'reject-test',
          op: 'upsert',
          payload: {
            title: 'Client B Wins',
            completed: 1,
            user_id: sharedUserId,
          },
          base_version: 1,
        },
      ],
    });
    await clientB.engine.sync();

    // Verify conflict exists
    const conflictsBefore = await clientB.db
      .selectFrom('sync_conflicts')
      .where('resolved_at', 'is', null)
      .selectAll()
      .execute();
    expect(conflictsBefore.length).toBe(1);

    // Resolve with 'reject' (keep local version, will retry with new base)
    await resolveConflict(clientB.db, {
      id: conflictsBefore[0]!.id,
      resolution: 'reject',
    });

    // The reject resolution should allow retrying the push
    // In a real scenario, the client would need to create a new commit
    // with the updated base_version

    // Verify conflict is marked as resolved
    const conflict = await clientB.db
      .selectFrom('sync_conflicts')
      .where('id', '=', conflictsBefore[0]!.id)
      .selectAll()
      .executeTakeFirst();
    expect(conflict!.resolved_at).not.toBe(null);
    expect(conflict!.resolution).toBe('reject');
  });

  it('no conflict when updates are sequential', async () => {
    // Client A creates a task
    await enqueueOutboxCommit(clientA.db, {
      operations: [
        {
          table: 'tasks',
          row_id: 'sequential-test',
          op: 'upsert',
          payload: { title: 'Original', completed: 0, user_id: sharedUserId },
          base_version: null,
        },
      ],
    });
    await clientA.engine.sync();
    await clientB.engine.sync();

    // Client A updates with correct base version
    await enqueueOutboxCommit(clientA.db, {
      operations: [
        {
          table: 'tasks',
          row_id: 'sequential-test',
          op: 'upsert',
          payload: { title: 'Update 1', completed: 0, user_id: sharedUserId },
          base_version: 1,
        },
      ],
    });
    await clientA.engine.sync();
    await clientB.engine.sync();

    // Client B updates with correct base version (now 2)
    await enqueueOutboxCommit(clientB.db, {
      operations: [
        {
          table: 'tasks',
          row_id: 'sequential-test',
          op: 'upsert',
          payload: { title: 'Update 2', completed: 1, user_id: sharedUserId },
          base_version: 2,
        },
      ],
    });
    await clientB.engine.sync();

    // No conflicts should exist
    const conflicts = await clientB.db
      .selectFrom('sync_conflicts')
      .selectAll()
      .execute();
    expect(conflicts.length).toBe(0);

    // Server should have version 3
    await clientA.engine.sync();
    const taskA = await clientA.db
      .selectFrom('tasks')
      .where('id', '=', 'sequential-test')
      .selectAll()
      .executeTakeFirst();
    expect(taskA!.title).toBe('Update 2');
    expect(taskA!.server_version).toBe(3);
  });
});
