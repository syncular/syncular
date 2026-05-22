import { afterEach, describe, expect, it } from 'bun:test';
import {
  decodeBinarySyncPack,
  isBinarySyncPackContentType,
  type SyncCombinedRequest,
  type SyncCombinedResponse,
} from '@syncular/core';
import { Kysely, sql } from 'kysely';
import {
  newTaskOperation,
  type SyncularAppDb,
  syncularGeneratedAppSchema,
  syncularGeneratedSchemaVersion,
  syncularGeneratedTableConfig,
  taskSubscription,
} from '../../../../rust/examples/todo-app/generated/typescript/syncular.generated';
import { createSyncularDialect } from '../database';
import type {
  SyncularAppSchema,
  SyncularDiagnosticEvent,
  SyncularLifecycleState,
  SyncularLiveQueryDiagnostics,
  SyncularLiveQueryEvent,
  SyncularRowsChangedEvent,
  SyncularRuntimeClient,
  SyncularUnsafeSqlClient,
} from '../types';
import { SyncularWorkerError } from '../worker-client';
import {
  createHonoSyncHarness,
  type HonoSyncHarness,
} from './fixtures/hono-sync-harness';
import { syncConformance } from './fixtures/sync-conformance';

const ACTOR_A = syncConformance.actors.ownerA.actorId;
const ACTOR_B = syncConformance.actors.ownerB.actorId;
const TOKEN_A = syncConformance.actors.ownerA.token;
const TOKEN_B = syncConformance.actors.ownerB.token;

async function readCombinedResponse(
  response: Response
): Promise<SyncCombinedResponse> {
  if (isBinarySyncPackContentType(response.headers.get('content-type'))) {
    return decodeBinarySyncPack(new Uint8Array(await response.arrayBuffer()));
  }
  return (await response.json()) as SyncCombinedResponse;
}

