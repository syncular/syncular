/**
 * Relay runtime test — proves the relay server correctly forwards operations
 * between local clients and a main server.
 *
 * Runs entirely in-process (bun:sqlite + node:http, no wrangler).
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { Server as NodeServer } from 'node:http';
import { createBunSqliteDialect } from '@syncular/dialect-bun-sqlite';
import {
  createRelayRoutes,
  ensureRelaySchema,
  type RelayDatabase,
  RelayServer,
} from '@syncular/relay';
import {
  createServerHandlerCollection,
  ensureSyncSchema,
  type SyncCoreDb,
} from '@syncular/server';
import { createSqliteServerDialect } from '@syncular/server-dialect-sqlite';
import { createSyncRoutes } from '@syncular/server-hono';
import {
  createNodeHonoServer,
  createProjectScopedTasksHandler,
  createProjectScopedTasksSubscription,
  createProjectScopedTaskUpsertOperation,
  ensureProjectScopedTasksTable,
  findSubscriptionChange,
  type ProjectScopedTasksRow,
  postSyncCombinedRequest,
  postSyncPullRequest,
  postSyncPushRequest,
  subscriptionChangeRow,
} from '@syncular/testkit';
import { createHttpTransport } from '@syncular/transport-http';
import { Hono } from 'hono';
import type { Kysely } from 'kysely';
import { sql } from 'kysely';
import { getNativeFetch } from '../shared/utils';

const _fetch = getNativeFetch();

/** Random suffix so IDs are unique across test runs. */
const RUN = crypto.randomUUID().slice(0, 8);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ServerDb extends SyncCoreDb {
  tasks: ProjectScopedTasksRow;
}

interface RelayDb extends RelayDatabase {
  tasks: ProjectScopedTasksRow;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Relay runtime', () => {
  const userId = `relay-test-user-${RUN}`;
  const tasksSubId = 'sub-tasks';
  const dialect = createSqliteServerDialect();

  // Main server
  let mainDb: Kysely<ServerDb>;
  let mainApp: Hono;
  let mainHttpServer: NodeServer;
  let mainBaseUrl: string;

  // Relay server
  let relayDb: Kysely<RelayDb>;
  let relay: RelayServer<RelayDb>;
  let relayApp: Hono;
  let relayHttpServer: NodeServer;
  let relayBaseUrl: string;

  beforeAll(async () => {
    // ---- Main server ----
    mainDb = createDatabase<ServerDb>({ dialect: createBunSqliteDialect({ path: ':memory:' }), family: 'sqlite' });
    await ensureSyncSchema(mainDb, dialect);
    if (dialect.ensureConsoleSchema) {
      await dialect.ensureConsoleSchema(mainDb);
    }
    await ensureProjectScopedTasksTable(mainDb);

    mainApp = new Hono();
    const mainSyncRoutes = createSyncRoutes<ServerDb>({
      db: mainDb,
      dialect,
      handlers: [createProjectScopedTasksHandler<ServerDb>()],
      authenticate: async (c) => {
        const actorId = c.req.header('x-actor-id');
        if (!actorId) return null;
        return { actorId };
      },
      sync: { rateLimit: false },
    });
    mainApp.route('/sync', mainSyncRoutes);

    mainHttpServer = createNodeHonoServer(mainApp, { cors: false });
    await new Promise<void>((resolve) => mainHttpServer.listen(0, resolve));
    const mainAddr = mainHttpServer.address();
    const mainPort =
      typeof mainAddr === 'object' && mainAddr ? mainAddr.port : 0;
    mainBaseUrl = `http://localhost:${mainPort}`;

    // ---- Relay server ----
    relayDb = createDatabase<RelayDb>({ dialect: createBunSqliteDialect({ path: ':memory:' }), family: 'sqlite' });
    await ensureSyncSchema(relayDb, dialect);
    if (dialect.ensureConsoleSchema) {
      await dialect.ensureConsoleSchema(relayDb);
    }
    await ensureProjectScopedTasksTable(relayDb);

    const mainTransport = createHttpTransport({
      baseUrl: mainBaseUrl,
      getHeaders: () => ({ 'x-actor-id': userId }),
      fetch: _fetch,
    });

    const relayHandlers = createServerHandlerCollection<RelayDb>([
      createProjectScopedTasksHandler<RelayDb>(),
    ]);

    // Initialize relay schema without starting background processes
    // (tests use manual pullOnce/forwardOnce to avoid race conditions)
    await ensureRelaySchema(relayDb, dialect);

    relay = new RelayServer<RelayDb>({
      db: relayDb,
      dialect,
      mainServerTransport: mainTransport,
      mainServerClientId: `relay-client-${RUN}`,
      mainServerActorId: userId,
      tables: ['tasks'],
      scopes: { user_id: userId, project_id: 'p0' },
      handlers: relayHandlers,
    });

    relayApp = new Hono();
    const relayRoutes = createRelayRoutes<RelayDb>({
      db: relayDb,
      dialect,
      handlers: relayHandlers,
      realtime: relay.getRealtime(),
      authenticate: async (c) => {
        const actorId = c.req.header('x-actor-id') ?? userId;
        return { actorId };
      },
    });
    relayApp.route('/sync', relayRoutes);

    relayHttpServer = createNodeHonoServer(relayApp, { cors: false });
    await new Promise<void>((resolve) => relayHttpServer.listen(0, resolve));
    const relayAddr = relayHttpServer.address();
    const relayPort =
      typeof relayAddr === 'object' && relayAddr ? relayAddr.port : 0;
    relayBaseUrl = `http://localhost:${relayPort}`;
  });

