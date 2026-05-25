import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import {
  createDatabase,
  decodeBinarySyncPack,
  isBinarySyncPackContentType,
  type SyncCombinedResponse,
} from '@syncular/core';
import {
  createServerHandler,
  ensureSyncSchema,
  type SyncCoreDb,
} from '@syncular/server';
import { Hono } from 'hono';
import { type Kysely, sql } from 'kysely';
import { createBunSqliteDialect } from '../../../dialect-bun-sqlite/src';
import { createSqliteServerDialect } from '../../../server-dialect-sqlite/src';
import { createSyncRoutes } from '../routes';

interface TasksTable {
  id: string;
  user_id: string;
  title: string;
  server_version: number;
}

interface ServerDb extends SyncCoreDb {
  tasks: TasksTable;
}

interface ClientDb {
  tasks: TasksTable;
}

async function readCombinedResponse(
  response: Response
): Promise<SyncCombinedResponse> {
  if (isBinarySyncPackContentType(response.headers.get('content-type'))) {
    return decodeBinarySyncPack(new Uint8Array(await response.arrayBuffer()));
  }
  return (await response.json()) as SyncCombinedResponse;
}

describe('createSyncRoutes audit endpoints', () => {
  let db: Kysely<ServerDb>;
  const dialect = createSqliteServerDialect();

  beforeEach(async () => {
    db = createDatabase<ServerDb>({
      dialect: createBunSqliteDialect({ path: ':memory:' }),
      family: 'sqlite',
    });
    await ensureSyncSchema(db, dialect);

    await db.schema
      .createTable('tasks')
      .addColumn('id', 'text', (col) => col.primaryKey())
      .addColumn('user_id', 'text', (col) => col.notNull())
      .addColumn('title', 'text', (col) => col.notNull())
      .addColumn('server_version', 'integer', (col) =>
        col.notNull().defaultTo(0)
      )
      .execute();
  });

  afterEach(async () => {
    await db.destroy();
  });

  const tasksHandler = createServerHandler<ServerDb, ClientDb, 'tasks'>({
    table: 'tasks',
    scopes: ['user:{user_id}'],
    resolveScopes: async (ctx) => ({ user_id: [ctx.actorId] }),
  });

  function createApp() {
    const routes = createSyncRoutes({
      db,
      dialect,
      handlers: [tasksHandler],
      authenticate: async (c) => {
        const actorId = c.req.header('x-user-id') ?? 'u1';
        const partitionId = c.req.header('x-partition-id') ?? 'p1';
        if (actorId === 'anon') return null;
        return { actorId, partitionId };
      },
    });

    const app = new Hono();
    app.route('/sync', routes);
    return app;
  }

  async function pushCommit(args: {
    app: Hono;
    actorId: string;
    partitionId?: string;
    clientId: string;
    clientCommitId: string;
    rowId: string;
    title: string;
  }): Promise<number> {
    const response = await args.app.request('http://localhost/sync', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-user-id': args.actorId,
        'x-partition-id': args.partitionId ?? 'p1',
      },
      body: JSON.stringify({
        clientId: args.clientId,
        push: {
          commits: [
            {
              clientCommitId: args.clientCommitId,
              schemaVersion: 1,
              operations: [
                {
                  table: 'tasks',
                  row_id: args.rowId,
                  op: 'upsert',
                  base_version: null,
                  payload: {
                    id: args.rowId,
                    user_id: args.actorId,
                    title: args.title,
                    server_version: 0,
                  },
                },
              ],
            },
          ],
        },
      }),
    });

    expect(response.status).toBe(200);
    const json = await readCombinedResponse(response);
    expect(json.push?.commits?.[0]?.status).toBe('applied');
    expect(typeof json.push?.commits?.[0]?.commitSeq).toBe('number');
    return json.push!.commits![0]!.commitSeq!;
  }

  it('lists commits with pagination and actor filter', async () => {
    const app = createApp();

    await pushCommit({
      app,
      actorId: 'u1',
      clientId: 'client-1',
      clientCommitId: 'commit-1',
      rowId: 't1',
      title: 'Task 1',
    });
    await pushCommit({
      app,
      actorId: 'u2',
      clientId: 'client-2',
      clientCommitId: 'commit-2',
      rowId: 't2',
      title: 'Task 2',
    });

    const page1 = await app.request(
      'http://localhost/sync/audit/commits?limit=1',
      {
        headers: {
          'x-user-id': 'u1',
          'x-partition-id': 'p1',
        },
      }
    );
    expect(page1.status).toBe(200);
    const page1Json = (await page1.json()) as {
      ok: boolean;
      commits: Array<{ actorId: string; commitSeq: number }>;
      nextCursor: number | null;
    };
    expect(page1Json.ok).toBe(true);
    expect(page1Json.commits).toHaveLength(1);
    expect(page1Json.nextCursor).not.toBeNull();

    const actorFiltered = await app.request(
      'http://localhost/sync/audit/commits?actorId=u1',
      {
        headers: {
          'x-user-id': 'u1',
          'x-partition-id': 'p1',
        },
      }
    );
    expect(actorFiltered.status).toBe(200);
    const actorJson = (await actorFiltered.json()) as {
      commits: Array<{ actorId: string }>;
    };
    expect(actorJson.commits).toHaveLength(1);
    expect(actorJson.commits[0]?.actorId).toBe('u1');
  });

  it('returns commit details scoped to partition', async () => {
    const app = createApp();

    const commitSeq = await pushCommit({
      app,
      actorId: 'u1',
      clientId: 'client-1',
      clientCommitId: 'commit-detail-1',
      rowId: 't-detail',
      title: 'Detail Task',
    });

    const detailResponse = await app.request(
      `http://localhost/sync/audit/commits/${commitSeq}`,
      {
        headers: {
          'x-user-id': 'u1',
          'x-partition-id': 'p1',
        },
      }
    );

    expect(detailResponse.status).toBe(200);
    const detail = (await detailResponse.json()) as {
      ok: boolean;
      commit: { commitSeq: number; actorId: string };
      changes: Array<{
        table: string;
        rowId: string;
        op: string;
        fields: string[];
        rowJson?: unknown;
      }>;
    };
    expect(detail.ok).toBe(true);
    expect(detail.commit.commitSeq).toBe(commitSeq);
    expect(detail.commit.actorId).toBe('u1');
    expect(detail.changes).toHaveLength(1);
    expect(detail.changes[0]).toMatchObject({
      table: 'tasks',
      rowId: 't-detail',
      op: 'upsert',
    });
    expect(detail.changes[0]?.fields).toEqual([
      'id',
      'server_version',
      'title',
      'user_id',
    ]);
    expect(detail.changes[0]).not.toHaveProperty('rowJson');

    const wrongPartition = await app.request(
      `http://localhost/sync/audit/commits/${commitSeq}`,
      {
        headers: {
          'x-user-id': 'u1',
          'x-partition-id': 'p2',
        },
      }
    );
    expect(wrongPartition.status).toBe(404);
  });

  it('does not leak commit detail changes outside actor scopes', async () => {
    const app = createApp();

    const commitSeq = await pushCommit({
      app,
      actorId: 'u2',
      clientId: 'client-secret',
      clientCommitId: 'commit-secret',
      rowId: 't-secret-commit',
      title: 'Secret Commit Task',
    });

    const response = await app.request(
      `http://localhost/sync/audit/commits/${commitSeq}`,
      {
        headers: {
          'x-user-id': 'u1',
          'x-partition-id': 'p1',
        },
      }
    );

    expect(response.status).toBe(404);
    const bodyText = await response.text();
    expect(bodyText).not.toContain('Secret Commit Task');
    expect(bodyText).not.toContain('commit-secret');
  });

  it('returns redacted row history scoped to actor scopes', async () => {
    const app = createApp();

    const firstCommitSeq = await pushCommit({
      app,
      actorId: 'u1',
      clientId: 'client-1',
      clientCommitId: 'row-history-1',
      rowId: 't-history',
      title: 'History Task 1',
    });
    const secondCommitSeq = await pushCommit({
      app,
      actorId: 'u1',
      clientId: 'client-1',
      clientCommitId: 'row-history-2',
      rowId: 't-history',
      title: 'History Task 2',
    });

    const response = await app.request(
      'http://localhost/sync/audit/rows/tasks/t-history?limit=1',
      {
        headers: {
          'x-user-id': 'u1',
          'x-partition-id': 'p1',
        },
      }
    );

    expect(response.status).toBe(200);
    const history = (await response.json()) as {
      ok: boolean;
      table: string;
      rowId: string;
      history: Array<{
        commitSeq: number;
        clientCommitId: string;
        fields: string[];
        scopeFields: string[];
        changeKind: string;
        sensitiveFields: string[];
        redaction: { payload: string; reason: string };
      }>;
      nextCursor: number | null;
      rowJson?: unknown;
    };
    expect(history.ok).toBe(true);
    expect(history.table).toBe('tasks');
    expect(history.rowId).toBe('t-history');
    expect(history.history).toHaveLength(1);
    expect(history.history[0]).toMatchObject({
      commitSeq: secondCommitSeq,
      clientCommitId: 'row-history-2',
    });
    expect(history.history[0]?.fields).toEqual([
      'id',
      'server_version',
      'title',
      'user_id',
    ]);
    expect(history.history[0]?.scopeFields).toEqual(['user_id']);
    expect(history.history[0]?.changeKind).toBe('app_row');
    expect(history.history[0]?.sensitiveFields).toEqual([]);
    expect(history.history[0]?.redaction).toEqual({
      payload: 'omitted',
      reason: 'audit_redacted_by_default',
    });
    expect(history).not.toHaveProperty('rowJson');
    expect(history.nextCursor).toBe(secondCommitSeq);

    const olderPage = await app.request(
      `http://localhost/sync/audit/rows/tasks/t-history?beforeCommitSeq=${history.nextCursor}`,
      {
        headers: {
          'x-user-id': 'u1',
          'x-partition-id': 'p1',
        },
      }
    );
    expect(olderPage.status).toBe(200);
    const olderHistory = (await olderPage.json()) as {
      history: Array<{ commitSeq: number; clientCommitId: string }>;
      nextCursor: number | null;
    };
    expect(olderHistory.history).toHaveLength(1);
    expect(olderHistory.history[0]).toMatchObject({
      commitSeq: firstCommitSeq,
      clientCommitId: 'row-history-1',
    });
    expect(olderHistory.nextCursor).toBeNull();
  });

  it('does not leak unauthorized row history across actor scopes', async () => {
    const app = createApp();

    await pushCommit({
      app,
      actorId: 'u1',
      clientId: 'client-1',
      clientCommitId: 'row-history-secret',
      rowId: 't-secret',
      title: 'Secret Task',
    });

    const response = await app.request(
      'http://localhost/sync/audit/rows/tasks/t-secret',
      {
        headers: {
          'x-user-id': 'u2',
          'x-partition-id': 'p1',
        },
      }
    );

    expect(response.status).toBe(404);
    const bodyText = await response.text();
    expect(bodyText).not.toContain('Secret Task');
    expect(bodyText).not.toContain('row-history-secret');
  });

  it('exports a redacted actor-scoped debug bundle', async () => {
    const app = createApp();

    const visibleCommitSeq = await pushCommit({
      app,
      actorId: 'u1',
      clientId: 'client-visible',
      clientCommitId: 'debug-visible',
      rowId: 'debug-visible-row',
      title: 'Visible Debug Payload',
    });
    await pushCommit({
      app,
      actorId: 'u2',
      clientId: 'client-hidden',
      clientCommitId: 'debug-hidden',
      rowId: 'debug-hidden-row',
      title: 'Hidden Debug Payload',
    });

    await dialect.ensureConsoleSchema(db);
    await sql`
      INSERT INTO sync_request_events (
        partition_id, request_id, trace_id, span_id,
        event_type, sync_path, actor_id, client_id, transport_path,
        status_code, outcome, response_status, error_code,
        duration_ms, commit_seq, operation_count, row_count,
        subscription_count, scopes_summary, tables, created_at
      ) VALUES
        (
          'p1', 'request-visible', 'trace-visible', null,
          'sync', 'http-combined', 'u1', 'client-visible', 'direct',
          200, 'visible-ok', 'applied', null,
          12, ${visibleCommitSeq}, 1, 1,
          0, ${JSON.stringify({ user_id: 'u1' })}, ${JSON.stringify(['tasks'])},
          '2026-05-21T10:00:00.000Z'
        ),
        (
          'p1', 'request-hidden', 'trace-hidden', null,
          'sync', 'http-combined', 'u2', 'client-hidden', 'direct',
          200, 'hidden-secret-outcome', 'applied', null,
          13, ${visibleCommitSeq + 1}, 1, 1,
          0, ${JSON.stringify({ user_id: 'u2' })}, ${JSON.stringify(['tasks'])},
          '2026-05-21T10:00:01.000Z'
        )
    `.execute(db);

    const response = await app.request(
      'http://localhost/sync/audit/debug/export?limitCommits=10&limitEvents=10',
      {
        headers: {
          'x-user-id': 'u1',
          'x-partition-id': 'p1',
        },
      }
    );

    expect(response.status).toBe(200);
    const debugExport = (await response.json()) as {
      ok: boolean;
      partitionId: string;
      commits: Array<{
        commitSeq: number;
        clientCommitId: string;
        changes: Array<{
          rowId: string;
          redaction: { payload: string; reason: string };
          rowJson?: unknown;
          scopes?: unknown;
        }>;
      }>;
      requestEvents: Array<{
        actorId: string;
        requestId: string;
        scopesSummary: Record<string, string | string[]> | null;
      }>;
    };
    expect(debugExport.ok).toBe(true);
    expect(debugExport.partitionId).toBe('p1');
    expect(debugExport.commits).toHaveLength(1);
    expect(debugExport.commits[0]).toMatchObject({
      commitSeq: visibleCommitSeq,
      clientCommitId: 'debug-visible',
    });
    expect(debugExport.commits[0]?.changes).toHaveLength(1);
    expect(debugExport.commits[0]?.changes[0]).not.toHaveProperty('rowJson');
    expect(debugExport.commits[0]?.changes[0]).not.toHaveProperty('scopes');
    expect(debugExport.commits[0]?.changes[0]?.redaction).toEqual({
      payload: 'omitted',
      reason: 'audit_redacted_by_default',
    });
    expect(debugExport.requestEvents).toHaveLength(1);
    expect(debugExport.requestEvents[0]).toMatchObject({
      actorId: 'u1',
      requestId: 'request-visible',
      scopesSummary: { user_id: 'u1' },
    });

    const serialized = JSON.stringify(debugExport);
    expect(serialized).not.toContain('Visible Debug Payload');
    expect(serialized).not.toContain('Hidden Debug Payload');
    expect(serialized).not.toContain('debug-hidden');
    expect(serialized).not.toContain('request-hidden');
    expect(serialized).not.toContain('hidden-secret-outcome');
  });

  it('requires authentication for audit endpoints', async () => {
    const app = createApp();

    const response = await app.request('http://localhost/sync/audit/commits', {
      headers: {
        'x-user-id': 'anon',
      },
    });

    expect(response.status).toBe(401);

    const debugExportResponse = await app.request(
      'http://localhost/sync/audit/debug/export',
      {
        headers: {
          'x-user-id': 'anon',
        },
      }
    );

    expect(debugExportResponse.status).toBe(401);
  });
});
