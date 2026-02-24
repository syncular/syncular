import { describe, expect, it, mock } from 'bun:test';
import { createDatabase } from '@syncular/core';
import { createPgliteDialect } from '@syncular/dialect-pglite';
import {
  ensureSyncSchema,
  InMemorySyncRealtimeBroadcaster,
  type SyncCoreDb,
} from '@syncular/server';
import { createPostgresServerDialect } from '@syncular/server-dialect-postgres';
import { defineWebSocketHelper } from 'hono/ws';
import {
  createSyncRoutes,
  getSyncRealtimeUnsubscribe,
  getSyncWebSocketConnectionManager,
} from '../routes';

describe('realtime broadcaster bridge', () => {
  it('notifies local WebSocket connections when another instance publishes a commit', async () => {
    const db = createDatabase<SyncCoreDb>({
      dialect: createPgliteDialect(),
      family: 'postgres',
    });
    const dialect = createPostgresServerDialect();
    await ensureSyncSchema(db, dialect);

    const commit = await db
      .insertInto('sync_commits')
      .values({
        partition_id: 'default',
        actor_id: 'u1',
        client_id: 'client-1',
        client_commit_id: 'c1',
        meta: null,
        result_json: null,
      })
      .returning(['commit_seq'])
      .executeTakeFirstOrThrow();

    const commitSeq = Number(commit.commit_seq);

    await db
      .insertInto('sync_changes')
      .values({
        commit_seq: commitSeq,
        partition_id: 'default',
        table: 'tasks',
        row_id: 't1',
        op: 'upsert',
        row_json: { id: 't1' },
        row_version: 1,
        scopes: { user_id: 'u1' },
      })
      .execute();

    const broadcaster = new InMemorySyncRealtimeBroadcaster();
    const upgradeWebSocket = defineWebSocketHelper(async () => {});

    const routes1 = createSyncRoutes({
      db,
      dialect,
      handlers: [],
      authenticate: async () => ({ actorId: 'u1' }),
      sync: {
        websocket: {
          enabled: true,
          upgradeWebSocket,
          heartbeatIntervalMs: 0,
        },
        realtime: { broadcaster, instanceId: 'i1' },
      },
    });

    const routes2 = createSyncRoutes({
      db,
      dialect,
      handlers: [],
      authenticate: async () => ({ actorId: 'u1' }),
      sync: {
        websocket: {
          enabled: true,
          upgradeWebSocket,
          heartbeatIntervalMs: 0,
        },
        realtime: { broadcaster, instanceId: 'i2' },
      },
    });

    const mgr2 = getSyncWebSocketConnectionManager(routes2);
    expect(mgr2).toBeTruthy();

    const onSync = mock((_cursor: number) => {});

    mgr2!.register(
      {
        actorId: 'u1',
        clientId: 'client-2',
        get isOpen() {
          return true;
        },
        sendSync: onSync,
        sendHeartbeat: mock(() => {}),
        sendPresence: mock(() => {}),
        sendError: mock(() => {}),
        close: mock(() => {}),
      },
      ['default::user:u1']
    );

    // Publish without scopeKeys to exercise DB lookup on the receiving instance.
    await broadcaster.publish({
      type: 'commit',
      commitSeq,
      sourceInstanceId: 'i1',
    });
    await new Promise((r) => setTimeout(r, 0));

    expect(onSync).toHaveBeenCalledWith(commitSeq);

    // Echo suppression: instance2 ignores events it originated.
    onSync.mockClear();
    await broadcaster.publish({
      type: 'commit',
      commitSeq,
      sourceInstanceId: 'i2',
    });
    await new Promise((r) => setTimeout(r, 0));

    expect(onSync).not.toHaveBeenCalled();

    getSyncRealtimeUnsubscribe(routes1)?.();
    getSyncRealtimeUnsubscribe(routes2)?.();
    await broadcaster.close();
    await db.destroy();
  });
});