  afterAll(async () => {
    await relay?.stop();
    await new Promise<void>((resolve, reject) =>
      relayHttpServer?.close((err) => (err ? reject(err) : resolve()))
    );
    await new Promise<void>((resolve, reject) =>
      mainHttpServer?.close((err) => (err ? reject(err) : resolve()))
    );
    await relayDb?.destroy();
    await mainDb?.destroy();
  });

  // -------------------------------------------------------------------------
  // 1. Main → relay: push to main, relay pulls, visible through relay
  // -------------------------------------------------------------------------

  it('main → relay: data flows from main to relay', async () => {
    const taskId = `relay-main-task-${RUN}`;

    // Bootstrap: do an initial pull so the relay establishes cursor with main
    await relay.pullOnce();

    // Push task directly to main server
    const { response: pushRes, json: pushJson } = await postSyncCombinedRequest(
      {
        fetch: _fetch,
        url: `${mainBaseUrl}/sync`,
        actorId: userId,
        body: {
          clientId: `main-direct-client-${RUN}`,
          push: {
            clientCommitId: `main-commit-1-${RUN}`,
            operations: [
              createProjectScopedTaskUpsertOperation({
                taskId,
                title: 'Main Server Task',
              }),
            ],
            schemaVersion: 1,
          },
        },
      }
    );

    expect(pushRes.status).toBe(200);
    expect(pushJson.push?.status).toBe('applied');

    // Relay pulls from main
    await relay.pullOnce();

    // Pull from relay HTTP endpoint
    const { response: pullRes, json: pullJson } = await postSyncPullRequest({
      fetch: _fetch,
      url: `${relayBaseUrl}/sync/pull`,
      actorId: userId,
      body: {
        clientId: `relay-local-client-${RUN}`,
        subscriptions: [
          createProjectScopedTasksSubscription({
            id: tasksSubId,
            userId,
          }),
        ],
        limitCommits: 50,
      },
    });

    expect(pullRes.status).toBe(200);
    const taskRow = subscriptionChangeRow(
      findSubscriptionChange(pullJson.subscriptions, tasksSubId, taskId)
    );
    expect(taskRow).toBeDefined();
    expect(taskRow?.title).toBe('Main Server Task');
  });

  // -------------------------------------------------------------------------
  // 2. Relay → main: push to relay, forward to main, verify in main DB
  // -------------------------------------------------------------------------

  it('relay → main: data flows from relay to main', async () => {
    const taskId = `relay-local-task-${RUN}`;

    // Push task to relay
    const { response: pushRes } = await postSyncPushRequest({
      fetch: _fetch,
      url: `${relayBaseUrl}/sync/push`,
      actorId: userId,
      body: {
        clientId: `relay-push-client-${RUN}`,
        clientCommitId: `relay-commit-1-${RUN}`,
        operations: [
          createProjectScopedTaskUpsertOperation({
            taskId,
            title: 'Relay Local Task',
          }),
        ],
        schemaVersion: 1,
      },
    });

    expect(pushRes.status).toBe(200);

    // Forward from relay to main
    await relay.forwardOnce();

    // Verify task exists in main server DB
    const result = await sql<ProjectScopedTasksRow>`
      select * from tasks where id = ${sql.val(taskId)}
    `.execute(mainDb);

    expect(result.rows.length).toBe(1);
    expect(result.rows[0]!.title).toBe('Relay Local Task');
  });

  // -------------------------------------------------------------------------
  // 3. Round-trip: push to relay + push to main, relay syncs both ways
  // -------------------------------------------------------------------------

  it('round-trip: both directions sync correctly', async () => {
    const taskA = `relay-rt-task-a-${RUN}`;
    const taskB = `relay-rt-task-b-${RUN}`;

    // Push task A to relay
    await postSyncPushRequest({
      fetch: _fetch,
      url: `${relayBaseUrl}/sync/push`,
      actorId: userId,
      body: {
        clientId: `relay-rt-client-${RUN}`,
        clientCommitId: `relay-rt-commit-a-${RUN}`,
        operations: [
          createProjectScopedTaskUpsertOperation({
            taskId: taskA,
            title: 'RT Task A (from relay)',
          }),
        ],
        schemaVersion: 1,
      },
    });

    // Forward task A to main
    await relay.forwardOnce();

    // Push task B directly to main
    await postSyncCombinedRequest({
      fetch: _fetch,
      url: `${mainBaseUrl}/sync`,
      actorId: userId,
      body: {
        clientId: `main-rt-client-${RUN}`,
        push: {
          clientCommitId: `main-rt-commit-b-${RUN}`,
          operations: [
            createProjectScopedTaskUpsertOperation({
              taskId: taskB,
              title: 'RT Task B (from main)',
            }),
          ],
          schemaVersion: 1,
        },
      },
    });

    // Relay pulls (gets task B from main, confirms task A)
    await relay.pullOnce();

    // Both tasks should be visible through relay
    const { response: pullRes, json: pullJson } = await postSyncPullRequest({
      fetch: _fetch,
      url: `${relayBaseUrl}/sync/pull`,
      actorId: userId,
      body: {
        clientId: `relay-rt-reader-${RUN}`,
        subscriptions: [
          createProjectScopedTasksSubscription({
            id: tasksSubId,
            userId,
          }),
        ],
        limitCommits: 100,
      },
    });

    expect(pullRes.status).toBe(200);
    const rowA = subscriptionChangeRow(
      findSubscriptionChange(pullJson.subscriptions, tasksSubId, taskA)
    );
    const rowB = subscriptionChangeRow(
      findSubscriptionChange(pullJson.subscriptions, tasksSubId, taskB)
    );

    expect(rowA).toBeDefined();
    expect(rowA?.title).toBe('RT Task A (from relay)');

    expect(rowB).toBeDefined();
    expect(rowB?.title).toBe('RT Task B (from main)');
  });
});
