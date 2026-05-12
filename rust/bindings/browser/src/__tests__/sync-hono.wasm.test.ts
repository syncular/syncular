import { afterEach, describe, expect, it } from 'bun:test';
import { taskSubscription } from '../../../../examples/todo-app/generated/typescript/syncular.generated';
import {
  createHonoSyncHarness,
  type HonoSyncHarness,
} from './fixtures/hono-sync-harness';

const ACTOR_A = 'user-owner-a';
const ACTOR_B = 'user-owner-b';
const TOKEN_A = 'Bearer owner-a';
const TOKEN_B = 'Bearer owner-b';

describe('Syncular v2 worker sync protocol against Hono routes', () => {
  const harnesses: HonoSyncHarness[] = [];

  afterEach(async () => {
    while (harnesses.length > 0) await harnesses.pop()!.close();
  });

  it('surfaces server client-id ownership conflicts without auth refresh', async () => {
    const sync = await createHonoSyncHarness({
      actors: [
        { actorId: ACTOR_A, token: TOKEN_A },
        { actorId: ACTOR_B, token: TOKEN_B },
      ],
    });
    harnesses.push(sync);

    const first = await sync.openWorkerClient({
      clientId: 'client-rust-owner-conflict',
      actorId: ACTOR_A,
      fileName: 'client-rust-owner-conflict-a.sqlite',
      getHeaders: () => ({ authorization: TOKEN_A }),
    });
    await first.setSubscriptions([taskSubscription({ actorId: ACTOR_A })]);
    await expect(first.syncOnce()).resolves.toMatchObject({
      pushedCommits: 0,
    });

    let refreshCount = 0;
    const second = await sync.openWorkerClient({
      clientId: 'client-rust-owner-conflict',
      actorId: ACTOR_B,
      fileName: 'client-rust-owner-conflict-b.sqlite',
      getHeaders: () => ({ authorization: TOKEN_B }),
      authLifecycle: {
        refreshToken: () => {
          refreshCount += 1;
          return true;
        },
      },
    });
    await second.setSubscriptions([taskSubscription({ actorId: ACTOR_B })]);

    await expect(second.syncOnce()).rejects.toThrow(/HTTP 400/);
    expect(refreshCount).toBe(0);
  });

  it('clears scoped local rows when a server subscription is revoked', async () => {
    const sync = await createHonoSyncHarness({
      actors: [{ actorId: ACTOR_A, token: TOKEN_A }],
      seedTasks: [
        {
          id: 'revoked-task',
          title: 'revoked task',
          actorId: ACTOR_A,
        },
      ],
    });
    harnesses.push(sync);

    const client = await sync.openWorkerClient({
      clientId: 'client-rust-revoked-subscription',
      actorId: ACTOR_A,
      getHeaders: () => ({ authorization: TOKEN_A }),
    });
    await client.setSubscriptions([taskSubscription({ actorId: ACTOR_A })]);
    await client.syncOnce();
    await expect(client.listTable('tasks')).resolves.toContainEqual(
      expect.objectContaining({ id: 'revoked-task', user_id: ACTOR_A })
    );

    await client.setSubscriptions([taskSubscription({ actorId: ACTOR_B })]);
    const result = await client.syncOnce();

    expect(result.subscriptions[0]).toMatchObject({
      id: 'sub-tasks',
      table: 'tasks',
      status: 'revoked',
      scopes: {},
    });
    await expect(client.listTable('tasks')).resolves.toEqual([]);
  });

  it('does not partially apply chunked snapshots when chunk fetch fails', async () => {
    const sync = await createHonoSyncHarness({
      actors: [{ actorId: ACTOR_A, token: TOKEN_A }],
      snapshotBundleMaxBytes: 1,
      seedTasks: [
        {
          id: 'chunk-server-task',
          title: 'chunk server task',
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
      clientId: 'client-rust-snapshot-chunk-failure',
      actorId: ACTOR_A,
      getHeaders: () => ({ authorization: TOKEN_A }),
    });
    await client.executeSql(
      `insert into tasks (
        id, title, completed, user_id, project_id, server_version, image, title_yjs_state
      ) values (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        'chunk-local-task',
        'local before failed chunk',
        0,
        ACTOR_A,
        null,
        0,
        null,
        null,
      ]
    );
    await client.setSubscriptions([taskSubscription({ actorId: ACTOR_A })]);

    await expect(client.syncPull()).rejects.toThrow(/HTTP 500/);

    await expect(client.listTable('tasks')).resolves.toEqual([
      expect.objectContaining({
        id: 'chunk-local-task',
        title: 'local before failed chunk',
      }),
    ]);
  });

  it('keeps failed pushes queued until sync retry backoff is due', async () => {
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
      clientId: 'client-rust-sync-retry-backoff',
      actorId: ACTOR_A,
      getHeaders: () => ({ authorization: TOKEN_A }),
    });
    const localRow = {
      id: 'sync-retry-task',
      title: 'retry task',
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

    await expect(client.syncPush()).rejects.toThrow(/HTTP 500/);
    expect(syncPosts).toBe(1);

    await expect(client.syncPush()).resolves.toMatchObject({
      pushedCommits: 0,
    });
    expect(syncPosts).toBe(1);

    await waitForRetryBackoff();
    await expect(client.syncPush()).rejects.toThrow(/HTTP 500/);
    expect(syncPosts).toBe(2);
  });
});

function waitForRetryBackoff(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 1_100));
}
