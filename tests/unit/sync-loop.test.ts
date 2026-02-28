/**
 * Tests for @syncular/client syncOnce (sync-loop)
 *
 * Covers:
 * - syncOnce pushes pending outbox commits
 * - syncOnce returns pullResponse from transport
 * - syncOnce marks outbox as acked on `status: 'applied'`
 * - syncOnce marks outbox as failed on non-retriable rejection
 * - syncOnce marks outbox as pending on retriable error
 * - syncOnce with no outbox commits still pulls
 * - syncOnce with empty subscriptions
 * - maxPushCommits limits push iterations
 * - maxPullRounds limits pull iterations
 * - syncOnce handles transport error gracefully (throws)
 */

import { beforeEach, describe, expect, it } from 'bun:test';
import {
  createClientHandlerCollection,
  enqueueOutboxCommit,
  ensureClientSyncSchema,
  type SyncClientDb,
  syncOnce,
} from '@syncular/client';
import {
  createDatabase,
  type SyncCombinedRequest,
  type SyncCombinedResponse,
  type SyncPullResponse,
  type SyncPushResponse,
  type SyncTransport,
} from '@syncular/core';
import { createBunSqliteDialect } from '@syncular/dialect-bun-sqlite';
import type { Kysely } from 'kysely';
import { sql } from 'kysely';

let db: Kysely<SyncClientDb>;

beforeEach(async () => {
  db = createDatabase<SyncClientDb>({
    dialect: createBunSqliteDialect({ path: ':memory:' }),
    family: 'sqlite',
  });
  await ensureClientSyncSchema(db);
});

const validOps = [
  {
    table: 'tasks',
    row_id: 'row-1',
    op: 'upsert' as const,
    payload: { title: 'Hello' },
    base_version: null,
  },
];

const handlers = createClientHandlerCollection<SyncClientDb>([]);

function createMockTransport(opts?: {
  pushResponse?: SyncPushResponse;
  pullResponse?: SyncPullResponse;
  syncImpl?: (request: SyncCombinedRequest) => Promise<SyncCombinedResponse>;
}): SyncTransport & {
  calls: Array<{
    clientId: string;
    push?: SyncCombinedRequest['push'];
    pull?: SyncCombinedRequest['pull'];
  }>;
} {
  const calls: Array<{
    clientId: string;
    push?: SyncCombinedRequest['push'];
    pull?: SyncCombinedRequest['pull'];
  }> = [];
  return {
    calls,
    async sync(request) {
      calls.push({
        clientId: request.clientId,
        push: request.push,
        pull: request.pull,
      });

      if (opts?.syncImpl) {
        return opts.syncImpl(request);
      }

      return {
        ok: true,
        push: request.push
          ? (opts?.pushResponse ?? {
              ok: true,
              status: 'applied',
              commitSeq: 1,
              results: request.push.operations.map((_: unknown, i: number) => ({
                opIndex: i,
                status: 'applied' as const,
              })),
            })
          : undefined,
        pull: request.pull
          ? (opts?.pullResponse ?? {
              ok: true,
              subscriptions: [],
            })
          : undefined,
      };
    },
    async fetchSnapshotChunk() {
      return new Uint8Array();
    },
  };
}

const baseOptions = {
  clientId: 'test-client',
  subscriptions: [{ id: 'sub-1', table: 'tasks', scopes: {} }],
};