describe('Syncular worker sync protocol against Hono routes', () => {
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
    const firstResult = await first.syncOnce();
    expect(firstResult).toMatchObject({
      pushedCommits: 0,
    });
    expect(firstResult.bootstrap).toMatchObject({
      criticalReady: true,
      interactiveReady: true,
      complete: true,
      pendingSubscriptionIds: [],
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

    const diagnostics: SyncularDiagnosticEvent[] = [];
    const client = await sync.openWorkerClient({
      clientId: scenario.clientId,
      actorId: ACTOR_A,
      getHeaders: () => ({ authorization: TOKEN_A }),
      diagnostics: (event) => diagnostics.push(event),
    });
    await client.setSubscriptions([taskSubscription({ actorId: ACTOR_A })]);
    const lifecycleEvents: SyncularLifecycleState[] = [];
    client.addEventListener('lifecycleChanged', (event) => {
      lifecycleEvents.push(event);
    });
    await client.syncOnce();
    await expect(client.listTable('tasks')).resolves.toContainEqual(
      expect.objectContaining({ id: scenario.seedTask.id, user_id: ACTOR_A })
    );

    const dialect = createSyncularDialect(client, {
      appTables: syncularGeneratedAppSchema.tables.map((table) => table.name),
      tableConfig: syncularGeneratedTableConfig,
    });
    const db = new Kysely<SyncularAppDb>({ dialect });
    const liveEvents: Array<
      SyncularLiveQueryEvent<{ id: string; title: string }>
    > = [];

    try {
      await dialect.live(
        db
          .selectFrom('tasks')
          .select(['id', 'title'])
          .where('id', '=', scenario.seedTask.id),
        {
          onChange(rows, event) {
            liveEvents.push({ ...event, rows });
          },
        }
      );
      expect(liveEvents).toHaveLength(1);
      expect(liveEvents[0]).toMatchObject({
        initial: true,
        rows: [{ id: scenario.seedTask.id, title: scenario.seedTask.title }],
      });

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
      expect(diagnostics).toContainEqual(
        expect.objectContaining({
          code: 'sync.scope_revoked',
          details: expect.objectContaining({
            revokedSubscriptionIds: [syncConformance.subscription.id],
            revokedSubscriptionCount: 1,
          }),
        })
      );
      const revokedLifecycle = await waitForLifecycle(
        lifecycleEvents,
        (event) => event.lastDiagnostic?.code === 'sync.scope_revoked'
      );
      expect(revokedLifecycle).toMatchObject({
        lastDiagnostic: expect.objectContaining({
          code: 'sync.scope_revoked',
        }),
      });
      await expect(client.listTable('tasks')).resolves.toEqual([]);
      expect(liveEvents).toHaveLength(2);
      expect(liveEvents[1]).toMatchObject({
        initial: false,
        rows: [],
        changedRows: [],
      });
      await expect(liveQueryDiagnostics(client)).resolves.toMatchObject({
        queries: [
          {
            dependencyHintCount: 1,
            skippedRerunCount: 0,
            rerunCount: 1,
            emittedEventCount: 1,
          },
        ],
      });
    } finally {
      await dialect.destroyLiveQueries();
      await db.destroy();
    }
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

  it('reports lifecycle state through offline queued mutation and reconnect recovery', async () => {
    let offline = true;
    const sync = await createHonoSyncHarness({
      actors: [{ actorId: ACTOR_A, token: TOKEN_A }],
      edgeGate: () =>
        offline ? new Response('offline', { status: 503 }) : null,
    });
    harnesses.push(sync);

    const database = await sync.openWorkerDatabase({
      clientId: 'client-lifecycle-offline',
      actorId: ACTOR_A,
      getHeaders: () => ({ authorization: TOKEN_A }),
      sync: { autoSyncAfterMutation: false },
    });
    const lifecycleEvents: SyncularLifecycleState[] = [];
    database.client.addEventListener('lifecycleChanged', (event) => {
      lifecycleEvents.push(event);
    });
    await database.client.setSubscriptions([
      taskSubscription({ actorId: ACTOR_A }),
    ]);

    expect(database.client.lifecycleState()).toMatchObject({
      phase: 'offline',
      online: false,
      requiresAction: false,
    });

    await database.mutations.tasks.insert({
      id: 'task-lifecycle-offline',
      title: 'Queued offline task',
      completed: 0,
      user_id: ACTOR_A,
    });
    const queued = await waitForLifecycle(lifecycleEvents, (event) =>
      Boolean(event.outbox && event.outbox.pending >= 1)
    );
    expect(queued).toMatchObject({
      outbox: { pending: 1 },
    });

    await expect(database.client.syncOnce()).rejects.toThrow(/offline|503/);
    expect(database.client.lifecycleState()).toMatchObject({
      phase: 'offline',
      lastError: expect.objectContaining({ message: expect.any(String) }),
    });

    offline = false;
    await waitForRetryBackoff();
    await expect(database.client.syncOnce()).resolves.toMatchObject({
      pushedCommits: 1,
      bootstrap: { complete: true },
    });
    await waitForLifecycle(
      lifecycleEvents,
      (event) => event.phase === 'complete' && event.outbox?.pending === 0
    );
    expect(database.client.lifecycleState()).toMatchObject({
      phase: 'complete',
      outbox: { pending: 0, failed: 0 },
      bootstrap: { complete: true },
    });

    const stored = await sync.db
      .selectFrom('tasks')
      .select(['id', 'title', 'user_id'])
      .where('id', '=', 'task-lifecycle-offline')
      .executeTakeFirst();
    expect(stored).toEqual({
      id: 'task-lifecycle-offline',
      title: 'Queued offline task',
      user_id: ACTOR_A,
    });
  });

  it('correlates successful pull diagnostics with server request events', async () => {
    const sync = await createHonoSyncHarness({
      actors: [{ actorId: ACTOR_A, token: TOKEN_A }],
      recordRequestEvents: true,
      seedTasks: [
        {
          id: 'trace-pull-task',
          title: 'Traceable pull task',
          actorId: ACTOR_A,
          serverVersion: 1,
        },
      ],
    });
    harnesses.push(sync);

    const client = await sync.openWorkerClient({
      clientId: 'trace-pull-client',
      actorId: ACTOR_A,
      getHeaders: () => ({ authorization: TOKEN_A }),
    });
    await client.setSubscriptions([taskSubscription({ actorId: ACTOR_A })]);
    const diagnostics: SyncularDiagnosticEvent[] = [];
    const removeDiagnostics = client.addDiagnosticListener((event) => {
      diagnostics.push(event);
    });

    await expect(client.syncOnce()).resolves.toMatchObject({
      pushedCommits: 0,
    });
    removeDiagnostics();

    const snapshot = await client.diagnosticSnapshot();
    const completed = [...diagnostics, ...snapshot.recentDiagnostics].find(
      (event) => event.code === 'sync.syncOnce.completed'
    );
    expect(completed?.syncAttemptId).toMatch(/^[0-9a-f]{32}$/);
    expect(completed?.traceId).toBe(completed?.syncAttemptId);
    expect(completed?.spanId).toMatch(/^[0-9a-f]{16}$/);

    const requestEvent = await waitForSyncRequestEventByTrace(
      sync,
      completed!.traceId!,
      'pull'
    );
    expect(requestEvent).toMatchObject({
      trace_id: completed!.traceId,
      span_id: completed!.spanId,
      event_type: 'pull',
      client_id: 'trace-pull-client',
      actor_id: ACTOR_A,
      outcome: 'applied',
    });
  });

  it('emits row-level change events for local worker writes', async () => {
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
    const events: SyncularRowsChangedEvent[] = [];
    const remove = client.addRowsChangedListener((event) => events.push(event));

    await client.applyMutation(
      newTaskOperation({
        id: scenario.task.id,
        title: scenario.task.title,
        completed: scenario.task.completed,
        user_id: ACTOR_A,
        project_id: scenario.task.project_id,
      }),
      {
        ...scenario.task,
        user_id: ACTOR_A,
      }
    );
    remove();

    expect(events).toHaveLength(1);
    expect(events[0]!.source).toBe('localWrite');
    expect(events[0]!.changedTables).toEqual(['tasks']);
    expect(events[0]!.changedRows).toHaveLength(1);
    const row = events[0]!.changedRows[0]!;
    expect(row.table).toBe('tasks');
    expect(row.rowId).toBe(scenario.task.id);
    expect(row.operation).toBe('insert');
    expect(row.changedFields).toContain('title');
    expect(row.changedFields).toContain('user_id');
    expect(row.crdtFields).toContain('title_yjs_state');
    expect(row.crdtFieldChanges?.[0]).toMatchObject({
      field: 'title',
      stateColumn: 'title_yjs_state',
      kind: 'text',
      syncMode: 'server-merge',
    });
    expect(typeof row.commitId).toBe('string');
  });

  it('keeps readonly executeSql results correct across repeated parameterized reads', async () => {
    const sync = await createHonoSyncHarness({
      actors: [{ actorId: ACTOR_A, token: TOKEN_A }],
    });
    harnesses.push(sync);

    const client = await sync.openWorkerClient({
      clientId: 'readonly-cache-client',
      actorId: ACTOR_A,
      getHeaders: () => ({ authorization: TOKEN_A }),
    });
    const firstTask = {
      id: 'readonly-cache-task-1',
      title: 'First cached read task',
      completed: 0,
      user_id: ACTOR_A,
      project_id: null,
    };
    const secondTask = {
      id: 'readonly-cache-task-2',
      title: 'Second cached read task',
      completed: 0,
      user_id: ACTOR_A,
      project_id: null,
    };

    await client.applyMutation(newTaskOperation(firstTask), firstTask);
    await client.applyMutation(newTaskOperation(secondTask), secondTask);

    const sql = 'select id, title from tasks where id = ?';
    await expect(client.executeSql(sql, [firstTask.id])).resolves.toMatchObject(
      {
        rows: [{ id: firstTask.id, title: firstTask.title }],
      }
    );
    await expect(
      client.executeSql(sql, [secondTask.id])
    ).resolves.toMatchObject({
      rows: [{ id: secondTask.id, title: secondTask.title }],
    });
  });

  it('honors configured Rust outbox push batch limits', async () => {
    const sync = await createHonoSyncHarness({
      actors: [{ actorId: ACTOR_A, token: TOKEN_A }],
    });
    harnesses.push(sync);

    const client = await sync.openWorkerClient({
      clientId: 'configured-push-batch-client',
      actorId: ACTOR_A,
      getHeaders: () => ({ authorization: TOKEN_A }),
      push: { outboxBatchLimit: 25 },
    });

    for (let index = 0; index < 25; index += 1) {
      const localRow = {
        id: `configured-push-batch-task-${index}`,
        title: `Configured push batch task ${index}`,
        completed: 0,
        user_id: ACTOR_A,
        project_id: null,
        server_version: 0,
        image: null,
        title_yjs_state: null,
      };
      await client.applyMutation(
        newTaskOperation({
          id: localRow.id,
          title: localRow.title,
          user_id: ACTOR_A,
        }),
        localRow
      );
    }

    await expect(client.syncPush()).resolves.toMatchObject({
      pushedCommits: 25,
    });
  });

  it('adapts default Rust outbox push batches for large queues', async () => {
    const sync = await createHonoSyncHarness({
      actors: [{ actorId: ACTOR_A, token: TOKEN_A }],
    });
    harnesses.push(sync);

    const client = await sync.openWorkerClient({
      clientId: 'adaptive-push-batch-client',
      actorId: ACTOR_A,
      getHeaders: () => ({ authorization: TOKEN_A }),
    });

    for (let index = 0; index < 200; index += 1) {
      const localRow = {
        id: `adaptive-push-batch-task-${index}`,
        title: `Adaptive push batch task ${index}`,
        completed: 0,
        user_id: ACTOR_A,
        project_id: null,
        server_version: 0,
        image: null,
        title_yjs_state: null,
      };
      await client.applyMutation(
        newTaskOperation({
          id: localRow.id,
          title: localRow.title,
          user_id: ACTOR_A,
        }),
        localRow
      );
    }

    await expect(client.syncPush()).resolves.toMatchObject({
      pushedCommits: 100,
    });
    await expect(client.syncPush()).resolves.toMatchObject({
      pushedCommits: 100,
    });
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

    const error = await client.syncOnce().then(
      () => null,
      (err) => err
    );
    expect(error).toBeInstanceOf(SyncularWorkerError);
    expect(error).toMatchObject({
      code: 'sync.auth_required',
      category: 'auth-required',
      retryable: true,
      recommendedAction: 'refreshAuth',
      details: { status: scenario.expectedStatus },
    });
    expect(error.message).toMatch(new RegExp(scenario.expectedErrorPattern));
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
      seedTasks: [
        {
          id: 'future-schema-server-task',
          title: 'Blocked future schema task',
          actorId: ACTOR_A,
          serverVersion: 1,
        },
      ],
    });
    harnesses.push(sync);

    const client = await sync.openWorkerClient({
      clientId: scenario.requiredFutureClientId,
      actorId: ACTOR_A,
      getHeaders: () => ({ authorization: TOKEN_A }),
    });
    const diagnostics: SyncularDiagnosticEvent[] = [];
    const removeDiagnostics = client.addDiagnosticListener((event) => {
      diagnostics.push(event);
    });
    await client.setSubscriptions([taskSubscription({ actorId: ACTOR_A })]);
    const localRow = {
      id: 'future-schema-local-task',
      title: 'Local row before schema mismatch',
      completed: 0,
      user_id: ACTOR_A,
      project_id: null,
      server_version: 0,
      image: null,
      title_yjs_state: null,
    };
    await client.applyMutation(newTaskOperation(localRow), localRow);
    await expect(client.listTable('tasks')).resolves.toEqual([
      expect.objectContaining({ id: localRow.id, title: localRow.title }),
    ]);

    const error = await client.syncPull().then(
      () => null,
      (err) => err
    );
    expect(error).toBeInstanceOf(SyncularWorkerError);
    expect(error).toMatchObject({
      code: 'sync.schema_mismatch',
      category: 'schema-mismatch',
      retryable: false,
      recommendedAction: 'regenerateClient',
      details: { syncularKind: 'Schema' },
    });
    expect(error.message).toMatch(
      new RegExp(scenario.expectedRequiredErrorPattern)
    );
    removeDiagnostics();
    expect(diagnostics).toContainEqual(
      expect.objectContaining({
        source: 'sync',
        code: 'sync.schema_mismatch',
        details: expect.objectContaining({
          errorCode: 'sync.schema_mismatch',
          category: 'schema-mismatch',
          recommendedAction: 'regenerateClient',
        }),
      })
    );
    await expect(client.listTable('tasks')).resolves.toEqual([
      expect.objectContaining({ id: localRow.id, title: localRow.title }),
    ]);
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
    await client.applyMutation(
      {
        table: 'tasks',
        row_id: localRow.id,
        op: 'upsert',
        payload: localRow,
        base_version: 0,
      },
      localRow
    );
    const unsafe = client as unknown as SyncularUnsafeSqlClient;
    await unsafe.executeUnsafeSql(
      'update sync_outbox_commits set schema_version = ?',
      [futureSchemaVersion]
    );

    await expect(client.syncPush()).rejects.toThrow(
      new RegExp(scenario.expectedInvalidOutboxErrorPattern)
    );
    expect(syncPosts).toBe(0);
  });

  it('reports and safely repairs browser local health findings', async () => {
    const subscription = taskSubscription({ actorId: ACTOR_A });
    const sync = await createHonoSyncHarness({
      actors: [{ actorId: ACTOR_A, token: TOKEN_A }],
    });
    harnesses.push(sync);

    const client = await sync.openWorkerClient({
      clientId: 'local-health-browser-client',
      actorId: ACTOR_A,
      getHeaders: () => ({ authorization: TOKEN_A }),
    });
    await client.setSubscriptions([subscription]);
    const unsafe = client as unknown as SyncularUnsafeSqlClient;
    await unsafe.executeUnsafeSql(
      'insert into sync_subscription_state (state_id, subscription_id, "table", scopes_json, params_json, cursor, bootstrap_state_json, status, created_at, updated_at) values (?, ?, ?, ?, ?, ?, null, ?, ?, ?)',
      [
        'default',
        subscription.id,
        subscription.table,
        JSON.stringify({ actorId: ACTOR_A }),
        '{}',
        0,
        'active',
        1,
        1,
      ]
    );
    await unsafe.executeUnsafeSql(
      'insert into sync_verified_roots (state_id, subscription_id, partition_id, commit_seq, root, created_at, updated_at) values (?, ?, ?, ?, ?, ?, ?)',
      ['default', subscription.id, 'partition-a', 0, 'not-a-root', 1, 1]
    );
    await unsafe.executeUnsafeSql(
      'insert into sync_subscription_state (state_id, subscription_id, "table", scopes_json, params_json, cursor, bootstrap_state_json, status, created_at, updated_at) values (?, ?, ?, ?, ?, ?, null, ?, ?, ?)',
      [
        'default',
        'orphaned-health-subscription',
        subscription.table,
        '{}',
        '{}',
        0,
        'active',
        1,
        1,
      ]
    );
    await unsafe.executeUnsafeSql(
      'insert into sync_verified_roots (state_id, subscription_id, partition_id, commit_seq, root, created_at, updated_at) values (?, ?, ?, ?, ?, ?, ?)',
      [
        'default',
        'orphaned-health-subscription',
        'partition-old',
        0,
        'a'.repeat(64),
        1,
        1,
      ]
    );

    let health = await client.localHealthCheck();
    expect(health.ok).toBe(false);
    expect(health.findings.map((finding) => finding.code)).toEqual(
      expect.arrayContaining([
        'local.verified_root_invalid_hex',
        'local.subscription_state_orphaned',
        'local.verified_root_orphaned',
      ])
    );

    await expect(
      client.repairLocalHealth({
        action: 'forceRebootstrap',
        subscriptionIds: [subscription.id],
      })
    ).resolves.toMatchObject({
      action: 'forceRebootstrap',
      deletedSubscriptionStates: 1,
      deletedVerifiedRoots: 1,
      forcedRebootstrapSubscriptions: 1,
    });
    await expect(
      client.repairLocalHealth({ action: 'clearOrphanedState' })
    ).resolves.toMatchObject({
      action: 'clearOrphanedState',
      deletedSubscriptionStates: 1,
      deletedVerifiedRoots: 1,
    });

    health = await client.localHealthCheck();
    expect(health.ok).toBe(true);
    expect(health.findings).toEqual([]);
    await expect(client.listTable('tasks')).resolves.toEqual([]);
  });

  it('reports browser synced app rows outside configured subscription scopes', async () => {
    const sync = await createHonoSyncHarness({
      actors: [{ actorId: ACTOR_A, token: TOKEN_A }],
    });
    harnesses.push(sync);

    const client = await sync.openWorkerClient({
      clientId: 'local-health-orphaned-row-client',
      actorId: ACTOR_A,
      getHeaders: () => ({ authorization: TOKEN_A }),
    });
    await client.setSubscriptions([taskSubscription({ actorId: ACTOR_A })]);
    const unsafe = client as unknown as SyncularUnsafeSqlClient;
    await unsafe.executeUnsafeSql(
      'insert into tasks (id, title, completed, user_id, project_id, server_version, image, title_yjs_state) values (?, ?, ?, ?, ?, ?, ?, ?)',
      ['health-owned-task', 'Owned', 0, ACTOR_A, null, 42, null, null]
    );
    await unsafe.executeUnsafeSql(
      'insert into tasks (id, title, completed, user_id, project_id, server_version, image, title_yjs_state) values (?, ?, ?, ?, ?, ?, ?, ?)',
      ['health-orphaned-task', 'Orphaned', 0, ACTOR_B, null, 42, null, null]
    );
    await unsafe.executeUnsafeSql(
      'insert into tasks (id, title, completed, user_id, project_id, server_version, image, title_yjs_state) values (?, ?, ?, ?, ?, ?, ?, ?)',
      ['health-local-only-task', 'Local only', 0, ACTOR_B, null, 0, null, null]
    );

    const health = await client.localHealthCheck();
    expect(health.ok).toBe(false);
    expect(health.checkedSyncedRows).toBe(2);
    expect(health.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'local.synced_rows_orphaned',
          table: 'tasks',
          repairAction: 'clearOrphanedSyncedRows',
          details: expect.objectContaining({
            count: 1,
            checkedSyncedRows: 2,
          }),
        }),
      ])
    );
    await expect(client.listTable('tasks')).resolves.toHaveLength(3);
    await expect(
      client.repairLocalHealth({
        action: 'clearOrphanedSyncedRows',
        tables: ['tasks'],
      })
    ).resolves.toMatchObject({
      action: 'clearOrphanedSyncedRows',
      clearedOrphanedSyncedRows: 1,
      clearedTables: ['tasks'],
    });
    const rowsAfterRepair = await client.listTable('tasks');
    expect(rowsAfterRepair).toHaveLength(2);
    expect(rowsAfterRepair).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'health-owned-task' }),
        expect.objectContaining({ id: 'health-local-only-task' }),
      ])
    );
    await expect(client.localHealthCheck()).resolves.toMatchObject({
      ok: true,
      checkedSyncedRows: 1,
      findings: [],
    });
  });

  it('exports and imports redacted browser local support bundles', async () => {
    const sync = await createHonoSyncHarness({
      actors: [{ actorId: ACTOR_A, token: TOKEN_A }],
    });
    harnesses.push(sync);

    const client = await sync.openWorkerClient({
      clientId: 'local-support-browser-client',
      actorId: ACTOR_A,
      getHeaders: () => ({ authorization: TOKEN_A }),
    });
    await client.setSubscriptions([
      {
        id: 'browser-support-sub',
        table: 'tasks',
        scopes: {
          user_id: 'browser-secret-user',
          project_id: ['browser-secret-project'],
        },
        params: { preview: 'browser-secret-param' },
        bootstrapPhase: 1,
      },
    ]);
    const unsafe = client as unknown as SyncularUnsafeSqlClient;
    await unsafe.executeUnsafeSql(
      'insert into tasks (id, title, completed, user_id, project_id, server_version, image, title_yjs_state) values (?, ?, ?, ?, ?, ?, ?, ?)',
      [
        'browser-support-secret-task',
        'Browser support secret title',
        0,
        'browser-secret-user',
        'browser-secret-project',
        7,
        null,
        null,
      ]
    );

    const bundle = await client.exportLocalSupportBundle();
    const bundleJson = JSON.stringify(bundle);
    expect(bundle).toMatchObject({
      redacted: true,
      source: 'browser',
      subscriptions: [
        {
          id: 'browser-support-sub',
          table: 'tasks',
          scopeKeys: ['project_id', 'user_id'],
          scopeValueCount: 2,
          paramsKeys: ['preview'],
          paramsValueCount: 1,
        },
      ],
    });
    expect(bundleJson).not.toContain('browser-secret-user');
    expect(bundleJson).not.toContain('browser-secret-project');
    expect(bundleJson).not.toContain('browser-secret-param');
    expect(bundleJson).not.toContain('Browser support secret title');

    await expect(
      client.importLocalSupportBundle(bundle)
    ).resolves.toMatchObject({
      redacted: true,
      source: 'browser',
      healthOk: true,
      subscriptionCount: 1,
    });
    await expect(
      client.importLocalSupportBundle(
        JSON.stringify({ ...bundle, redacted: false })
      )
    ).rejects.toThrow(/requires a redacted bundle/);
  });

  it('resets browser sync state while preserving local-only app rows', async () => {
    const subscription = taskSubscription({ actorId: ACTOR_A });
    const sync = await createHonoSyncHarness({
      actors: [{ actorId: ACTOR_A, token: TOKEN_A }],
    });
    harnesses.push(sync);

    const client = await sync.openWorkerClient({
      clientId: 'local-reset-browser-client',
      actorId: ACTOR_A,
      getHeaders: () => ({ authorization: TOKEN_A }),
    });
    await client.setSubscriptions([subscription]);
    const unsafe = client as unknown as SyncularUnsafeSqlClient;
    await unsafe.executeUnsafeSql(
      'insert into tasks (id, title, completed, user_id, project_id, server_version, image, title_yjs_state) values (?, ?, 0, ?, ?, ?, null, null)',
      ['reset-browser-synced', 'Synced row', ACTOR_A, null, 42]
    );
    await unsafe.executeUnsafeSql(
      'insert into tasks (id, title, completed, user_id, project_id, server_version, image, title_yjs_state) values (?, ?, 0, ?, ?, ?, null, null)',
      ['reset-browser-local-only', 'Local only row', ACTOR_A, null, 0]
    );
    await unsafe.executeUnsafeSql(
      'insert into sync_subscription_state (state_id, subscription_id, "table", scopes_json, params_json, cursor, bootstrap_state_json, status, created_at, updated_at) values (?, ?, ?, ?, ?, ?, null, ?, ?, ?)',
      [
        'default',
        subscription.id,
        subscription.table,
        JSON.stringify({ actorId: ACTOR_A }),
        '{}',
        42,
        'active',
        1,
        1,
      ]
    );
    await unsafe.executeUnsafeSql(
      'insert into sync_verified_roots (state_id, subscription_id, partition_id, commit_seq, root, created_at, updated_at) values (?, ?, ?, ?, ?, ?, ?)',
      ['default', subscription.id, 'partition-a', 42, 'a'.repeat(64), 1, 1]
    );
    await unsafe.executeUnsafeSql(
      'insert into sync_outbox_commits (id, client_commit_id, status, operations_json, created_at, updated_at, attempt_count, schema_version, next_attempt_at) values (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [
        'reset-browser-pending',
        'reset-browser-pending-commit',
        'pending',
        '[]',
        1,
        1,
        0,
        syncularGeneratedSchemaVersion,
        0,
      ]
    );

    await expect(
      client.resetLocalSyncState({ clearSyncedRows: true })
    ).rejects.toThrow(/empty local outbox/i);
    await expect(client.listTable('tasks')).resolves.toHaveLength(2);

    await unsafe.executeUnsafeSql(
      "update sync_outbox_commits set status = 'acked' where id = ?",
      ['reset-browser-pending']
    );
    await expect(
      client.resetLocalSyncState({ clearSyncedRows: true })
    ).resolves.toMatchObject({
      resetSubscriptions: 1,
      deletedSubscriptionStates: 1,
      deletedVerifiedRoots: 1,
      clearedSyncedRows: 1,
      clearedTables: ['tasks'],
    });
    await expect(client.listTable('tasks')).resolves.toEqual([
      expect.objectContaining({ id: 'reset-browser-local-only' }),
    ]);
  });

  it('does not partially apply chunked snapshots when chunk fetch fails', async () => {
    const scenario = syncConformance.snapshotChunk;
    const sync = await createHonoSyncHarness({
      actors: [{ actorId: ACTOR_A, token: TOKEN_A }],
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
    await client.applyMutation(
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

  it('rejects corrupted snapshot chunks before applying rows', async () => {
    const scenario = syncConformance.snapshotChunk;
    const sync = await createHonoSyncHarness({
      actors: [{ actorId: ACTOR_A, token: TOKEN_A }],
      seedTasks: [
        {
          id: scenario.browserServerTask.id,
          title: scenario.browserServerTask.title,
          actorId: ACTOR_A,
        },
      ],
      edgeGate: (request) => {
        if (new URL(request.url).pathname.includes('/snapshot-chunks/')) {
          return new Response(new Uint8Array([1, 2, 3]), { status: 200 });
        }
        return null;
      },
    });
    harnesses.push(sync);

    const client = await sync.openWorkerClient({
      clientId: 'corrupted-snapshot-chunk-client',
      actorId: ACTOR_A,
      getHeaders: () => ({ authorization: TOKEN_A }),
    });
    const localRow = {
      ...scenario.localRow,
      user_id: ACTOR_A,
    };
    await client.applyMutation(
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

    const error = await client.syncPull().then(
      () => null,
      (err) => err
    );
    expect(error).toBeInstanceOf(SyncularWorkerError);
    expect(error).toMatchObject({
      code: 'sync.integrity_rejected',
      category: 'integrity-rejected',
      retryable: false,
      recommendedAction: 'forceResync',
      details: { syncularKind: 'Protocol' },
    });
    expect(error.message).toMatch(/hash mismatch|byte length mismatch/i);

    await expect(client.listTable('tasks')).resolves.toEqual([
      expect.objectContaining({
        id: scenario.localRow.id,
        title: scenario.localRow.title,
      }),
    ]);
  });

  it('recovers on a later pull after an interrupted snapshot chunk fetch', async () => {
    const scenario = syncConformance.snapshotChunk;
    let failNextChunk = true;
    const sync = await createHonoSyncHarness({
      actors: [{ actorId: ACTOR_A, token: TOKEN_A }],
      seedTasks: [
        {
          id: scenario.browserServerTask.id,
          title: scenario.browserServerTask.title,
          actorId: ACTOR_A,
        },
      ],
      edgeGate: (request) => {
        if (
          failNextChunk &&
          new URL(request.url).pathname.includes('/snapshot-chunks/')
        ) {
          failNextChunk = false;
          return new Response('chunk failure', { status: 500 });
        }
        return null;
      },
    });
    harnesses.push(sync);

    const client = await sync.openWorkerClient({
      clientId: 'snapshot-chunk-retry-client',
      actorId: ACTOR_A,
      getHeaders: () => ({ authorization: TOKEN_A }),
    });
    await client.setSubscriptions([taskSubscription({ actorId: ACTOR_A })]);

    await expect(client.syncPull()).rejects.toThrow(
      new RegExp(scenario.expectedErrorPattern)
    );
    await expect(client.listTable('tasks')).resolves.toEqual([]);

    await expect(client.syncPull()).resolves.toMatchObject({
      subscriptions: [
        {
          id: syncConformance.subscription.id,
        },
      ],
    });
    await expect(client.listTable('tasks')).resolves.toEqual([
      expect.objectContaining({
        id: scenario.browserServerTask.id,
        title: scenario.browserServerTask.title,
      }),
    ]);
  });

  it('resumes bootstrap from the last applied snapshot chunk checkpoint', async () => {
    const syncPosts: unknown[] = [];
    let chunkRequests = 0;
    const sync = await createHonoSyncHarness({
      actors: [{ actorId: ACTOR_A, token: TOKEN_A }],
      seedTasks: [
        {
          id: 'checkpoint-task-1',
          title: 'Checkpoint Task 1',
          actorId: ACTOR_A,
        },
        {
          id: 'checkpoint-task-2',
          title: 'Checkpoint Task 2',
          actorId: ACTOR_A,
        },
      ],
      edgeGate: async (request) => {
        const url = new URL(request.url);
        if (request.method === 'POST' && url.pathname === '/sync') {
          syncPosts.push(await request.clone().json());
        }
        if (url.pathname.includes('/snapshot-chunks/')) {
          chunkRequests += 1;
          if (chunkRequests === 2) {
            return new Response('chunk failure', { status: 500 });
          }
        }
        return null;
      },
    });
    harnesses.push(sync);

    const client = await sync.openWorkerClient({
      clientId: 'snapshot-chunk-checkpoint-client',
      actorId: ACTOR_A,
      getHeaders: () => ({ authorization: TOKEN_A }),
      pull: {
        includeSnapshotRows: false,
        collectChangedRows: false,
        limitSnapshotRows: 1,
        maxSnapshotPages: 1,
      },
    });
    await client.setSubscriptions([taskSubscription({ actorId: ACTOR_A })]);

    await expect(client.syncPull()).resolves.toMatchObject({
      subscriptions: [{ id: syncConformance.subscription.id }],
    });
    await expect(client.listTable('tasks')).resolves.toHaveLength(1);

    const unsafe = client as unknown as SyncularUnsafeSqlClient;
    const checkpointRows = await unsafe.executeUnsafeSql<{
      bootstrap_state_json: string | null;
    }>(
      'select bootstrap_state_json from sync_subscription_state where subscription_id = ?',
      [syncConformance.subscription.id]
    );
    expect(checkpointRows.rows[0]?.bootstrap_state_json).toContain(
      '"rowCursor"'
    );

    await expect(client.syncPull()).rejects.toThrow(/chunk failure/i);
    await expect(client.listTable('tasks')).resolves.toHaveLength(1);

    await expect(client.syncPull()).resolves.toMatchObject({
      subscriptions: [{ id: syncConformance.subscription.id }],
    });
    await expect(client.listTable('tasks')).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'checkpoint-task-1' }),
        expect.objectContaining({ id: 'checkpoint-task-2' }),
      ])
    );

    const resumedRequests = syncPosts.filter((post) => {
      if (typeof post !== 'object' || post === null) return false;
      const subscription = (
        post as {
          pull?: { subscriptions?: Array<{ bootstrapState?: unknown }> };
        }
      ).pull?.subscriptions?.[0];
      return subscription?.bootstrapState != null;
    });
    expect(resumedRequests.length).toBeGreaterThanOrEqual(2);
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
    const unsafe = client as unknown as SyncularUnsafeSqlClient;
    const cursorRows = await unsafe.executeUnsafeSql<{
      cursor: number;
    }>('select cursor from sync_subscription_state where subscription_id = ?', [
      syncConformance.subscription.id,
    ]);
    expect(cursorRows.rows).toEqual([
      { cursor: scenario.expectedBrowserCursor },
    ]);
  });

  it('reports and applies binary snapshot chunks on the browser fast path', async () => {
    const sync = await createHonoSyncHarness({
      actors: [{ actorId: ACTOR_A, token: TOKEN_A }],
      seedTasks: [
        {
          id: 'binary-browser-task-1',
          title: 'Binary Browser Task 1',
          actorId: ACTOR_A,
        },
        {
          id: 'binary-browser-task-2',
          title: 'Binary Browser Task 2',
          actorId: ACTOR_A,
        },
      ],
    });
    harnesses.push(sync);

    const client = await sync.openWorkerClient({
      clientId: 'binary-browser-client',
      actorId: ACTOR_A,
      getHeaders: () => ({ authorization: TOKEN_A }),
      pull: {
        includeSnapshotRows: false,
        collectChangedRows: false,
        limitSnapshotRows: 1,
        maxSnapshotPages: 10,
      },
    });
    const diagnostics = client as unknown as {
      resetTransportStats(): Promise<void>;
      transportStats(): Promise<{
        snapshotChunkBinaryCount: number;
        snapshotChunkRowCount: number;
      }>;
    };
    await client.setSubscriptions([taskSubscription({ actorId: ACTOR_A })]);
    await diagnostics.resetTransportStats();

    await expect(client.syncPull()).resolves.toMatchObject({
      subscriptions: [
        {
          id: syncConformance.subscription.id,
          snapshotRows: [],
        },
      ],
    });

    const stats = await diagnostics.transportStats();
    expect(stats.snapshotChunkBinaryCount).toBeGreaterThan(0);
    expect(stats.snapshotChunkRowCount).toBe(2);

    const rows = await client.listTable('tasks');
    expect(rows).toHaveLength(2);
    expect(rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'binary-browser-task-1' }),
        expect.objectContaining({ id: 'binary-browser-task-2' }),
      ])
    );
  });

  it('applies scoped SQLite snapshot artifacts on the browser path', async () => {
    let artifactDownloads = 0;
    let chunkDownloads = 0;
    const sync = await createHonoSyncHarness({
      actors: [{ actorId: ACTOR_A, token: TOKEN_A }],
      precomputedTaskSnapshotArtifact: {
        actorId: ACTOR_A,
        artifactId: 'browser-sqlite-artifact-1',
        rowLimit: 50_000,
      },
      seedTasks: [
        {
          id: 'artifact-browser-task-1',
          title: 'Artifact Browser Task 1',
          actorId: ACTOR_A,
        },
        {
          id: 'artifact-browser-task-2',
          title: 'Artifact Browser Task 2',
          actorId: ACTOR_A,
        },
      ],
      edgeGate: (request) => {
        const url = new URL(request.url);
        if (url.pathname.includes('/snapshot-artifacts/')) {
          artifactDownloads += 1;
        }
        if (url.pathname.includes('/snapshot-chunks/')) {
          chunkDownloads += 1;
        }
        return null;
      },
    });
    harnesses.push(sync);

    const client = await sync.openWorkerClient({
      clientId: 'sqlite-artifact-browser-client',
      actorId: ACTOR_A,
      getHeaders: () => ({ authorization: TOKEN_A }),
      pull: {
        includeSnapshotRows: false,
        collectChangedRows: false,
        limitSnapshotRows: 50_000,
        maxSnapshotPages: 1,
      },
    });
    await client.setSubscriptions([taskSubscription({ actorId: ACTOR_A })]);

    const result = await client.syncPull();
    expect(result).toMatchObject({
      subscriptions: [
        { id: syncConformance.subscription.id, snapshotRows: [] },
      ],
    });
    expect(result.timings.snapshotChunkMaterializeMs).toBe(0);

    expect(artifactDownloads).toBe(1);
    expect(chunkDownloads).toBe(0);
    const rows = await client.listTable('tasks');
    expect(rows).toHaveLength(2);
    expect(rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'artifact-browser-task-1' }),
        expect.objectContaining({ id: 'artifact-browser-task-2' }),
      ])
    );
  });

  it('recovers on a later pull after a corrupted SQLite snapshot artifact fetch', async () => {
    let failNextArtifact = true;
    const sync = await createHonoSyncHarness({
      actors: [{ actorId: ACTOR_A, token: TOKEN_A }],
      precomputedTaskSnapshotArtifact: {
        actorId: ACTOR_A,
        artifactId: 'browser-sqlite-artifact-corrupt-once',
        rowLimit: 50_000,
      },
      seedTasks: [
        {
          id: 'artifact-corrupt-retry-task',
          title: 'Artifact Corrupt Retry Task',
          actorId: ACTOR_A,
        },
      ],
      edgeGate: (request) => {
        const url = new URL(request.url);
        if (failNextArtifact && url.pathname.includes('/snapshot-artifacts/')) {
          failNextArtifact = false;
          return new Response(new Uint8Array([1, 2, 3, 4]), {
            status: 200,
            headers: {
              'content-type': 'application/octet-stream',
            },
          });
        }
        return null;
      },
    });
    harnesses.push(sync);

    const client = await sync.openWorkerClient({
      clientId: 'sqlite-artifact-corrupt-retry-client',
      actorId: ACTOR_A,
      getHeaders: () => ({ authorization: TOKEN_A }),
      pull: {
        includeSnapshotRows: false,
        collectChangedRows: false,
        limitSnapshotRows: 50_000,
        maxSnapshotPages: 1,
      },
    });
    await client.setSubscriptions([taskSubscription({ actorId: ACTOR_A })]);

    await expect(client.syncPull()).rejects.toThrow(/snapshot artifact/i);
    await expect(client.listTable('tasks')).resolves.toEqual([]);

    await expect(client.syncPull()).resolves.toMatchObject({
      subscriptions: [
        { id: syncConformance.subscription.id, snapshotRows: [] },
      ],
    });
    await expect(client.listTable('tasks')).resolves.toEqual([
      expect.objectContaining({
        id: 'artifact-corrupt-retry-task',
        title: 'Artifact Corrupt Retry Task',
      }),
    ]);
  });

  it('recovers on a later pull after an interrupted SQLite snapshot artifact fetch', async () => {
    let failNextArtifact = true;
    const sync = await createHonoSyncHarness({
      actors: [{ actorId: ACTOR_A, token: TOKEN_A }],
      precomputedTaskSnapshotArtifact: {
        actorId: ACTOR_A,
        artifactId: 'browser-sqlite-artifact-interrupted-once',
        rowLimit: 50_000,
      },
      seedTasks: [
        {
          id: 'artifact-interrupted-retry-task',
          title: 'Artifact Interrupted Retry Task',
          actorId: ACTOR_A,
        },
      ],
      edgeGate: (request) => {
        const url = new URL(request.url);
        if (failNextArtifact && url.pathname.includes('/snapshot-artifacts/')) {
          failNextArtifact = false;
          return new Response('artifact failure', { status: 500 });
        }
        return null;
      },
    });
    harnesses.push(sync);

    const client = await sync.openWorkerClient({
      clientId: 'sqlite-artifact-interrupted-retry-client',
      actorId: ACTOR_A,
      getHeaders: () => ({ authorization: TOKEN_A }),
      pull: {
        includeSnapshotRows: false,
        collectChangedRows: false,
        limitSnapshotRows: 50_000,
        maxSnapshotPages: 1,
      },
    });
    await client.setSubscriptions([taskSubscription({ actorId: ACTOR_A })]);

    await expect(client.syncPull()).rejects.toThrow(/snapshot artifact/i);
    await expect(client.listTable('tasks')).resolves.toEqual([]);

    await expect(client.syncPull()).resolves.toMatchObject({
      subscriptions: [
        { id: syncConformance.subscription.id, snapshotRows: [] },
      ],
    });
    await expect(client.listTable('tasks')).resolves.toEqual([
      expect.objectContaining({
        id: 'artifact-interrupted-retry-task',
        title: 'Artifact Interrupted Retry Task',
      }),
    ]);
  });

  it('resumes after a committed SQLite snapshot artifact page when a later artifact fetch fails', async () => {
    let artifactDownloads = 0;
    const sync = await createHonoSyncHarness({
      actors: [{ actorId: ACTOR_A, token: TOKEN_A }],
      precomputedTaskSnapshotArtifact: {
        actorId: ACTOR_A,
        artifactId: 'browser-sqlite-artifact-partial-progress',
        rowLimit: 1,
      },
      seedTasks: [
        {
          id: 'artifact-partial-progress-1',
          title: 'Artifact Partial Progress 1',
          actorId: ACTOR_A,
        },
        {
          id: 'artifact-partial-progress-2',
          title: 'Artifact Partial Progress 2',
          actorId: ACTOR_A,
        },
      ],
      edgeGate: (request) => {
        const url = new URL(request.url);
        if (url.pathname.includes('/snapshot-artifacts/')) {
          artifactDownloads += 1;
          if (artifactDownloads === 2) {
            return new Response('artifact failure', { status: 500 });
          }
        }
        return null;
      },
    });
    harnesses.push(sync);

    const client = await sync.openWorkerClient({
      clientId: 'sqlite-artifact-partial-progress-client',
      actorId: ACTOR_A,
      getHeaders: () => ({ authorization: TOKEN_A }),
      pull: {
        includeSnapshotRows: false,
        collectChangedRows: false,
        limitSnapshotRows: 1,
        maxSnapshotPages: 2,
      },
    });
    await client.setSubscriptions([taskSubscription({ actorId: ACTOR_A })]);

    await expect(client.syncPull()).rejects.toThrow(/snapshot artifact/i);
    await expect(client.listTable('tasks')).resolves.toEqual([
      expect.objectContaining({
        id: 'artifact-partial-progress-1',
        title: 'Artifact Partial Progress 1',
      }),
    ]);

    await expect(client.syncPull()).resolves.toMatchObject({
      bootstrap: {
        complete: true,
        pendingSubscriptionIds: [],
      },
      subscriptions: [
        {
          id: syncConformance.subscription.id,
          ready: true,
          snapshotRows: [],
        },
      ],
    });
    await expect(client.listTable('tasks')).resolves.toEqual([
      expect.objectContaining({ id: 'artifact-partial-progress-1' }),
      expect.objectContaining({ id: 'artifact-partial-progress-2' }),
    ]);
    expect(artifactDownloads).toBe(3);
  });

  it('clears direct SQLite artifact rows when a subscription is revoked', async () => {
    const scenario = syncConformance.revokedSubscription;
    let artifactDownloads = 0;
    const sync = await createHonoSyncHarness({
      actors: [{ actorId: ACTOR_A, token: TOKEN_A }],
      precomputedTaskSnapshotArtifact: {
        actorId: ACTOR_A,
        artifactId: 'browser-sqlite-artifact-revocation',
        rowLimit: 50_000,
      },
      seedTasks: [
        {
          id: scenario.seedTask.id,
          title: scenario.seedTask.title,
          actorId: ACTOR_A,
          serverVersion: scenario.seedTask.serverVersion,
        },
      ],
      edgeGate: (request) => {
        if (new URL(request.url).pathname.includes('/snapshot-artifacts/')) {
          artifactDownloads += 1;
        }
        return null;
      },
    });
    harnesses.push(sync);

    const client = await sync.openWorkerClient({
      clientId: `${scenario.clientId}-artifact`,
      actorId: ACTOR_A,
      getHeaders: () => ({ authorization: TOKEN_A }),
      pull: {
        includeSnapshotRows: false,
        collectChangedRows: false,
        limitSnapshotRows: 50_000,
        maxSnapshotPages: 1,
      },
    });
    await client.setSubscriptions([taskSubscription({ actorId: ACTOR_A })]);
    await client.syncPull();

    expect(artifactDownloads).toBe(1);
    await expect(client.listTable('tasks')).resolves.toContainEqual(
      expect.objectContaining({ id: scenario.seedTask.id, user_id: ACTOR_A })
    );

    await client.setSubscriptions([
      taskSubscription({ actorId: scenario.revokedActorId }),
    ]);
    const result = await client.syncPull();

    expect(result.subscriptions[0]).toMatchObject({
      id: syncConformance.subscription.id,
      table: syncConformance.subscription.table,
      status: scenario.expectedStatus,
      scopes: scenario.expectedScopes,
    });
    await expect(client.listTable('tasks')).resolves.toEqual([]);
  });

  it('hydrates snapshot rows into SQLite without returning them by default', async () => {
    const sync = await createHonoSyncHarness({
      actors: [{ actorId: ACTOR_A, token: TOKEN_A }],
      seedTasks: [
        {
          id: 'default-snapshot-task-1',
          title: 'Default Snapshot Task 1',
          actorId: ACTOR_A,
        },
        {
          id: 'default-snapshot-task-2',
          title: 'Default Snapshot Task 2',
          actorId: ACTOR_A,
        },
      ],
    });
    harnesses.push(sync);

    const client = await sync.openWorkerClient({
      clientId: 'default-snapshot-client',
      actorId: ACTOR_A,
      getHeaders: () => ({ authorization: TOKEN_A }),
    });
    await client.setSubscriptions([taskSubscription({ actorId: ACTOR_A })]);

    const result = await client.syncPull();
    expect(result.subscriptions[0]?.snapshotRows).toEqual([]);
    expect(result.changedRows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          table: 'tasks',
          rowId: 'default-snapshot-task-1',
          operation: 'insert',
        }),
        expect.objectContaining({
          table: 'tasks',
          rowId: 'default-snapshot-task-2',
          operation: 'insert',
        }),
      ])
    );

    const rows = await client.listTable('tasks');
    expect(rows).toHaveLength(2);
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
      SyncularLiveQueryEvent<{
        id: string;
        title: string;
        user_id: string;
      }>
    > = [];
    clientA.addLiveQueryListener(snapshot.id, (event) => {
      events.push(
        event as SyncularLiveQueryEvent<{
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
    expect(events[0]!.changedRows).toHaveLength(1);
    expect(events[0]!.changedRows[0]!.table).toBe('tasks');
    expect(events[0]!.changedRows[0]!.rowId).toBe(scenario.firstTask.id);
    expect(events[0]!.changedRows[0]!.operation).toBe('insert');
    expect(events[0]!.changedRows[0]!.changedFields).toContain('title');
    expect(events[0]!.changedRows[0]!.changedFields).toContain('user_id');

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

    await expect(
      clientA.unsubscribeQuery(snapshot.id)
    ).resolves.toBeUndefined();
    await expect(
      clientA.unsubscribeQuery(snapshot.id)
    ).resolves.toBeUndefined();
    await pushTaskAndPull(clientB, clientA, scenario.thirdTask);
    expect(events).toHaveLength(scenario.expectedEventsAfterUnsubscribe);
  });

  it('infers live-query dependencies and refreshes from row-level sync apply', async () => {
    const scenario = syncConformance.liveQuery;
    const sync = await createHonoSyncHarness({
      actors: [{ actorId: ACTOR_A, token: TOKEN_A }],
    });
    harnesses.push(sync);

    const clientA = await sync.openWorkerClient({
      clientId: `${scenario.clientAId}-inferred`,
      actorId: ACTOR_A,
      getHeaders: () => ({ authorization: TOKEN_A }),
    });
    await clientA.setSubscriptions([taskSubscription({ actorId: ACTOR_A })]);
    await clientA.syncOnce();

    const clientB = await sync.openWorkerClient({
      clientId: `${scenario.clientBId}-inferred`,
      actorId: ACTOR_A,
      getHeaders: () => ({ authorization: TOKEN_A }),
    });

    const dialect = createSyncularDialect(clientA, {
      appTables: syncularGeneratedAppSchema.tables.map((table) => table.name),
      tableConfig: syncularGeneratedTableConfig,
    });
    const db = new Kysely<SyncularAppDb>({ dialect });
    const events: Array<SyncularLiveQueryEvent<{ id: string; title: string }>> =
      [];

    try {
      await dialect.live(
        db
          .selectFrom('tasks')
          .select(['id', 'title'])
          .where('user_id', '=', ACTOR_A)
          .orderBy('id'),
        {
          onChange(rows, event) {
            events.push({ ...event, rows });
          },
        }
      );
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        initial: true,
        rows: [],
        changedRows: [],
      });

      await pushTaskAndPull(clientB, clientA, scenario.firstTask);
      expect(events).toHaveLength(2);
      expect(events[1]).toMatchObject({
        initial: false,
        rows: [{ id: scenario.firstTask.id, title: scenario.firstTask.title }],
        changedRows: [
          expect.objectContaining({
            table: 'tasks',
            rowId: scenario.firstTask.id,
            operation: 'insert',
          }),
        ],
      });
    } finally {
      await dialect.destroyLiveQueries();
      await db.destroy();
    }
  });

  it('skips hinted live-query reruns for unrelated row churn', async () => {
    const scenario = syncConformance.liveQuery;
    const sync = await createHonoSyncHarness({
      actors: [{ actorId: ACTOR_A, token: TOKEN_A }],
    });
    harnesses.push(sync);

    const clientA = await sync.openWorkerClient({
      clientId: `${scenario.clientAId}-hinted`,
      actorId: ACTOR_A,
      getHeaders: () => ({ authorization: TOKEN_A }),
    });
    await clientA.setSubscriptions([taskSubscription({ actorId: ACTOR_A })]);
    await clientA.syncOnce();

    const clientB = await sync.openWorkerClient({
      clientId: `${scenario.clientBId}-hinted`,
      actorId: ACTOR_A,
      getHeaders: () => ({ authorization: TOKEN_A }),
    });

    const dialect = createSyncularDialect(clientA, {
      appTables: syncularGeneratedAppSchema.tables.map((table) => table.name),
      tableConfig: syncularGeneratedTableConfig,
    });
    const db = new Kysely<SyncularAppDb>({ dialect });
    const events: Array<SyncularLiveQueryEvent<{ id: string; title: string }>> =
      [];

    try {
      await dialect.live(
        db
          .selectFrom('tasks')
          .select(['id', 'title'])
          .where('id', '=', scenario.firstTask.id),
        {
          onChange(rows, event) {
            events.push({ ...event, rows });
          },
        }
      );
      expect(events).toHaveLength(1);

      await pushTaskAndPull(clientB, clientA, scenario.secondTask);
      expect(events).toHaveLength(1);
      await expect(liveQueryDiagnostics(clientA)).resolves.toMatchObject({
        queries: [
          {
            dependencyHintCount: 1,
            skippedRerunCount: 1,
            rerunCount: 0,
            emittedEventCount: 0,
          },
        ],
      });

      await pushTaskAndPull(clientB, clientA, scenario.firstTask);
      expect(events).toHaveLength(2);
      expect(events[1]).toMatchObject({
        initial: false,
        rows: [{ id: scenario.firstTask.id, title: scenario.firstTask.title }],
      });
      await expect(liveQueryDiagnostics(clientA)).resolves.toMatchObject({
        queries: [
          {
            dependencyHintCount: 1,
            skippedRerunCount: 1,
            rerunCount: 1,
            emittedEventCount: 1,
          },
        ],
      });
    } finally {
      await dialect.destroyLiveQueries();
      await db.destroy();
    }
  });

  it('refreshes hinted live queries after CRDT field materialization', async () => {
    const sync = await createHonoSyncHarness({
      actors: [{ actorId: ACTOR_A, token: TOKEN_A }],
    });
    harnesses.push(sync);

    const client = await sync.openWorkerClient({
      clientId: 'client-live-query-crdt-materialization',
      actorId: ACTOR_A,
      getHeaders: () => ({ authorization: TOKEN_A }),
    });
    const field = {
      table: 'tasks',
      rowId: 'live-query-crdt-task',
      field: 'title',
    };
    await insertBlankTask(client, field.rowId);

    const dialect = createSyncularDialect(client, {
      appTables: syncularGeneratedAppSchema.tables.map((table) => table.name),
      tableConfig: syncularGeneratedTableConfig,
    });
    const db = new Kysely<SyncularAppDb>({ dialect });
    const events: Array<
      SyncularLiveQueryEvent<{
        id: string;
        title: string;
        title_yjs_state: string | null;
      }>
    > = [];

    try {
      await dialect.live(
        db
          .selectFrom('tasks')
          .select(['id', 'title', 'title_yjs_state'])
          .where('id', '=', field.rowId),
        {
          onChange(rows, event) {
            events.push({ ...event, rows });
          },
        }
      );
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        initial: true,
        rows: [{ id: field.rowId, title: '', title_yjs_state: null }],
      });

      await client.applyCrdtFieldText({
        ...field,
        nextText: 'Live CRDT title',
      });

      expect(events).toHaveLength(2);
      expect(events[1]).toMatchObject({
        initial: false,
        rows: [
          {
            id: field.rowId,
            title: 'Live CRDT title',
            title_yjs_state: expect.any(String),
          },
        ],
        changedRows: [
          expect.objectContaining({
            table: 'tasks',
            rowId: field.rowId,
            crdtFields: ['title_yjs_state'],
          }),
        ],
      });
      await expect(liveQueryDiagnostics(client)).resolves.toMatchObject({
        queries: [
          {
            dependencyHintCount: 1,
            rerunCount: 1,
            emittedEventCount: 1,
          },
        ],
      });
    } finally {
      await dialect.destroyLiveQueries();
      await db.destroy();
    }
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
    await client.applyMutation(
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

    const unsafe = client as unknown as SyncularUnsafeSqlClient;
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
    await client.applyMutation(
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

    const dialect = createSyncularDialect(client, {
      appTables: syncularGeneratedAppSchema.tables.map((table) => table.name),
      tableConfig: syncularGeneratedTableConfig,
    });
    const db = new Kysely<SyncularAppDb>({ dialect });
    const liveEvents: Array<
      SyncularLiveQueryEvent<{ id: string; title: string }>
    > = [];

    try {
      await dialect.live(
        db
          .selectFrom('tasks')
          .select(['id', 'title'])
          .where('id', '=', scenario.rowId),
        {
          onChange(rows, event) {
            liveEvents.push({ ...event, rows });
          },
        }
      );
      expect(liveEvents).toHaveLength(1);
      expect(liveEvents[0]).toMatchObject({
        initial: true,
        rows: [{ id: scenario.rowId, title: scenario.localTitle }],
      });

      await expect(client.syncPush()).resolves.toMatchObject({
        pushedCommits: 0,
      });
      expect(liveEvents).toHaveLength(1);
      await expect(liveQueryDiagnostics(client)).resolves.toMatchObject({
        queries: [
          {
            dependencyHintCount: 1,
            rerunCount: 0,
            emittedEventCount: 0,
          },
        ],
      });

      const conflicts = await client.conflictSummaries();
      expect(conflicts).toHaveLength(scenario.expectedInitialConflictCount);
      await expect(
        client.resolveConflict(conflicts[0]!.id, scenario.keepServerResolution)
      ).resolves.toBeUndefined();
      await expect(client.conflictSummaries()).resolves.toHaveLength(
        scenario.expectedAfterResolveConflictCount
      );
      expect(liveEvents).toHaveLength(1);
      await expect(liveQueryDiagnostics(client)).resolves.toMatchObject({
        queries: [
          {
            dependencyHintCount: 1,
            rerunCount: 0,
            emittedEventCount: 0,
          },
        ],
      });
    } finally {
      await dialect.destroyLiveQueries();
      await db.destroy();
    }
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
    await client.applyMutation(
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
    await client.applyMutation(
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
    await client.applyMutation(
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
    await client.applyMutation(
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
    await seeder.applyMutation(
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
    await client.applyMutation(
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

    const unsafe = client as unknown as SyncularUnsafeSqlClient;
    const conflictRows = await unsafe.executeUnsafeSql<{
      server_row_json: string;
    }>('select server_row_json from sync_conflicts');
    expect(conflictRows.rows).toHaveLength(
      scenario.conflict.expectedConflictCount
    );
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
    await seeder.applyMutation(
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
    await reader.client.setSubscriptions([
      taskSubscription({ actorId: ACTOR_A }),
    ]);
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

    const blobEvents: Array<
      SyncularLiveQueryEvent<{ id: string; image: unknown }>
    > = [];
    const live = await reader.dialect.live(
      reader.db
        .selectFrom('tasks')
        .select(['id', 'image'])
        .where('id', '=', scenario.task.id),
      {
        onChange(rows, event) {
          blobEvents.push({ ...event, rows });
        },
      }
    );
    try {
      expect(blobEvents).toHaveLength(1);
      expect(blobEvents[0]).toMatchObject({
        initial: true,
        rows: [{ id: scenario.task.id, image: expect.anything() }],
      });

      const updatedImage = await source.blobs.store(
        new TextEncoder().encode(`${syncConformance.blob.browserText} updated`),
        { mimeType: syncConformance.blob.textMimeType }
      );
      await expect(source.blobs.processUploadQueue()).resolves.toEqual(
        syncConformance.blob.expectedProcessUploaded
      );
      await source.client.applyMutation(
        {
          table: 'tasks',
          row_id: scenario.task.id,
          op: 'upsert',
          payload: {
            title: scenario.task.title,
            completed: 0,
            user_id: ACTOR_A,
            image: updatedImage,
          },
          base_version: 1,
        },
        {
          id: scenario.task.id,
          title: scenario.task.title,
          completed: 0,
          user_id: ACTOR_A,
          project_id: null,
          server_version: 1,
          image: updatedImage,
          title_yjs_state: null,
        }
      );
      await expect(source.client.syncPush()).resolves.toMatchObject({
        pushedCommits: 1,
      });
      await reader.client.syncPull();

      expect(blobEvents).toHaveLength(2);
      expect(blobEvents[1]).toMatchObject({
        initial: false,
        rows: [{ id: scenario.task.id, image: expect.anything() }],
        changedRows: [
          expect.objectContaining({
            table: 'tasks',
            rowId: scenario.task.id,
            changedFields: expect.arrayContaining(['image']),
          }),
        ],
      });
      await expect(liveQueryDiagnostics(reader.client)).resolves.toMatchObject({
        queries: [
          {
            dependencyHintCount: 1,
            rerunCount: 1,
            emittedEventCount: 1,
          },
        ],
      });
    } finally {
      await live.unsubscribe();
    }
  });

  it('applies a generated app server-merge CRDT field through the Rust WASM worker', async () => {
    const syncExchanges: Array<{
      request: SyncCombinedRequest;
      response: SyncCombinedResponse;
    }> = [];
    const sync = await createHonoSyncHarness({
      actors: [{ actorId: ACTOR_A, token: TOKEN_A }],
      observeSyncExchange: async ({ request, response }) => {
        if (request.method !== 'POST') return;
        syncExchanges.push({
          request: (await request.json()) as SyncCombinedRequest,
          response: await readCombinedResponse(response),
        });
      },
    });
    harnesses.push(sync);

    const client = await sync.openWorkerClient({
      clientId: 'client-rust-crdt-field-server-merge-a',
      actorId: ACTOR_A,
      getHeaders: () => ({ authorization: TOKEN_A }),
    });
    await client.setSubscriptions([taskSubscription({ actorId: ACTOR_A })]);
    const field = {
      table: 'tasks',
      rowId: 'crdt-field-server-merge-task',
      field: 'title',
    };
    await insertBlankTask(client, field.rowId);
    await client.syncOnce();

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
        nextText: 'CRDT field title v1',
      })
    ).resolves.toMatchObject({ syncMode: 'server-merge' });

    const materialized = await client.materializeCrdtField(field);
    expect(materialized).toMatchObject({
      value: 'CRDT field title v1',
      stateBase64: expect.any(String),
      stateVectorBase64: expect.any(String),
    });
    await expect(client.snapshotCrdtFieldStateVector(field)).resolves.toEqual({
      stateVectorBase64: expect.any(String),
    });
    await expect(client.compactCrdtField(field)).resolves.toMatchObject({
      checkpointCreated: false,
      clientCommitId: null,
      before: {
        stateVectorBase64: expect.any(String),
      },
      after: {
        stateVectorBase64: expect.any(String),
        compactedAt: expect.any(Number),
      },
    });
    await expect(client.listTable('tasks')).resolves.toContainEqual(
      expect.objectContaining({
        id: field.rowId,
        title: 'CRDT field title v1',
        title_yjs_state: expect.any(String),
      })
    );

    await client.syncOnce();

    const reader = await sync.openWorkerClient({
      clientId: 'client-rust-crdt-field-server-merge-b',
      actorId: ACTOR_A,
      fileName: 'reader.sqlite',
      getHeaders: () => ({ authorization: TOKEN_A }),
    });
    await reader.setSubscriptions([taskSubscription({ actorId: ACTOR_A })]);
    await reader.syncOnce();
    const readerMaterialized = await reader.materializeCrdtField(field);
    expect(readerMaterialized).toMatchObject({
      value: 'CRDT field title v1',
      stateVectorBase64: expect.any(String),
    });
    const readerSnapshot = await reader.crdtDocumentSnapshot(field);
    expect(readerSnapshot).toMatchObject({
      stateVectorBase64: readerMaterialized.stateVectorBase64,
    });

    await client.applyCrdtFieldText({
      ...field,
      nextText: 'CRDT field title v2',
    });
    await client.syncOnce();
    await reader.syncOnce();

    await expect(reader.listTable('tasks')).resolves.toContainEqual(
      expect.objectContaining({
        id: field.rowId,
        title: 'CRDT field title v2',
        title_yjs_state: expect.any(String),
      })
    );

    const readerPullRequests = syncExchanges
      .filter(
        (exchange) =>
          exchange.request.clientId === 'client-rust-crdt-field-server-merge-b'
      )
      .flatMap((exchange) => exchange.request.pull?.subscriptions ?? []);
    const taskSubscriptionRequest = readerPullRequests.find(
      (subscription) =>
        subscription.id === 'sub-tasks' &&
        subscription.crdtStateVectors.length > 0
    );
    expect(taskSubscriptionRequest?.crdtStateVectors).toEqual([
      expect.objectContaining({
        rowId: field.rowId,
        field: field.field,
        stateColumn: 'title_yjs_state',
        stateVectorBase64: readerSnapshot.stateVectorBase64,
        syncMode: 'server-merge',
        updatedAt: expect.any(Number),
      }),
    ]);

    const serverDiffRow = syncExchanges
      .filter(
        (exchange) =>
          exchange.request.clientId === 'client-rust-crdt-field-server-merge-b'
      )
      .flatMap((exchange) => exchange.response.pull?.subscriptions ?? [])
      .flatMap((subscription) => subscription.commits ?? [])
      .flatMap((commit) => commit.changes ?? [])
      .map((change) => change.row_json)
      .find(
        (row): row is Record<string, unknown> =>
          typeof row === 'object' &&
          row !== null &&
          '__yjs' in row &&
          !('title_yjs_state' in row)
      );
    expect(serverDiffRow?.__yjs).toMatchObject({
      title: {
        updateBase64: expect.any(String),
        requiresStateVectorBase64: readerSnapshot.stateVectorBase64,
      },
    });

    const diagnostics: Array<{
      code: string;
      details?: Record<string, unknown>;
    }> = [];
    const removeDiagnostics = reader.addDiagnosticListener((event) => {
      diagnostics.push(event);
    });
    const unsafeReader = reader as unknown as SyncularUnsafeSqlClient;
    await unsafeReader.executeUnsafeSql(
      'update tasks set title_yjs_state = null where id = ?',
      [field.rowId]
    );

    await client.applyCrdtFieldText({
      ...field,
      nextText: 'CRDT field title v3',
    });
    await client.syncOnce();

    await expect(reader.syncOnce()).rejects.toThrow(
      /full snapshot resync required/
    );
    removeDiagnostics();
    expect(diagnostics).toContainEqual(
      expect.objectContaining({
        code: 'sync.resync_required',
        details: expect.objectContaining({ resyncRequired: true }),
      })
    );

    const resetCount = await reader.forceSubscriptionsBootstrap();
    expect(resetCount).toBeGreaterThan(0);
    await reader.syncOnce();
    await expect(reader.listTable('tasks')).resolves.toContainEqual(
      expect.objectContaining({
        id: field.rowId,
        title: 'CRDT field title v3',
        title_yjs_state: expect.any(String),
      })
    );

    const recoverySubscription = syncExchanges
      .filter(
        (exchange) =>
          exchange.request.clientId === 'client-rust-crdt-field-server-merge-b'
      )
      .flatMap((exchange) => exchange.request.pull?.subscriptions ?? [])
      .findLast((subscription) => subscription.id === 'sub-tasks');
    expect(recoverySubscription?.cursor).toBe(-1);
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

    const unsafe = client as unknown as SyncularUnsafeSqlClient;
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
    expect(
      outboxRows.rows.some((row) => row.operations_json.includes(plaintext))
    ).toBe(false);

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
  source: SyncularRuntimeClient,
  target: SyncularRuntimeClient,
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
  await source.applyMutation(
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

async function liveQueryDiagnostics(
  client: SyncularRuntimeClient
): Promise<SyncularLiveQueryDiagnostics> {
  const diagnostics = client as SyncularRuntimeClient & {
    liveQueryDiagnostics(): Promise<SyncularLiveQueryDiagnostics>;
  };
  return diagnostics.liveQueryDiagnostics();
}

async function waitForSyncRequestEventByTrace(
  sync: HonoSyncHarness,
  traceId: string,
  eventType: 'pull' | 'push'
): Promise<{
  trace_id: string | null;
  span_id: string | null;
  event_type: string;
  client_id: string;
  actor_id: string;
  outcome: string;
}> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const result = await sql<{
      trace_id: string | null;
      span_id: string | null;
      event_type: string;
      client_id: string;
      actor_id: string;
      outcome: string;
    }>`
      SELECT trace_id, span_id, event_type, client_id, actor_id, outcome
      FROM sync_request_events
      WHERE trace_id = ${traceId}
        AND event_type = ${eventType}
      ORDER BY event_id DESC
      LIMIT 1
    `.execute(sync.db);
    const row = result.rows[0];
    if (row) return row;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for sync_request_events trace ${traceId}`);
}

async function waitForLifecycle(
  events: readonly SyncularLifecycleState[],
  predicate: (event: SyncularLifecycleState) => boolean
): Promise<SyncularLifecycleState> {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    for (let index = events.length - 1; index >= 0; index -= 1) {
      const event = events[index];
      if (event && predicate(event)) return event;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('Timed out waiting for lifecycle event');
}

function waitForRetryBackoff(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 1_100));
}

async function insertBlankTask(
  client: SyncularRuntimeClient,
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
  await client.applyMutation(
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

function encryptedTitleCrdtAppSchema(): SyncularAppSchema {
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
