import { afterEach, describe, expect, it } from 'bun:test';
import {
  newTaskOperation,
  syncularGeneratedAppSchema,
  syncularGeneratedSchemaVersion,
  taskSubscription,
} from '../../../../examples/todo-app/generated/typescript/syncular.generated';
import type {
  SyncularV2AppSchema,
  SyncularV2Client,
  SyncularV2LiveQueryEvent,
  SyncularV2UnsafeSqlClient,
} from '../types';
import {
  createHonoSyncHarness,
  type HonoSyncHarness,
} from './fixtures/hono-sync-harness';
import { syncConformance } from './fixtures/sync-conformance';

const ACTOR_A = syncConformance.actors.ownerA.actorId;
const ACTOR_B = syncConformance.actors.ownerB.actorId;
const TOKEN_A = syncConformance.actors.ownerA.token;
const TOKEN_B = syncConformance.actors.ownerB.token;

describe('Syncular v2 worker sync protocol against Hono routes', () => {
  const harnesses: HonoSyncHarness[] = [];

  afterEach(async () => {
    while (harnesses.length > 0) await harnesses.pop()!.close();
  });

  it('surfaces server client-id ownership conflicts without auth refresh', async () => {
    const scenario = syncConformance.ownerConflict;
    const sync = await createHonoSyncHarness({
      actors: [
        { actorId: ACTOR_A, token: TOKEN_A },
        { actorId: ACTOR_B, token: TOKEN_B },
      ],
    });
    harnesses.push(sync);

    const first = await sync.openWorkerClient({
      clientId: scenario.clientId,
      actorId: ACTOR_A,
      fileName: scenario.firstFileName,
      getHeaders: () => ({ authorization: TOKEN_A }),
    });
    await first.setSubscriptions([taskSubscription({ actorId: ACTOR_A })]);
    await expect(first.syncOnce()).resolves.toMatchObject({
      pushedCommits: 0,
    });

    let refreshCount = 0;
    const second = await sync.openWorkerClient({
      clientId: scenario.clientId,
      actorId: ACTOR_B,
      fileName: scenario.secondFileName,
      getHeaders: () => ({ authorization: TOKEN_B }),
      authLifecycle: {
        refreshToken: () => {
          refreshCount += 1;
          return true;
        },
      },
    });
    await second.setSubscriptions([taskSubscription({ actorId: ACTOR_B })]);

    await expect(second.syncOnce()).rejects.toThrow(
      new RegExp(scenario.expectedErrorPattern)
    );
    expect(refreshCount).toBe(scenario.expectedRefreshCount);
  });

  it('clears scoped local rows when a server subscription is revoked', async () => {
    const scenario = syncConformance.revokedSubscription;
    const sync = await createHonoSyncHarness({
      actors: [{ actorId: ACTOR_A, token: TOKEN_A }],
      seedTasks: [
        {
          id: scenario.seedTask.id,
          title: scenario.seedTask.title,
          actorId: ACTOR_A,
          serverVersion: scenario.seedTask.serverVersion,
        },
      ],
    });
    harnesses.push(sync);

    const client = await sync.openWorkerClient({
      clientId: scenario.clientId,
      actorId: ACTOR_A,
      getHeaders: () => ({ authorization: TOKEN_A }),
    });
    await client.setSubscriptions([taskSubscription({ actorId: ACTOR_A })]);
    await client.syncOnce();
    await expect(client.listTable('tasks')).resolves.toContainEqual(
      expect.objectContaining({ id: scenario.seedTask.id, user_id: ACTOR_A })
    );

    await client.setSubscriptions([
      taskSubscription({ actorId: scenario.revokedActorId }),
    ]);
    const result = await client.syncOnce();

    expect(result.subscriptions[0]).toMatchObject({
      id: syncConformance.subscription.id,
      table: syncConformance.subscription.table,
      status: scenario.expectedStatus,
      scopes: scenario.expectedScopes,
    });
    await expect(client.listTable('tasks')).resolves.toEqual([]);
  });

  it('refreshes auth headers after a rejected sync request', async () => {
    const scenario = syncConformance.authRefresh;
    const sync = await createHonoSyncHarness({
      actors: [{ actorId: ACTOR_A, token: scenario.refreshedAuthorization }],
    });
    harnesses.push(sync);

    let authorization = scenario.initialAuthorization;
    let refreshCount = 0;
    const client = await sync.openWorkerClient({
      clientId: scenario.clientId,
      actorId: ACTOR_A,
      getHeaders: () => ({ authorization }),
      authLifecycle: {
        refreshToken: () => {
          refreshCount += 1;
          authorization = scenario.refreshedAuthorization;
          return true;
        },
      },
    });
    await client.setSubscriptions([taskSubscription({ actorId: ACTOR_A })]);

    await expect(client.syncOnce()).resolves.toMatchObject({
      pushedCommits: 0,
    });
    expect(refreshCount).toBe(scenario.expectedRefreshCount);
    expect(sync.syncRouteAuthHeaders).toEqual(scenario.expectedAuthHeaders);
  });

  it('surfaces revoked sessions when auth refresh declines retry', async () => {
    const scenario = syncConformance.revokedSession;
    const sync = await createHonoSyncHarness({
      actors: [{ actorId: ACTOR_A, token: TOKEN_A }],
    });
    harnesses.push(sync);

    let refreshCount = 0;
    const retryStatuses: number[] = [];
    const client = await sync.openWorkerClient({
      clientId: scenario.clientId,
      actorId: ACTOR_A,
      getHeaders: () => ({ authorization: scenario.authorization }),
      authLifecycle: {
        refreshToken: ({ status }) => {
          expect(status).toBe(scenario.expectedStatus);
          refreshCount += 1;
          return false;
        },
        retryWithFreshToken: ({ status, refreshResult }) => {
          expect(status).toBe(scenario.expectedStatus);
          expect(refreshResult).toBe(false);
          retryStatuses.push(status);
          return false;
        },
      },
    });
    await client.setSubscriptions([taskSubscription({ actorId: ACTOR_A })]);

    await expect(client.syncOnce()).rejects.toThrow(
      new RegExp(scenario.expectedErrorPattern)
    );
    expect(refreshCount).toBe(scenario.expectedRefreshCount);
    expect(retryStatuses).toHaveLength(scenario.expectedRetryCount);
    expect(sync.syncRouteAuthHeaders).toEqual([scenario.authorization]);
  });

  it('rejects server-required schema versions newer than the Rust WASM client', async () => {
    const scenario = syncConformance.schemaVersion;
    const requiredSchemaVersion =
      syncularGeneratedSchemaVersion + scenario.futureVersionOffset;
    const sync = await createHonoSyncHarness({
      actors: [{ actorId: ACTOR_A, token: TOKEN_A }],
      requiredSchemaVersion,
    });
    harnesses.push(sync);

    const client = await sync.openWorkerClient({
      clientId: scenario.requiredFutureClientId,
      actorId: ACTOR_A,
      getHeaders: () => ({ authorization: TOKEN_A }),
    });
    await client.setSubscriptions([taskSubscription({ actorId: ACTOR_A })]);

    await expect(client.syncPull()).rejects.toThrow(
      new RegExp(scenario.expectedRequiredErrorPattern)
    );
    expect(sync.syncRouteAuthHeaders).toContain(TOKEN_A);
  });

  it('tolerates server latest schema versions newer than the Rust WASM client', async () => {
    const scenario = syncConformance.schemaVersion;
    const latestSchemaVersion =
      syncularGeneratedSchemaVersion + scenario.futureVersionOffset;
    const sync = await createHonoSyncHarness({
      actors: [{ actorId: ACTOR_A, token: TOKEN_A }],
      latestSchemaVersion,
    });
    harnesses.push(sync);

    const client = await sync.openWorkerClient({
      clientId: scenario.latestFutureClientId,
      actorId: ACTOR_A,
      getHeaders: () => ({ authorization: TOKEN_A }),
    });
    await client.setSubscriptions([taskSubscription({ actorId: ACTOR_A })]);

    await expect(client.syncPull()).resolves.toMatchObject({
      changedTables: [syncConformance.subscription.table],
      pushedCommits: 0,
      subscriptions: [
        {
          id: syncConformance.subscription.id,
          table: syncConformance.subscription.table,
          status: 'active',
        },
      ],
    });
    expect(sync.syncRouteAuthHeaders).toContain(TOKEN_A);
  });

  it('rejects future local outbox schema versions before sending HTTP pushes', async () => {
    const scenario = syncConformance.schemaVersion;
    const futureSchemaVersion =
      syncularGeneratedSchemaVersion + scenario.futureVersionOffset;
    let syncPosts = 0;
    const sync = await createHonoSyncHarness({
      actors: [{ actorId: ACTOR_A, token: TOKEN_A }],
      edgeGate: (request) => {
        const url = new URL(request.url);
        if (url.pathname === '/sync' && request.method === 'POST') {
          syncPosts += 1;
          return Response.json({
            ok: true,
            push: { ok: true, commits: [] },
          });
        }
        return null;
      },
    });
    harnesses.push(sync);

    const client = await sync.openWorkerClient({
      clientId: scenario.invalidOutboxClientId,
      actorId: ACTOR_A,
      getHeaders: () => ({ authorization: TOKEN_A }),
    });
    const localRow = {
      id: 'future-schema-task',
      title: 'Future schema task',
      completed: 0,
      user_id: ACTOR_A,
      project_id: null,
      server_version: 0,
      image: null,
      title_yjs_state: null,
    };
    await client.applyLocalOperation(
      {
        table: 'tasks',
        row_id: localRow.id,
        op: 'upsert',
        payload: localRow,
        base_version: 0,
      },
      localRow
    );
    const unsafe = client as unknown as SyncularV2UnsafeSqlClient;
    await unsafe.executeUnsafeSql(
      'update sync_outbox_commits set schema_version = ?',
      [futureSchemaVersion]
    );

    await expect(client.syncPush()).rejects.toThrow(
      new RegExp(scenario.expectedInvalidOutboxErrorPattern)
    );
    expect(syncPosts).toBe(0);
  });

  it('does not partially apply chunked snapshots when chunk fetch fails', async () => {
    const scenario = syncConformance.snapshotChunk;
    const sync = await createHonoSyncHarness({
      actors: [{ actorId: ACTOR_A, token: TOKEN_A }],
      snapshotBundleMaxBytes: 1,
      seedTasks: [
        {
          id: scenario.browserServerTask.id,
          title: scenario.browserServerTask.title,
          actorId: ACTOR_A,
        },
      ],
      edgeGate: (request) => {
        if (new URL(request.url).pathname.includes('/snapshot-chunks/')) {
          return new Response('chunk failure', { status: 500 });
        }
        return null;
      },
    });
    harnesses.push(sync);

    const client = await sync.openWorkerClient({
      clientId: scenario.failureClientId,
      actorId: ACTOR_A,
      getHeaders: () => ({ authorization: TOKEN_A }),
    });
    const localRow = {
      ...scenario.localRow,
      user_id: ACTOR_A,
    };
    await client.applyLocalOperation(
      {
        table: 'tasks',
        row_id: localRow.id,
        op: 'upsert',
        payload: localRow,
        base_version: 0,
      },
      localRow
    );
    await client.setSubscriptions([taskSubscription({ actorId: ACTOR_A })]);

    await expect(client.syncPull()).rejects.toThrow(
      new RegExp(scenario.expectedErrorPattern)
    );

    await expect(client.listTable('tasks')).resolves.toEqual([
      expect.objectContaining({
        id: scenario.localRow.id,
        title: scenario.localRow.title,
      }),
    ]);
  });

  it('keeps repeated pulls of the same server row idempotent', async () => {
    const scenario = syncConformance.repeatedPull;
    const sync = await createHonoSyncHarness({
      actors: [{ actorId: ACTOR_A, token: TOKEN_A }],
      seedTasks: [
        {
          id: scenario.task.id,
          title: scenario.task.title,
          actorId: ACTOR_A,
          serverVersion: scenario.task.serverVersion,
        },
      ],
    });
    harnesses.push(sync);

    const client = await sync.openWorkerClient({
      clientId: scenario.clientId,
      actorId: ACTOR_A,
      getHeaders: () => ({ authorization: TOKEN_A }),
    });
    await client.setSubscriptions([taskSubscription({ actorId: ACTOR_A })]);

    for (let index = 0; index < scenario.expectedPullCount; index += 1) {
      await expect(client.syncPull()).resolves.toMatchObject({
        subscriptions: [
          {
            id: syncConformance.subscription.id,
            nextCursor: scenario.expectedBrowserCursor,
          },
        ],
      });
    }

    const rows = await client.listTable('tasks');
    expect(rows).toHaveLength(scenario.expectedRowCount);
    expect(rows).toEqual([
      expect.objectContaining({
        id: scenario.task.id,
        title: scenario.task.title,
        server_version: scenario.task.serverVersion,
      }),
    ]);
    const unsafe = client as unknown as SyncularV2UnsafeSqlClient;
    const cursorRows = await unsafe.executeUnsafeSql<{
      cursor: number;
    }>(
      'select cursor from sync_subscription_state where subscription_id = ?',
      [syncConformance.subscription.id]
    );
    expect(cursorRows.rows).toEqual([
      { cursor: scenario.expectedBrowserCursor },
    ]);
  });

  it('emits ordered live-query refreshes after sync pulls and ignores duplicate unsubscribe', async () => {
    const scenario = syncConformance.liveQuery;
    const sync = await createHonoSyncHarness({
      actors: [{ actorId: ACTOR_A, token: TOKEN_A }],
    });
    harnesses.push(sync);

    const clientA = await sync.openWorkerClient({
      clientId: scenario.clientAId,
      actorId: ACTOR_A,
      getHeaders: () => ({ authorization: TOKEN_A }),
    });
    await clientA.setSubscriptions([taskSubscription({ actorId: ACTOR_A })]);
    await clientA.syncOnce();

    const snapshot = await clientA.subscribeQuery<{
      id: string;
      title: string;
      user_id: string;
    }>(scenario.querySql, [], scenario.tables);
    expect(snapshot.rows).toHaveLength(scenario.expectedInitialRows);

    const events: Array<
      SyncularV2LiveQueryEvent<{
        id: string;
        title: string;
        user_id: string;
      }>
    > = [];
    clientA.addLiveQueryListener(snapshot.id, (event) => {
      events.push(
        event as SyncularV2LiveQueryEvent<{
          id: string;
          title: string;
          user_id: string;
        }>
      );
    });

    const clientB = await sync.openWorkerClient({
      clientId: scenario.clientBId,
      actorId: ACTOR_A,
      getHeaders: () => ({ authorization: TOKEN_A }),
    });

    await pushTaskAndPull(clientB, clientA, scenario.firstTask);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      queryId: snapshot.id,
      rows: [
        {
          id: scenario.firstTask.id,
          title: scenario.firstTask.title,
          user_id: ACTOR_A,
        },
      ],
    });

    await pushTaskAndPull(clientB, clientA, scenario.secondTask);
    expect(events).toHaveLength(scenario.expectedEventsBeforeUnsubscribe);
    expect(events[1]!.version).toBeGreaterThanOrEqual(events[0]!.version);
    expect(events[1]!.rows).toEqual([
      {
        id: scenario.firstTask.id,
        title: scenario.firstTask.title,
        user_id: ACTOR_A,
      },
      {
        id: scenario.secondTask.id,
        title: scenario.secondTask.title,
        user_id: ACTOR_A,
      },
    ]);

    await expect(clientA.unsubscribeQuery(snapshot.id)).resolves.toBeUndefined();
    await expect(clientA.unsubscribeQuery(snapshot.id)).resolves.toBeUndefined();
    await pushTaskAndPull(clientB, clientA, scenario.thirdTask);
    expect(events).toHaveLength(scenario.expectedEventsAfterUnsubscribe);
  });

  it('keeps duplicate pushes acked once and does not create conflicts', async () => {
    const scenario = syncConformance.duplicatePush;
    const sync = await createHonoSyncHarness({
      actors: [{ actorId: ACTOR_A, token: TOKEN_A }],
    });
    harnesses.push(sync);

    const client = await sync.openWorkerClient({
      clientId: scenario.clientId,
      actorId: ACTOR_A,
      getHeaders: () => ({ authorization: TOKEN_A }),
    });
    const localRow = {
      ...scenario.task,
      user_id: ACTOR_A,
    };
    await client.applyLocalOperation(
      newTaskOperation({
        id: scenario.task.id,
        title: scenario.task.title,
        completed: scenario.task.completed,
        user_id: ACTOR_A,
        project_id: scenario.task.project_id,
      }),
      localRow
    );

    await expect(client.syncPush()).resolves.toMatchObject({
      pushedCommits: scenario.expectedFirstPushCommits,
    });
    await expect(client.syncPush()).resolves.toMatchObject({
      pushedCommits: scenario.expectedSecondPushCommits,
    });

    const serverRows = await sync.db
      .selectFrom('tasks')
      .select(['id', 'title', 'user_id'])
      .where('id', '=', scenario.task.id)
      .execute();
    expect(serverRows).toEqual([
      {
        id: scenario.task.id,
        title: scenario.task.title,
        user_id: ACTOR_A,
      },
    ]);
    expect(serverRows).toHaveLength(scenario.expectedServerRowCount);

    const unsafe = client as unknown as SyncularV2UnsafeSqlClient;
    const outboxRows = await unsafe.executeUnsafeSql<{ status: string }>(
      'select status from sync_outbox_commits order by created_at'
    );
    expect(outboxRows.rows).toEqual([
      { status: scenario.expectedOutboxStatus },
    ]);
    const conflictRows = await unsafe.executeUnsafeSql<{ count: number }>(
      'select count(*) as count from sync_conflicts'
    );
    expect(conflictRows.rows).toEqual([
      { count: scenario.expectedConflictCount },
    ]);
  });

  it('resolves version conflicts without retrying local changes', async () => {
    const scenario = syncConformance.conflictKeepLocal;
    const sync = await createHonoSyncHarness({
      actors: [{ actorId: ACTOR_A, token: TOKEN_A }],
      seedTasks: [
        {
          id: scenario.rowId,
          title: scenario.serverTitle,
          actorId: ACTOR_A,
          serverVersion: scenario.serverVersion,
        },
      ],
    });
    harnesses.push(sync);

    const client = await sync.openWorkerClient({
      clientId: scenario.keepServerClientId,
      actorId: ACTOR_A,
      getHeaders: () => ({ authorization: TOKEN_A }),
    });
    const localRow = {
      id: scenario.rowId,
      title: scenario.localTitle,
      completed: 0,
      user_id: ACTOR_A,
      project_id: null,
      server_version: scenario.staleBaseVersion,
      image: null,
      title_yjs_state: null,
    };
    await client.applyLocalOperation(
      {
        table: 'tasks',
        row_id: scenario.rowId,
        op: 'upsert',
        payload: {
          title: scenario.localTitle,
          completed: 0,
          user_id: ACTOR_A,
        },
        base_version: scenario.staleBaseVersion,
      },
      localRow
    );
    await expect(client.syncPush()).resolves.toMatchObject({
      pushedCommits: 0,
    });

    const conflicts = await client.conflictSummaries();
    expect(conflicts).toHaveLength(scenario.expectedInitialConflictCount);
    await expect(
      client.resolveConflict(conflicts[0]!.id, scenario.keepServerResolution)
    ).resolves.toBeUndefined();
    await expect(client.conflictSummaries()).resolves.toHaveLength(
      scenario.expectedAfterResolveConflictCount
    );
  });

  it('dismisses version conflicts without retrying local changes', async () => {
    const scenario = syncConformance.conflictKeepLocal;
    const sync = await createHonoSyncHarness({
      actors: [{ actorId: ACTOR_A, token: TOKEN_A }],
      seedTasks: [
        {
          id: scenario.rowId,
          title: scenario.serverTitle,
          actorId: ACTOR_A,
          serverVersion: scenario.serverVersion,
        },
      ],
    });
    harnesses.push(sync);

    const client = await sync.openWorkerClient({
      clientId: scenario.dismissClientId,
      actorId: ACTOR_A,
      getHeaders: () => ({ authorization: TOKEN_A }),
    });
    const localRow = {
      id: scenario.rowId,
      title: scenario.localTitle,
      completed: 0,
      user_id: ACTOR_A,
      project_id: null,
      server_version: scenario.staleBaseVersion,
      image: null,
      title_yjs_state: null,
    };
    await client.applyLocalOperation(
      {
        table: 'tasks',
        row_id: scenario.rowId,
        op: 'upsert',
        payload: {
          title: scenario.localTitle,
          completed: 0,
          user_id: ACTOR_A,
        },
        base_version: scenario.staleBaseVersion,
      },
      localRow
    );
    await expect(client.syncPush()).resolves.toMatchObject({
      pushedCommits: 0,
    });

    const conflicts = await client.conflictSummaries();
    expect(conflicts).toHaveLength(scenario.expectedInitialConflictCount);
    await expect(
      client.resolveConflict(conflicts[0]!.id, scenario.dismissResolution)
    ).resolves.toBeUndefined();
    await expect(client.conflictSummaries()).resolves.toHaveLength(
      scenario.expectedAfterResolveConflictCount
    );
    await expect(client.syncPush()).resolves.toMatchObject({
      pushedCommits: 0,
    });
  });

  it('keeps failed pushes queued until sync retry backoff is due', async () => {
    const scenario = syncConformance.retryBackoff;
    let syncPosts = 0;
    const sync = await createHonoSyncHarness({
      actors: [{ actorId: ACTOR_A, token: TOKEN_A }],
      edgeGate: (request) => {
        const url = new URL(request.url);
        if (url.pathname === '/sync' && request.method === 'POST') {
          syncPosts += 1;
          return new Response('sync unavailable', { status: 500 });
        }
        return null;
      },
    });
    harnesses.push(sync);

    const client = await sync.openWorkerClient({
      clientId: scenario.clientId,
      actorId: ACTOR_A,
      getHeaders: () => ({ authorization: TOKEN_A }),
    });
    const localRow = {
      ...scenario.localRow,
      user_id: ACTOR_A,
    };
    await client.applyLocalOperation(
      {
        table: 'tasks',
        row_id: localRow.id,
        op: 'upsert',
        payload: localRow,
        base_version: 0,
      },
      localRow
    );

    await expect(client.syncPush()).rejects.toThrow(/HTTP 500/);
    expect(syncPosts).toBe(scenario.expectedSyncPostCounts[0]);

    await expect(client.syncPush()).resolves.toMatchObject({
      pushedCommits: scenario.expectedPendingPushes,
    });
    expect(syncPosts).toBe(scenario.expectedSyncPostCounts[1]);

    await waitForRetryBackoff();
    await expect(client.syncPush()).rejects.toThrow(/HTTP 500/);
    expect(syncPosts).toBe(scenario.expectedSyncPostCounts[2]);
  });

  it('stores version conflicts from the server using the shared scenario', async () => {
    const scenario = syncConformance.conflictKeepLocal;
    const sync = await createHonoSyncHarness({
      actors: [{ actorId: ACTOR_A, token: TOKEN_A }],
      seedTasks: [
        {
          id: scenario.rowId,
          title: scenario.serverTitle,
          actorId: ACTOR_A,
          serverVersion: scenario.serverVersion,
        },
      ],
    });
    harnesses.push(sync);

    const client = await sync.openWorkerClient({
      clientId: scenario.clientId,
      actorId: ACTOR_A,
      getHeaders: () => ({ authorization: TOKEN_A }),
    });
    const localRow = {
      id: scenario.rowId,
      title: scenario.localTitle,
      completed: 0,
      user_id: ACTOR_A,
      project_id: null,
      server_version: scenario.staleBaseVersion,
      image: null,
      title_yjs_state: null,
    };
    await client.applyLocalOperation(
      {
        table: 'tasks',
        row_id: scenario.rowId,
        op: 'upsert',
        payload: {
          title: scenario.localTitle,
          completed: 0,
          user_id: ACTOR_A,
        },
        base_version: scenario.staleBaseVersion,
      },
      localRow
    );

    await expect(client.syncPush()).resolves.toMatchObject({
      pushedCommits: 0,
    });

    const conflicts = await client.conflictSummaries();
    expect(conflicts).toHaveLength(scenario.expectedInitialConflictCount);
    expect(conflicts).toEqual([
      {
        id: expect.any(String),
        clientCommitId: expect.any(String),
        opIndex: 0,
        resultStatus: 'conflict',
        code: scenario.conflictCode,
        message: scenario.browserConflictMessage,
        serverVersion: scenario.serverVersion,
        resolvedAt: null,
        resolution: null,
      },
    ]);
    await expect(
      client.retryConflictKeepLocal(conflicts[0]!.id)
    ).resolves.toEqual(expect.any(String));
    await expect(client.conflictSummaries()).resolves.toHaveLength(
      scenario.expectedAfterRetryConflictCount
    );

    await expect(client.syncPush()).resolves.toMatchObject({
      pushedCommits: scenario.expectedRetryPushCommits,
    });
    await expect(
      sync.db
        .selectFrom('tasks')
        .select(['id', 'title', 'server_version'])
        .where('id', '=', scenario.rowId)
        .executeTakeFirstOrThrow()
    ).resolves.toMatchObject({
      id: scenario.rowId,
      title: scenario.localTitle,
    });
  });

  it('encrypts pushed fields and decrypts pulled rows through the Hono server', async () => {
    const scenario = syncConformance.e2ee;
    const sync = await createHonoSyncHarness({
      actors: [{ actorId: ACTOR_A, token: TOKEN_A }],
    });
    harnesses.push(sync);

    const client = await sync.openWorkerClient({
      clientId: scenario.clientId,
      actorId: ACTOR_A,
      getHeaders: () => ({ authorization: TOKEN_A }),
    });
    await client.setFieldEncryption({
      rules: [scenario.rule],
      keys: { default: scenario.keyBase64 },
      envelopePrefix: scenario.envelopePrefix,
    });
    const localRow = {
      id: scenario.task.id,
      title: scenario.task.title,
      completed: 0,
      user_id: ACTOR_A,
      project_id: null,
      server_version: 0,
      image: null,
      title_yjs_state: null,
    };
    await client.applyLocalOperation(
      newTaskOperation({
        id: scenario.task.id,
        title: scenario.task.title,
        user_id: ACTOR_A,
      }),
      localRow
    );

    await expect(client.syncPush()).resolves.toMatchObject({
      pushedCommits: 1,
    });

    const serverRow = await sync.db
      .selectFrom('tasks')
      .select(['id', 'title'])
      .where('id', '=', scenario.task.id)
      .executeTakeFirstOrThrow();
    expect(serverRow.title.startsWith(scenario.envelopePrefix)).toBe(true);
    expect(serverRow.title).not.toContain(scenario.task.title);

    const reader = await sync.openWorkerClient({
      clientId: scenario.pullClientId,
      actorId: ACTOR_A,
      getHeaders: () => ({ authorization: TOKEN_A }),
    });
    await reader.setFieldEncryption({
      rules: [scenario.rule],
      keys: { default: scenario.keyBase64 },
      envelopePrefix: scenario.envelopePrefix,
    });
    await reader.setSubscriptions([taskSubscription({ actorId: ACTOR_A })]);
    await expect(reader.syncPull()).resolves.toMatchObject({
      pushedCommits: 0,
    });
    const rows = await reader.listTable<{
      id: string;
      title: string;
      user_id: string;
    }>('tasks');
    expect(rows).toHaveLength(scenario.expectedDecryptedRowCount);
    expect(rows).toEqual([
      expect.objectContaining({
        id: scenario.task.id,
        title: scenario.task.title,
        user_id: ACTOR_A,
      }),
    ]);
  });

  it('decrypts encrypted conflict server rows before storing local conflict metadata', async () => {
    const scenario = syncConformance.e2ee;
    const sync = await createHonoSyncHarness({
      actors: [{ actorId: ACTOR_A, token: TOKEN_A }],
    });
    harnesses.push(sync);

    const seeder = await sync.openWorkerClient({
      clientId: scenario.conflict.seedClientId,
      actorId: ACTOR_A,
      getHeaders: () => ({ authorization: TOKEN_A }),
    });
    await seeder.setFieldEncryption({
      rules: [scenario.rule],
      keys: { default: scenario.keyBase64 },
      envelopePrefix: scenario.envelopePrefix,
    });
    const seedRow = {
      id: scenario.conflict.rowId,
      title: scenario.conflict.serverTitle,
      completed: 0,
      user_id: ACTOR_A,
      project_id: null,
      server_version: 0,
      image: null,
      title_yjs_state: null,
    };
    await seeder.applyLocalOperation(
      newTaskOperation({
        id: scenario.conflict.rowId,
        title: scenario.conflict.serverTitle,
        user_id: ACTOR_A,
      }),
      seedRow
    );
    await expect(seeder.syncPush()).resolves.toMatchObject({
      pushedCommits: 1,
    });

    const encryptedServerRow = await sync.db
      .selectFrom('tasks')
      .select(['title'])
      .where('id', '=', scenario.conflict.rowId)
      .executeTakeFirstOrThrow();
    expect(encryptedServerRow.title.startsWith(scenario.envelopePrefix)).toBe(
      true
    );
    expect(encryptedServerRow.title).not.toContain(
      scenario.conflict.serverTitle
    );

    const client = await sync.openWorkerClient({
      clientId: scenario.conflict.clientId,
      actorId: ACTOR_A,
      getHeaders: () => ({ authorization: TOKEN_A }),
    });
    await client.setFieldEncryption({
      rules: [scenario.rule],
      keys: { default: scenario.keyBase64 },
      envelopePrefix: scenario.envelopePrefix,
    });
    const localRow = {
      ...seedRow,
      title: scenario.conflict.localTitle,
      server_version: scenario.conflict.staleBaseVersion,
    };
    await client.applyLocalOperation(
      {
        table: 'tasks',
        row_id: scenario.conflict.rowId,
        op: 'upsert',
        payload: {
          title: scenario.conflict.localTitle,
          completed: 0,
          user_id: ACTOR_A,
        },
        base_version: scenario.conflict.staleBaseVersion,
      },
      localRow
    );

    await expect(client.syncPush()).resolves.toMatchObject({
      pushedCommits: 0,
    });
    await expect(client.conflictSummaries()).resolves.toHaveLength(
      scenario.conflict.expectedConflictCount
    );

    const unsafe = client as unknown as SyncularV2UnsafeSqlClient;
    const conflictRows = await unsafe.executeUnsafeSql<{
      server_row_json: string;
    }>('select server_row_json from sync_conflicts');
    expect(conflictRows.rows).toHaveLength(scenario.conflict.expectedConflictCount);
    const serverRow = JSON.parse(conflictRows.rows[0]!.server_row_json) as {
      title?: string;
    };
    expect(serverRow.title).toBe(scenario.conflict.serverTitle);
    expect(conflictRows.rows[0]!.server_row_json).not.toContain(
      scenario.envelopePrefix
    );
  });

  it('decrypts encrypted rows delivered through snapshot chunks', async () => {
    const scenario = syncConformance.e2ee;
    const sync = await createHonoSyncHarness({
      actors: [{ actorId: ACTOR_A, token: TOKEN_A }],
      snapshotBundleMaxBytes: 1,
    });
    harnesses.push(sync);

    const seeder = await sync.openWorkerClient({
      clientId: scenario.chunk.seedClientId,
      actorId: ACTOR_A,
      getHeaders: () => ({ authorization: TOKEN_A }),
    });
    await seeder.setFieldEncryption({
      rules: [scenario.rule],
      keys: { default: scenario.keyBase64 },
      envelopePrefix: scenario.envelopePrefix,
    });
    const seedRow = {
      id: scenario.task.id,
      title: scenario.task.title,
      completed: 0,
      user_id: ACTOR_A,
      project_id: null,
      server_version: 0,
      image: null,
      title_yjs_state: null,
    };
    await seeder.applyLocalOperation(
      newTaskOperation({
        id: scenario.task.id,
        title: scenario.task.title,
        user_id: ACTOR_A,
      }),
      seedRow
    );
    await expect(seeder.syncPush()).resolves.toMatchObject({
      pushedCommits: 1,
    });

    const serverRow = await sync.db
      .selectFrom('tasks')
      .select(['title'])
      .where('id', '=', scenario.task.id)
      .executeTakeFirstOrThrow();
    expect(serverRow.title.startsWith(scenario.envelopePrefix)).toBe(true);

    const reader = await sync.openWorkerClient({
      clientId: scenario.chunk.clientId,
      actorId: ACTOR_A,
      getHeaders: () => ({ authorization: TOKEN_A }),
    });
    await reader.setFieldEncryption({
      rules: [scenario.rule],
      keys: { default: scenario.keyBase64 },
      envelopePrefix: scenario.envelopePrefix,
    });
    await reader.setSubscriptions([taskSubscription({ actorId: ACTOR_A })]);

    await expect(reader.syncPull()).resolves.toMatchObject({
      changedTables: [syncConformance.subscription.table],
      pushedCommits: 0,
    });
    await expect(
      reader.listTable<{ id: string; title: string }>('tasks')
    ).resolves.toEqual([
      expect.objectContaining({
        id: scenario.task.id,
        title: scenario.task.title,
      }),
    ]);
  });

  it('syncs generated BlobRef columns through Hono as app-shaped Kysely rows', async () => {
    const scenario = syncConformance.blob.referenceSync;
    const sync = await createHonoSyncHarness({
      actors: [{ actorId: ACTOR_A, token: TOKEN_A }],
    });
    harnesses.push(sync);

    const source = await sync.openWorkerDatabase({
      clientId: scenario.sourceClientId,
      actorId: ACTOR_A,
      getHeaders: () => ({ authorization: TOKEN_A }),
    });
    const bytes = new TextEncoder().encode(syncConformance.blob.browserText);
    const image = await source.blobs.store(bytes, {
      mimeType: syncConformance.blob.textMimeType,
    });
    expect(image).toEqual(scenario.image);
    await expect(source.blobs.processUploadQueue()).resolves.toEqual(
      syncConformance.blob.expectedProcessUploaded
    );

    await source.mutations.tasks.insert({
      id: scenario.task.id,
      title: scenario.task.title,
      completed: 0,
      user_id: ACTOR_A,
      project_id: null,
      server_version: 0,
      image,
      title_yjs_state: null,
    });
    await expect(source.client.syncPush()).resolves.toMatchObject({
      pushedCommits: 1,
    });

    const serverRow = await sync.db
      .selectFrom('tasks')
      .select(['id', 'image'])
      .where('id', '=', scenario.task.id)
      .executeTakeFirstOrThrow();
    expect(serverRow.id).toBe(scenario.task.id);
    expect(JSON.parse(serverRow.image!)).toEqual(image);

    const reader = await sync.openWorkerDatabase({
      clientId: scenario.readerClientId,
      actorId: ACTOR_A,
      getHeaders: () => ({ authorization: TOKEN_A }),
    });
    await reader.client.setSubscriptions([taskSubscription({ actorId: ACTOR_A })]);
    await expect(reader.client.syncPull()).resolves.toMatchObject({
      changedTables: [syncConformance.subscription.table],
      pushedCommits: 0,
    });

    await expect(
      reader.db
        .selectFrom('tasks')
        .select(['id', 'title', 'image'])
        .where('id', '=', scenario.task.id)
        .execute()
    ).resolves.toEqual([
      {
        id: scenario.task.id,
        title: scenario.task.title,
        image,
      },
    ]);
    await expect(reader.blobs.isLocal(image.hash)).resolves.toBe(false);
    const downloaded = await reader.blobs.retrieve(image);
    expect(new TextDecoder().decode(downloaded)).toBe(
      syncConformance.blob.browserText
    );
    await expect(reader.blobs.isLocal(image.hash)).resolves.toBe(true);
  });

  it('applies a generated app server-merge CRDT field through the Rust WASM worker', async () => {
    const sync = await createHonoSyncHarness({
      actors: [{ actorId: ACTOR_A, token: TOKEN_A }],
    });
    harnesses.push(sync);

    const client = await sync.openWorkerClient({
      clientId: 'client-rust-crdt-field-server-merge',
      actorId: ACTOR_A,
      getHeaders: () => ({ authorization: TOKEN_A }),
    });
    const field = {
      table: 'tasks',
      rowId: 'crdt-field-server-merge-task',
      field: 'title',
    };
    await insertBlankTask(client, field.rowId);

    await expect(client.openCrdtField(field)).resolves.toMatchObject({
      ...field,
      stateColumn: 'title_yjs_state',
      containerKey: 'title',
      rowIdField: 'id',
      kind: 'text',
      syncMode: 'server-merge',
    });

    await expect(
      client.applyCrdtFieldText({
        ...field,
        nextText: 'CRDT field title',
      })
    ).resolves.toMatchObject({ syncMode: 'server-merge' });

    await expect(client.materializeCrdtField(field)).resolves.toMatchObject({
      value: 'CRDT field title',
      stateBase64: expect.any(String),
      stateVectorBase64: expect.any(String),
    });
    await expect(client.snapshotCrdtFieldStateVector(field)).resolves.toEqual({
      stateVectorBase64: expect.any(String),
    });
    await expect(client.compactCrdtField(field)).resolves.toEqual({
      checkpointCreated: false,
      clientCommitId: null,
    });
    await expect(client.listTable('tasks')).resolves.toContainEqual(
      expect.objectContaining({
        id: field.rowId,
        title: 'CRDT field title',
        title_yjs_state: expect.any(String),
      })
    );
  });

  it('applies an encrypted update-log CRDT field through the Rust WASM worker without plaintext outbox leakage', async () => {
    const plaintext = 'Encrypted field title';
    const sync = await createHonoSyncHarness({
      actors: [{ actorId: ACTOR_A, token: TOKEN_A }],
    });
    harnesses.push(sync);

    const client = await sync.openWorkerClient({
      clientId: 'client-rust-crdt-field-encrypted',
      actorId: ACTOR_A,
      getHeaders: () => ({ authorization: TOKEN_A }),
      appSchema: encryptedTitleCrdtAppSchema(),
    });
    await client.setEncryptedCrdt({
      keys: { default: new Uint8Array(32).fill(7) },
    });
    await client.setSubscriptions([taskSubscription({ actorId: ACTOR_A })]);

    const field = {
      table: 'tasks',
      rowId: 'crdt-field-encrypted-task',
      field: 'title',
    };
    await insertBlankTask(client, field.rowId);

    await expect(client.openCrdtField(field)).resolves.toMatchObject({
      ...field,
      syncMode: 'encrypted-update-log',
      stateColumn: 'title_yjs_state',
      containerKey: 'title',
      rowIdField: 'id',
      kind: 'text',
    });

    await expect(
      client.applyCrdtFieldText({ ...field, nextText: plaintext })
    ).resolves.toMatchObject({ syncMode: 'encrypted-update-log' });
    await expect(client.materializeCrdtField(field)).resolves.toMatchObject({
      value: plaintext,
      stateBase64: expect.any(String),
      stateVectorBase64: expect.any(String),
    });
    await expect(client.listTable('tasks')).resolves.toContainEqual(
      expect.objectContaining({
        id: field.rowId,
        title: plaintext,
        title_yjs_state: expect.any(String),
      })
    );

    const unsafe = client as unknown as SyncularV2UnsafeSqlClient;
    const crdtRows = await unsafe.executeUnsafeSql<{
      ciphertext: string;
      server_seq: number | null;
    }>(
      'select ciphertext, server_seq from sync_crdt_updates where app_table = ? and row_id = ? and field_name = ?',
      [field.table, field.rowId, field.field]
    );
    expect(crdtRows.rows).toHaveLength(1);
    expect(crdtRows.rows[0]!.ciphertext).not.toContain(plaintext);

    const outboxRows = await unsafe.executeUnsafeSql<{
      operations_json: string;
    }>('select operations_json from sync_outbox_commits order by created_at');
    expect(outboxRows.rows.some((row) => row.operations_json.includes(plaintext))).toBe(
      false
    );

    await client.syncOnce();
    const ackedCrdtRows = await unsafe.executeUnsafeSql<{
      server_seq: number | null;
    }>(
      'select server_seq from sync_crdt_updates where app_table = ? and row_id = ? and field_name = ?',
      [field.table, field.rowId, field.field]
    );
    expect(ackedCrdtRows.rows).toEqual([{ server_seq: expect.any(Number) }]);

    await expect(
      client.compactCrdtField({ ...field, minUncheckpointedUpdates: 1 })
    ).resolves.toMatchObject({
      checkpointCreated: true,
      clientCommitId: expect.any(String),
    });
    await expect(client.materializeCrdtField(field)).resolves.toMatchObject({
      value: plaintext,
      stateBase64: expect.any(String),
    });
    await client.syncOnce();
    await expect(
      client.compactStorage({
        pruneEncryptedCrdtUpdates: true,
        maxEncryptedCrdtCheckpointsPerStream: 1,
      })
    ).resolves.toMatchObject({
      encryptedCrdtUpdatesDeleted: 1,
      encryptedCrdtCheckpointsDeleted: 0,
    });
    await expect(client.materializeCrdtField(field)).resolves.toMatchObject({
      value: plaintext,
      stateBase64: expect.any(String),
    });
  });
});

