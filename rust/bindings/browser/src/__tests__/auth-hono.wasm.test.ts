import { afterEach, describe, expect, it } from 'bun:test';
import { createSyncularErrorResponse } from '@syncular/core';
import { taskSubscription } from '../../../../examples/todo-app/generated/typescript/syncular.generated';
import type { SyncularV2Client, SyncularV2LifecycleState } from '../types';
import {
  createHonoSyncHarness,
  type HonoSyncHarness,
} from './fixtures/hono-sync-harness';

const ACTOR_ID = 'user-auth';
const STALE_TOKEN = 'Bearer stale-token';
const FRESH_TOKEN = 'Bearer fresh-token';

describe('Syncular v2 worker auth against Hono sync routes', () => {
  const harnesses: HonoSyncHarness[] = [];

  afterEach(async () => {
    while (harnesses.length > 0) await harnesses.pop()!.close();
  });

  it('refreshes auth headers after a real sync 401 and retries once', async () => {
    const harness = await openAuthHarness({
      clientId: 'client-rust-auth-401',
      expectedStatus: 401,
    });

    const result = await harness.client.syncOnce();

    expect(harness.refreshCount()).toBe(1);
    expect(harness.expiredStatuses).toEqual([401]);
    expect(harness.retryStatuses).toEqual([401]);
    expect(harness.syncRouteAuthHeaders[0]).toBe(STALE_TOKEN);
    expect(harness.syncRouteAuthHeaders).toContain(FRESH_TOKEN);
    expect(harness.syncRouteAuthHeaders.at(-1)).toBe(FRESH_TOKEN);
    expect(result.subscriptions[0]).toMatchObject({
      id: 'sub-tasks',
      table: 'tasks',
      status: 'active',
    });
    await expect(harness.client.listTable('tasks')).resolves.toContainEqual(
      expect.objectContaining({
        id: 'server-task-auth',
        title: 'server auth task',
        user_id: ACTOR_ID,
      })
    );
  });

  it('refreshes auth headers during foreground resume recovery', async () => {
    const harness = await openAuthHarness({
      clientId: 'client-rust-auth-resume',
      expectedStatus: 401,
    });
    const lifecycleEvents: SyncularV2LifecycleState[] = [];
    harness.client.addEventListener('lifecycleChanged', (event) => {
      lifecycleEvents.push(event);
    });

    const result = await harness.client.resumeFromBackground();

    expect(lifecycleEvents.some((event) => event.phase === 'recovering')).toBe(
      true
    );
    expect(harness.refreshCount()).toBe(1);
    expect(harness.expiredStatuses).toEqual([401]);
    expect(harness.retryStatuses).toEqual([401]);
    expect(harness.syncRouteAuthHeaders[0]).toBe(STALE_TOKEN);
    expect(harness.syncRouteAuthHeaders.at(-1)).toBe(FRESH_TOKEN);
    expect(result.subscriptions[0]).toMatchObject({
      id: 'sub-tasks',
      table: 'tasks',
      status: 'active',
    });
    const complete = await waitForLifecycle(
      lifecycleEvents,
      (event) =>
        event.phase === 'complete' && event.bootstrap?.complete === true
    );
    expect(complete).toMatchObject({
      phase: 'complete',
      bootstrap: { complete: true },
    });
  });

  it('refreshes auth headers after a server-side 403 gate and retries once', async () => {
    const harness = await openAuthHarness({
      clientId: 'client-rust-auth-403',
      expectedStatus: 403,
      rejectStaleAtEdgeWith: 403,
    });

    await expect(harness.client.syncOnce()).resolves.toMatchObject({
      pushedCommits: 0,
    });

    expect(harness.refreshCount()).toBe(1);
    expect(harness.expiredStatuses).toEqual([403]);
    expect(harness.retryStatuses).toEqual([403]);
    expect(harness.edgeRejectedAuthHeaders).toEqual([STALE_TOKEN]);
    expect(harness.syncRouteAuthHeaders.length).toBeGreaterThan(0);
    expect(
      harness.syncRouteAuthHeaders.every((header) => header === FRESH_TOKEN)
    ).toBe(true);
  });

  async function openAuthHarness(
    options: AuthHarnessOptions
  ): Promise<AuthHarness> {
    const edgeRejectedAuthHeaders: string[] = [];
    const sync = await createHonoSyncHarness({
      actors: [{ actorId: ACTOR_ID, token: FRESH_TOKEN }],
      seedTasks: [
        {
          id: 'server-task-auth',
          title: 'server auth task',
          actorId: ACTOR_ID,
        },
      ],
      edgeGate: (request) => {
        const authorization = request.headers.get('authorization');
        if (
          options.rejectStaleAtEdgeWith != null &&
          authorization === STALE_TOKEN
        ) {
          edgeRejectedAuthHeaders.push(authorization);
          return Response.json(
            createSyncularErrorResponse('sync.forbidden', {
              message: 'stale token rejected',
            }),
            { status: options.rejectStaleAtEdgeWith }
          );
        }
        return null;
      },
    });
    harnesses.push(sync);

    let token = STALE_TOKEN;
    let refreshCount = 0;
    const expiredStatuses: number[] = [];
    const retryStatuses: number[] = [];
    const client = await sync.openWorkerClient({
      clientId: options.clientId,
      actorId: ACTOR_ID,
      getHeaders: () => ({ authorization: token }),
      authLifecycle: {
        onAuthExpired: ({ operation, status }) => {
          expect(operation).toBe('sync');
          expiredStatuses.push(status);
        },
        refreshToken: async ({ operation, status }) => {
          expect(operation).toBe('sync');
          expect(status).toBe(options.expectedStatus);
          refreshCount += 1;
          token = FRESH_TOKEN;
          return true;
        },
        retryWithFreshToken: ({ status, refreshResult }) => {
          retryStatuses.push(status);
          return refreshResult;
        },
      },
    });
    await client.setSubscriptions([taskSubscription({ actorId: ACTOR_ID })]);

    return {
      client,
      edgeRejectedAuthHeaders,
      expiredStatuses,
      refreshCount: () => refreshCount,
      retryStatuses,
      syncRouteAuthHeaders: sync.syncRouteAuthHeaders,
    };
  }
});

interface AuthHarnessOptions {
  clientId: string;
  expectedStatus: 401 | 403;
  rejectStaleAtEdgeWith?: 403;
}

interface AuthHarness {
  client: SyncularV2Client;
  edgeRejectedAuthHeaders: string[];
  expiredStatuses: number[];
  refreshCount(): number;
  retryStatuses: number[];
  syncRouteAuthHeaders: string[];
}

async function waitForLifecycle(
  events: readonly SyncularV2LifecycleState[],
  predicate: (event: SyncularV2LifecycleState) => boolean
): Promise<SyncularV2LifecycleState> {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    for (let index = events.length - 1; index >= 0; index -= 1) {
      const event = events[index];
      if (event && predicate(event)) return event;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('Timed out waiting for lifecycle event');
}
