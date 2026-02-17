/**
 * Compaction scenario - Tests change-log compaction over HTTP
 */

import { expect } from 'bun:test';
import { syncPullOnce } from '@syncular/client';
import {
  computePruneWatermarkCommitSeq,
  pruneSync,
  recordClientCursor,
} from '@syncular/server';
import type { ScenarioContext } from '../harness/types';

export async function runCompactionScenario(
  ctx: ScenarioContext
): Promise<void> {
  const { server } = ctx;
  const client = ctx.clients[0]!;

  const pushTask = async (
    clientCommitId: string,
    rowId: string,
    title: string
  ) => {
    const combined = await client.transport.sync({
      clientId: client.clientId,
      push: {
        clientCommitId,
        schemaVersion: 1,
        operations: [
          {
            table: 'tasks',
            row_id: rowId,
            op: 'upsert',
            payload: { title, completed: 0, project_id: 'p1' },
            base_version: null,
          },
        ],
      },
    });
    const res = combined.push!;
    expect(res.status).toBe('applied');
  };

  await pushTask('c1', 't1', 'A');
  await pushTask('c2', 't1', 'B');
  await pushTask('c3', 't1', 'C');
  await pushTask('c4', 't2', 'X');

  const before = await server.db
    .selectFrom('sync_changes')
    .select(['commit_seq', 'row_id', 'row_json'])
    .where('table', '=', 'tasks')
    .orderBy('commit_seq', 'asc')
    .execute();

  expect(before.filter((c) => c.row_id === 't1').length).toBe(3);
  expect(before.filter((c) => c.row_id === 't2').length).toBe(1);

  // Mark all commits as "old" so they fall outside the full-history window
  await server.db
    .updateTable('sync_commits')
    .set({ created_at: '2000-01-01T00:00:00.000Z' })
    .execute();

  const deleted = await server.dialect.compactChanges(server.db, {
    fullHistoryHours: 1,
  });
  expect(deleted).toBe(2);

  const after = await server.db
    .selectFrom('sync_changes')
    .select(['commit_seq', 'row_id', 'row_json'])
    .where('table', '=', 'tasks')
    .orderBy('commit_seq', 'asc')
    .execute();

  expect(after.filter((c) => c.row_id === 't1').length).toBe(1);
  expect(after.filter((c) => c.row_id === 't2').length).toBe(1);

  const t1 = after.find((c) => c.row_id === 't1');
  expect(
    typeof t1?.commit_seq === 'number' ? t1.commit_seq : Number(t1?.commit_seq)
  ).toBe(3);
  const t1Json = t1?.row_json as Record<string, unknown> | undefined;
  expect(t1Json?.title).toBe('C');
  expect(t1Json?.server_version).toBe(3);
}

export async function runCompactionPullScenario(
  ctx: ScenarioContext
): Promise<void> {
  const { server } = ctx;
  const client = ctx.clients[0]!;

  const pushTask = async (clientCommitId: string, title: string) => {
    const combined = await client.transport.sync({
      clientId: client.clientId,
      push: {
        clientCommitId,
        schemaVersion: 1,
        operations: [
          {
            table: 'tasks',
            row_id: 't1',
            op: 'upsert',
            payload: { title, completed: 0, project_id: 'p1' },
            base_version: null,
          },
        ],
      },
    });
    const res = combined.push!;
    expect(res.status).toBe('applied');
  };

  await pushTask('c1', 'A');
  await pushTask('c2', 'B');
  await pushTask('c3', 'C');

  // Mark all commits as old
  await server.db
    .updateTable('sync_commits')
    .set({ created_at: '2000-01-01T00:00:00.000Z' })
    .execute();

  const deleted = await server.dialect.compactChanges(server.db, {
    fullHistoryHours: 1,
  });
  expect(deleted).toBe(2);

  // Pull must advance past compacted empty commits
  const subP1 = {
    id: 'p1',
    table: 'tasks',
    scopes: { user_id: ctx.userId, project_id: 'p1' },
  };

  // Set cursor to 0 to simulate a fresh client
  await client.db
    .insertInto('sync_subscription_state')
    .values({
      state_id: 'default',
      subscription_id: 'p1',
      table: 'tasks',
      scopes_json: JSON.stringify({ user_id: ctx.userId, project_id: 'p1' }),
      params_json: JSON.stringify({}),
      cursor: 0,
      bootstrap_state_json: null,
      status: 'active',
      created_at: Date.now(),
      updated_at: Date.now(),
    })
    .execute();

  const res = await syncPullOnce(client.db, client.transport, client.handlers, {
    clientId: client.clientId,
    subscriptions: [subP1],
    limitCommits: 2,
  });

  const sub = res.subscriptions.find((s) => s.id === 'p1');
  // With compacted commits, the server may force a bootstrap or advance to remaining commits
  // Either way, the client should end up with the correct data
  if (!sub?.bootstrap) {
    expect(sub?.nextCursor).toBe(3);
  }
}

export async function runPruneByAgeScenario(
  ctx: ScenarioContext
): Promise<void> {
  const { server } = ctx;
  const client = ctx.clients[0]!;

  const pushTask = async (
    clientCommitId: string,
    rowId: string,
    title: string
  ) => {
    const combined = await client.transport.sync({
      clientId: client.clientId,
      push: {
        clientCommitId,
        schemaVersion: 1,
        operations: [
          {
            table: 'tasks',
            row_id: rowId,
            op: 'upsert',
            payload: { title, completed: 0, project_id: 'p1' },
            base_version: null,
          },
        ],
      },
    });
    const res = combined.push!;
    expect(res.status).toBe('applied');
  };

  await pushTask('c1', 't1', 'A');
  await pushTask('c2', 't2', 'B');
  await pushTask('c3', 't3', 'C');

  // Mark commits 1..2 as old
  await server.db
    .updateTable('sync_commits')
    .set({ created_at: '2000-01-01T00:00:00.000Z' })
    .where('commit_seq', '<', 3)
    .execute();

  // Insert a stuck client cursor at 0
  await recordClientCursor(server.db, server.dialect, {
    clientId: 'stuck-client',
    actorId: ctx.userId,
    cursor: 0,
    effectiveScopes: { user_id: ctx.userId, project_id: 'p1' },
  });

  const watermarkOnly = await computePruneWatermarkCommitSeq(server.db, {
    activeWindowMs: 24 * 60 * 60 * 1000,
    fallbackMaxAgeMs: 0,
  });
  expect(watermarkOnly).toBe(0);

  const withAgeCap = await computePruneWatermarkCommitSeq(server.db, {
    activeWindowMs: 24 * 60 * 60 * 1000,
    fallbackMaxAgeMs: 24 * 60 * 60 * 1000,
  });
  expect(withAgeCap).toBeGreaterThanOrEqual(2);

  const deletedCount = await pruneSync(server.db, {
    watermarkCommitSeq: withAgeCap,
    keepNewestCommits: 1,
  });
  expect(deletedCount).toBe(2);

  const remaining = await server.db
    .selectFrom('sync_commits')
    .select(['commit_seq'])
    .orderBy('commit_seq', 'asc')
    .execute();

  expect(remaining.length).toBe(1);
  expect(Number(remaining[0]?.commit_seq)).toBe(3);
}