describe('syncOnce', () => {
  it('pushes pending outbox commits', async () => {
    await enqueueOutboxCommit(db, { operations: validOps });
    const transport = createMockTransport();

    const result = await syncOnce(db, transport, handlers, baseOptions);

    expect(result.pushedCommits).toBe(1);
    // First call: combined push+pull. No more outbox commits, so no additional push calls.
    expect(transport.calls.length).toBe(1);
    expect(transport.calls[0]!.push).toBeTruthy();
    expect(transport.calls[0]!.push!.operations).toEqual(validOps);
  });

  it('returns pullResponse from transport', async () => {
    const pullResponse: SyncPullResponse = {
      ok: true,
      subscriptions: [
        {
          id: 'sub-1',
          status: 'active',
          scopes: {},
          bootstrap: false,
          nextCursor: 5,
          commits: [],
        },
      ],
    };
    const transport = createMockTransport({ pullResponse });

    const result = await syncOnce(db, transport, handlers, baseOptions);

    expect(result.pullResponse.ok).toBe(true);
    expect(result.pullResponse.subscriptions.length).toBe(1);
    expect(result.pullResponse.subscriptions[0]!.nextCursor).toBe(5);
    expect(result.pullRounds).toBe(1);
  });

  it('marks outbox as acked on status: applied', async () => {
    const { id } = await enqueueOutboxCommit(db, { operations: validOps });
    const transport = createMockTransport({
      pushResponse: {
        ok: true,
        status: 'applied',
        commitSeq: 42,
        results: [{ opIndex: 0, status: 'applied' }],
      },
    });

    await syncOnce(db, transport, handlers, baseOptions);

    const rows = await sql<{
      id: string;
      status: string;
      acked_commit_seq: number | null;
    }>`select id, status, acked_commit_seq from sync_outbox_commits where id = ${id}`.execute(
      db
    );

    expect(rows.rows.length).toBe(1);
    expect(rows.rows[0]!.status).toBe('acked');
    expect(rows.rows[0]!.acked_commit_seq).toBe(42);
  });

  it('marks outbox as failed on non-retriable rejection', async () => {
    const { id } = await enqueueOutboxCommit(db, { operations: validOps });
    const transport = createMockTransport({
      pushResponse: {
        ok: true,
        status: 'rejected',
        results: [
          {
            opIndex: 0,
            status: 'conflict',
            message: 'Version mismatch',
            server_version: 2,
            server_row: { title: 'Server version' },
          },
        ],
      },
    });

    await syncOnce(db, transport, handlers, baseOptions);

    const rows = await sql<{
      id: string;
      status: string;
      error: string | null;
    }>`select id, status, error from sync_outbox_commits where id = ${id}`.execute(
      db
    );

    expect(rows.rows.length).toBe(1);
    expect(rows.rows[0]!.status).toBe('failed');
    expect(rows.rows[0]!.error).toBe('REJECTED');
  });

  it('marks outbox as pending on retriable error', async () => {
    const { id } = await enqueueOutboxCommit(db, { operations: validOps });
    const transport = createMockTransport({
      pushResponse: {
        ok: true,
        status: 'rejected',
        results: [
          {
            opIndex: 0,
            status: 'error',
            error: 'Temporary failure',
            retriable: true,
          },
        ],
      },
    });

    await syncOnce(db, transport, handlers, baseOptions);

    const rows = await sql<{
      id: string;
      status: string;
      error: string | null;
    }>`select id, status, error from sync_outbox_commits where id = ${id}`.execute(
      db
    );

    expect(rows.rows.length).toBe(1);
    // The commit stays pending because all errors are retriable
    expect(rows.rows[0]!.status).toBe('pending');
    expect(rows.rows[0]!.error).toContain('Retriable');
  });

  it('with no outbox commits still pulls', async () => {
    const pullResponse: SyncPullResponse = {
      ok: true,
      subscriptions: [
        {
          id: 'sub-1',
          status: 'active',
          scopes: {},
          bootstrap: false,
          nextCursor: 10,
          commits: [],
        },
      ],
    };
    const transport = createMockTransport({ pullResponse });

    const result = await syncOnce(db, transport, handlers, baseOptions);

    expect(result.pushedCommits).toBe(0);
    expect(result.pullRounds).toBe(1);
    expect(result.pullResponse.subscriptions.length).toBe(1);
    // No push payload should have been sent
    expect(transport.calls[0]!.push).toBeUndefined();
    expect(transport.calls[0]!.pull).toBeTruthy();
  });

  it('with empty subscriptions', async () => {
    const transport = createMockTransport();

    const result = await syncOnce(db, transport, handlers, {
      clientId: 'test-client',
      subscriptions: [],
    });

    expect(result.pushedCommits).toBe(0);
    expect(result.pullRounds).toBe(1);
    expect(result.pullResponse.subscriptions).toEqual([]);
  });

  it('maxPushCommits limits push iterations', async () => {
    // Enqueue 5 commits
    for (let i = 0; i < 5; i++) {
      await enqueueOutboxCommit(db, {
        operations: [
          {
            table: 'tasks',
            row_id: `row-${i}`,
            op: 'upsert' as const,
            payload: { title: `Task ${i}` },
            base_version: null,
          },
        ],
        nowMs: 1000 + i,
      });
    }

    const transport = createMockTransport();

    const result = await syncOnce(db, transport, handlers, {
      ...baseOptions,
      maxPushCommits: 2,
    });

    // Should push at most 2: 1 in the combined call + 1 in settle
    expect(result.pushedCommits).toBe(2);

    // Verify remaining commits are still pending/sending
    const remaining = await sql<{
      status: string;
    }>`select status from sync_outbox_commits where status in ('pending', 'sending')`.execute(
      db
    );
    expect(remaining.rows.length).toBe(3);
  });

  it('maxPullRounds limits pull iterations', async () => {
    let callCount = 0;
    const transport = createMockTransport({
      syncImpl: async (request) => {
        callCount++;
        return {
          ok: true,
          push: undefined,
          pull: request.pull
            ? {
                ok: true,
                subscriptions: [
                  {
                    id: 'sub-1',
                    status: 'active' as const,
                    scopes: {},
                    // Always say bootstrap=true so the loop wants another round
                    bootstrap: true,
                    bootstrapState: {
                      asOfCommitSeq: 1,
                      tables: ['tasks'],
                      tableIndex: 0,
                      rowCursor: `cursor-${callCount}`,
                    },
                    nextCursor: callCount,
                    commits: [],
                    snapshots: [],
                  },
                ],
              }
            : undefined,
        };
      },
    });

    const result = await syncOnce(db, transport, handlers, {
      ...baseOptions,
      maxPullRounds: 3,
    });

    // Should be limited to 3 pull rounds total (1 initial + 2 more)
    expect(result.pullRounds).toBeLessThanOrEqual(3);
    // Verify multiple calls were made
    expect(transport.calls.length).toBeGreaterThan(1);
    expect(transport.calls.length).toBeLessThanOrEqual(3);
  });

  it('handles transport error gracefully (throws)', async () => {
    await enqueueOutboxCommit(db, { operations: validOps });

    const transport = createMockTransport({
      syncImpl: async () => {
        throw new Error('Network failure');
      },
    });

    await expect(
      syncOnce(db, transport, handlers, baseOptions)
    ).rejects.toThrow('Network failure');

    // In syncOnceCombined, the transport error propagates without catching,
    // so the outbox commit stays in 'sending' status (it was claimed atomically
    // by getNextSendableOutboxCommit before the transport call).
    // A subsequent syncOnce will reclaim it once the stale timeout expires.
    const rows = await sql<{
      status: string;
    }>`select status from sync_outbox_commits`.execute(db);

    expect(rows.rows.length).toBe(1);
    expect(rows.rows[0]!.status).toBe('sending');
  });
});