async function pushTaskAndPull(
  source: SyncularV2Client,
  target: SyncularV2Client,
  task: { id: string; title: string }
): Promise<void> {
  const localRow = {
    id: task.id,
    title: task.title,
    completed: 0,
    user_id: ACTOR_A,
    project_id: null,
    server_version: 0,
    image: null,
    title_yjs_state: null,
  };
  await source.applyLocalOperation(
    newTaskOperation({
      id: task.id,
      title: task.title,
      user_id: ACTOR_A,
    }),
    localRow
  );
  await expect(source.syncPush()).resolves.toMatchObject({
    pushedCommits: 1,
  });
  await target.syncPull();
}

function waitForRetryBackoff(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 1_100));
}

async function insertBlankTask(
  client: SyncularV2Client,
  id: string
): Promise<void> {
  const localRow = {
    id,
    title: '',
    completed: 0,
    user_id: ACTOR_A,
    project_id: null,
    server_version: 0,
    image: null,
    title_yjs_state: null,
  };
  await client.applyLocalOperation(
    {
      table: 'tasks',
      row_id: id,
      op: 'upsert',
      payload: localRow,
      base_version: 0,
    },
    localRow
  );
}

function encryptedTitleCrdtAppSchema(): SyncularV2AppSchema {
  return {
    ...syncularGeneratedAppSchema,
    tables: syncularGeneratedAppSchema.tables.map((table) =>
      table.name === 'tasks'
        ? {
            ...table,
            crdtYjsFields: table.crdtYjsFields.map((field) =>
              field.field === 'title'
                ? { ...field, syncMode: 'encrypted-update-log' as const }
                : field
            ),
          }
        : table
    ),
  };
}
