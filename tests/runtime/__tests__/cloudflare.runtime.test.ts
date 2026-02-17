/**
 * Cloudflare Worker runtime tests — proves the real CF Worker + Durable Object
 * + WebSocket path works end-to-end.
 *
 * Spawns wrangler dev --local (miniflare), sends HTTP + WebSocket requests.
 * Gated behind SYNCULAR_TEST_RUN_CLOUDFLARE=true.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import path from 'node:path';
import { isRecord, type SyncCombinedResponse } from '@syncular/core';
import {
  createRealtimeWsUrl,
  createSyncCombinedRequest,
  createSyncSubscription,
  createSyncUpsertOperation,
  findSubscriptionChange,
  postSyncCombinedRequest,
  subscriptionChangeRow,
  waitForWsJsonMessage,
  withRealtimeWs,
} from '@syncular/testkit';
import {
  getNativeFetch,
  pickFreePort,
  shutdown,
  waitForHealthy,
} from '../shared/utils';

const _fetch = getNativeFetch();

/** Random suffix so IDs are unique across test runs (miniflare persists state). */
const RUN = crypto.randomUUID().slice(0, 8);

const ACTOR_HEADER = 'x-user-id';
const TASKS_SUBSCRIPTION_ID = 'sub-tasks';
const DEFAULT_PROJECT_ID = 'p0';

function isEnabled(): boolean {
  return process.env.SYNCULAR_TEST_RUN_CLOUDFLARE === 'true';
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function createTasksSubscription(userId: string) {
  return createSyncSubscription({
    id: TASKS_SUBSCRIPTION_ID,
    table: 'tasks',
    scopes: { user_id: userId, project_id: DEFAULT_PROJECT_ID },
    cursor: 0,
    bootstrapState: null,
  });
}

function createTaskOperation(taskId: string, title: string) {
  return createSyncUpsertOperation({
    table: 'tasks',
    rowId: taskId,
    payload: {
      title,
      completed: 0,
      project_id: DEFAULT_PROJECT_ID,
    },
    baseVersion: null,
  });
}

async function postWorkerSync(
  workerUrl: string,
  userId: string,
  body: ReturnType<typeof createSyncCombinedRequest>
): Promise<{ response: Response; json: SyncCombinedResponse }> {
  return postSyncCombinedRequest({
    fetch: _fetch,
    url: `${workerUrl}/sync`,
    actorId: userId,
    actorHeader: ACTOR_HEADER,
    body,
  });
}

function taskRowFromCombinedResponse(
  response: SyncCombinedResponse,
  taskId: string
): Record<string, unknown> | undefined {
  return subscriptionChangeRow(
    findSubscriptionChange(
      response.pull?.subscriptions,
      TASKS_SUBSCRIPTION_ID,
      taskId
    )
  );
}

async function registerTasksScopes(
  workerUrl: string,
  userId: string,
  clientId: string
): Promise<void> {
  await postWorkerSync(
    workerUrl,
    userId,
    createSyncCombinedRequest({
      clientId,
      pull: {
        limitCommits: 50,
        subscriptions: [createTasksSubscription(userId)],
      },
    })
  );
}

function createRealtimeSocketOptions(
  workerUrl: string,
  userId: string,
  clientId: string
) {
  return {
    baseUrl: workerUrl,
    path: '/sync/realtime',
    actorQueryParam: 'userId',
    actorId: userId,
    clientId,
  } as const;
}

async function sha256(content: Uint8Array): Promise<string> {
  const view = content.buffer;
  const digestInput =
    view instanceof ArrayBuffer
      ? view.slice(content.byteOffset, content.byteOffset + content.byteLength)
      : content.slice().buffer;

  const hashBuffer = await crypto.subtle.digest('SHA-256', digestInput);
  const hashHex = Array.from(new Uint8Array(hashBuffer))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
  return `sha256:${hashHex}`;
}

describe('Cloudflare Worker + Durable Object runtime', () => {
  let wranglerProc: ReturnType<typeof Bun.spawn>;
  let workerUrl: string;

  beforeAll(async () => {
    if (!isEnabled()) return;

    const workerPort = await pickFreePort();
    const wranglerBin = path.join(
      process.cwd(),
      'node_modules',
      '.bin',
      'wrangler'
    );
    const configPath = path.resolve(
      import.meta.dir,
      '../apps/cloudflare/wrangler.toml'
    );

    wranglerProc = Bun.spawn(
      [
        wranglerBin,
        'dev',
        '--local',
        '--ip',
        '127.0.0.1',
        '--port',
        String(workerPort),
        '--config',
        configPath,
      ],
      {
        cwd: path.resolve(import.meta.dir, '../apps/cloudflare'),
        env: { ...process.env },
        stdin: 'ignore',
        stdout: 'pipe',
        stderr: 'pipe',
      }
    );

    workerUrl = `http://127.0.0.1:${workerPort}`;
    await waitForHealthy(workerUrl, 30_000);
  });

  afterAll(async () => {
    if (wranglerProc) await shutdown(wranglerProc);
  });

  // -------------------------------------------------------------------------
  // 1. Worker boots and health endpoint responds
  // -------------------------------------------------------------------------

  it.skipIf(!isEnabled())('worker boots and /health responds ok', async () => {
    const res = await _fetch(`${workerUrl}/health`);
    expect(res.status).toBe(200);
    const json = (await res.json()) as { status: string };
    expect(json.status).toBe('ok');
  });

  // -------------------------------------------------------------------------
  // 2. HTTP push + pull through Durable Object
  // -------------------------------------------------------------------------

  it.skipIf(!isEnabled())(
    'HTTP push + pull through Durable Object',
    async () => {
      const userId = `cf-test-user-${RUN}`;
      const clientId = `cf-client-1-${RUN}`;
      const taskId = `cf-task-1-${RUN}`;

      const { response: pushRes, json: pushJson } = await postWorkerSync(
        workerUrl,
        userId,
        createSyncCombinedRequest({
          clientId,
          push: {
            clientCommitId: `commit-1-${RUN}`,
            operations: [createTaskOperation(taskId, 'CF Test Task')],
            schemaVersion: 1,
          },
        })
      );

      expect(pushRes.status).toBe(200);
      expect(pushJson.ok).toBe(true);
      expect(pushJson.push?.status).toBe('applied');

      const { response: pullRes, json: pullJson } = await postWorkerSync(
        workerUrl,
        userId,
        createSyncCombinedRequest({
          clientId,
          pull: {
            limitCommits: 50,
            subscriptions: [createTasksSubscription(userId)],
          },
        })
      );

      expect(pullRes.status).toBe(200);
      expect(pullJson.ok).toBe(true);

      const taskRow = taskRowFromCombinedResponse(pullJson, taskId);
      expect(taskRow).toBeDefined();
      expect(taskRow?.title).toBe('CF Test Task');
    }
  );

  // -------------------------------------------------------------------------
  // 3. WebSocket connects to realtime endpoint
  // -------------------------------------------------------------------------

  it.skipIf(!isEnabled())('WebSocket connects to /sync/realtime', async () => {
    const wsClientId = `ws-client-1-${RUN}`;
    const wsUserId = `ws-user-1-${RUN}`;

    const wsUrl = createRealtimeWsUrl({
      baseUrl: workerUrl,
      path: '/sync/realtime',
      actorQueryParam: 'userId',
      actorId: wsUserId,
      clientId: wsClientId,
    });

    await withRealtimeWs(
      {
        ...createRealtimeSocketOptions(workerUrl, wsUserId, wsClientId),
        waitForOpen: true,
        openTimeoutMs: 10_000,
      },
      async (ws) => {
        expect(ws.url).toBe(wsUrl);
      }
    );
  });

  // -------------------------------------------------------------------------
  // 4. Two-client sync — Client A pushes, Client B pulls
  // -------------------------------------------------------------------------

  it.skipIf(!isEnabled())('two-client sync: A pushes, B pulls', async () => {
    const userId = `cf-multi-user-${RUN}`;
    const clientA = `cf-client-A-${RUN}`;
    const clientB = `cf-client-B-${RUN}`;
    const taskId = `cf-multi-task-1-${RUN}`;

    const { response: pushRes, json: pushJson } = await postWorkerSync(
      workerUrl,
      userId,
      createSyncCombinedRequest({
        clientId: clientA,
        push: {
          clientCommitId: `multi-commit-1-${RUN}`,
          operations: [createTaskOperation(taskId, 'Multi-client Task')],
          schemaVersion: 1,
        },
      })
    );

    expect(pushRes.status).toBe(200);
    expect(pushJson.push?.status).toBe('applied');

    const { response: pullRes, json: pullJson } = await postWorkerSync(
      workerUrl,
      userId,
      createSyncCombinedRequest({
        clientId: clientB,
        pull: {
          limitCommits: 50,
          subscriptions: [createTasksSubscription(userId)],
        },
      })
    );

    expect(pullRes.status).toBe(200);
    expect(pullJson.ok).toBe(true);

    const taskRow = taskRowFromCombinedResponse(pullJson, taskId);
    expect(taskRow).toBeDefined();
    expect(taskRow?.title).toBe('Multi-client Task');
  });

  // -------------------------------------------------------------------------
  // 5. WebSocket sync notification — push triggers WS event
  // -------------------------------------------------------------------------

  it.skipIf(!isEnabled())('WebSocket sync notification on push', async () => {
    const userId = `cf-ws-notify-user-${RUN}`;
    const wsClientId = `cf-ws-notify-client-${RUN}`;
    const pushClientId = `cf-push-notify-client-${RUN}`;

    await registerTasksScopes(workerUrl, userId, wsClientId);

    await withRealtimeWs(
      {
        ...createRealtimeSocketOptions(workerUrl, userId, wsClientId),
        waitForOpen: true,
        openTimeoutMs: 10_000,
      },
      async (ws) => {
        const syncEventPromise = waitForWsJsonMessage(ws, {
          timeoutMs: 5_000,
          predicate: (message) => message.event === 'sync',
        });

        const { response: pushRes } = await postWorkerSync(
          workerUrl,
          userId,
          createSyncCombinedRequest({
            clientId: pushClientId,
            push: {
              clientCommitId: `ws-notify-commit-1-${RUN}`,
              operations: [
                createTaskOperation(
                  `cf-ws-notify-task-1-${RUN}`,
                  'WS Notify Task'
                ),
              ],
              schemaVersion: 1,
            },
            pull: {
              limitCommits: 50,
              subscriptions: [createTasksSubscription(userId)],
            },
          })
        );

        expect(pushRes.status).toBe(200);

        const syncEvent = await syncEventPromise;
        expect(syncEvent.event).toBe('sync');
        expect(isRecord(syncEvent.data)).toBe(true);
        if (isRecord(syncEvent.data)) {
          expect(syncEvent.data.cursor).toBeDefined();
        }
      }
    );
  });

  // -------------------------------------------------------------------------
  // 6. Blob lifecycle — upload + complete + download
  // -------------------------------------------------------------------------

  it.skipIf(!isEnabled())(
    'blob lifecycle: upload, complete, download',
    async () => {
      const userId = `cf-blob-user-${RUN}`;
      const content = new Uint8Array(256);
      crypto.getRandomValues(content);
      const hash = await sha256(content);

      const initiateRes = await _fetch(`${workerUrl}/sync/blobs/upload`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          [ACTOR_HEADER]: userId,
        },
        body: JSON.stringify({
          hash,
          size: content.byteLength,
          mimeType: 'application/octet-stream',
        }),
      });

      expect(initiateRes.status).toBe(200);
      const initiateJson = (await initiateRes.json()) as {
        uploadUrl: string;
        method: string;
        headers?: Record<string, string>;
      };
      expect(initiateJson.uploadUrl).toBeDefined();

      const uploadUrl = initiateJson.uploadUrl.startsWith('http')
        ? initiateJson.uploadUrl
        : `${workerUrl}${initiateJson.uploadUrl}`;

      const uploadRes = await _fetch(uploadUrl, {
        method: initiateJson.method ?? 'PUT',
        headers: {
          'content-type': 'application/octet-stream',
          ...(initiateJson.headers ?? {}),
        },
        body: content,
      });

      expect(uploadRes.status).toBeLessThan(300);

      const completeRes = await _fetch(
        `${workerUrl}/sync/blobs/${encodeURIComponent(hash)}/complete`,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            [ACTOR_HEADER]: userId,
          },
        }
      );

      expect(completeRes.status).toBe(200);
      const completeJson = (await completeRes.json()) as { ok: boolean };
      expect(completeJson.ok).toBe(true);

      const urlRes = await _fetch(
        `${workerUrl}/sync/blobs/${encodeURIComponent(hash)}/url`,
        {
          headers: { [ACTOR_HEADER]: userId },
        }
      );

      expect(urlRes.status).toBe(200);
      const urlJson = (await urlRes.json()) as { url: string };
      expect(urlJson.url).toBeDefined();

      const downloadUrl = urlJson.url.startsWith('http')
        ? urlJson.url
        : `${workerUrl}${urlJson.url}`;

      const downloadRes = await _fetch(downloadUrl);
      expect(downloadRes.status).toBe(200);

      const downloaded = new Uint8Array(await downloadRes.arrayBuffer());
      expect(downloaded.length).toBe(content.length);
      expect(downloaded).toEqual(content);
    }
  );

  // -------------------------------------------------------------------------
  // 7. Blob deduplication — second upload returns exists: true
  // -------------------------------------------------------------------------

  it.skipIf(!isEnabled())(
    'blob deduplication: second initiate returns exists',
    async () => {
      const userId = `cf-blob-dedup-user-${RUN}`;

      const content = new Uint8Array(128);
      crypto.getRandomValues(content);
      const hash = await sha256(content);

      const initHeaders = {
        'content-type': 'application/json',
        [ACTOR_HEADER]: userId,
      };
      const initBody = JSON.stringify({
        hash,
        size: content.byteLength,
        mimeType: 'application/octet-stream',
      });

      const init1 = await _fetch(`${workerUrl}/sync/blobs/upload`, {
        method: 'POST',
        headers: initHeaders,
        body: initBody,
      });
      expect(init1.status).toBe(200);
      const init1Json = (await init1.json()) as {
        uploadUrl: string;
        method: string;
      };

      const uploadUrl = init1Json.uploadUrl.startsWith('http')
        ? init1Json.uploadUrl
        : `${workerUrl}${init1Json.uploadUrl}`;

      await _fetch(uploadUrl, {
        method: init1Json.method ?? 'PUT',
        headers: { 'content-type': 'application/octet-stream' },
        body: content,
      });

      await _fetch(
        `${workerUrl}/sync/blobs/${encodeURIComponent(hash)}/complete`,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            [ACTOR_HEADER]: userId,
          },
        }
      );

      const init2 = await _fetch(`${workerUrl}/sync/blobs/upload`, {
        method: 'POST',
        headers: initHeaders,
        body: initBody,
      });
      expect(init2.status).toBe(200);
      const init2Json = (await init2.json()) as { exists?: boolean };
      expect(init2Json.exists).toBe(true);
    }
  );

  // -------------------------------------------------------------------------
  // 8. WebSocket reconnection — close WS #1, open WS #2, verify events
  // -------------------------------------------------------------------------

  it.skipIf(!isEnabled())(
    'WebSocket reconnection receives events',
    async () => {
      const userId = `cf-ws-recon-user-${RUN}`;
      const wsClientId = `cf-ws-recon-client-${RUN}`;
      const pushClientId = `cf-ws-recon-pusher-${RUN}`;

      await registerTasksScopes(workerUrl, userId, wsClientId);

      await withRealtimeWs(
        {
          ...createRealtimeSocketOptions(workerUrl, userId, wsClientId),
          waitForOpen: true,
          openTimeoutMs: 10_000,
        },
        async () => {}
      );
      await sleep(500);

      await withRealtimeWs(
        {
          ...createRealtimeSocketOptions(workerUrl, userId, wsClientId),
          waitForOpen: true,
          openTimeoutMs: 10_000,
        },
        async (ws2) => {
          const syncEventPromise = waitForWsJsonMessage(ws2, {
            timeoutMs: 5_000,
            predicate: (message) => message.event === 'sync',
          });

          const { response: pushRes } = await postWorkerSync(
            workerUrl,
            userId,
            createSyncCombinedRequest({
              clientId: pushClientId,
              push: {
                clientCommitId: `ws-recon-commit-${RUN}`,
                operations: [
                  createTaskOperation(
                    `cf-ws-recon-task-${RUN}`,
                    'WS Reconnect Task'
                  ),
                ],
                schemaVersion: 1,
              },
              pull: {
                limitCommits: 50,
                subscriptions: [createTasksSubscription(userId)],
              },
            })
          );

          expect(pushRes.status).toBe(200);

          const syncEvent = await syncEventPromise;
          expect(syncEvent.event).toBe('sync');
        }
      );
    }
  );
});
