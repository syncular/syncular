/**
 * Cloudflare Worker runtime tests — proves the real CF Worker + Durable Object
 * + WebSocket path works end-to-end.
 *
 * Spawns wrangler dev --local (miniflare), sends HTTP + WebSocket requests.
 * Gated behind SYNCULAR_TEST_RUN_CLOUDFLARE=true.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import path from 'node:path';
import {
  getNativeFetch,
  pickFreePort,
  shutdown,
  waitForHealthy,
} from '../shared/utils';

const _fetch = getNativeFetch();

/** Random suffix so IDs are unique across test runs (miniflare persists state). */
const RUN = crypto.randomUUID().slice(0, 8);

function isEnabled(): boolean {
  return process.env.SYNCULAR_TEST_RUN_CLOUDFLARE === 'true';
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

      // Push a task
      const pushRes = await _fetch(`${workerUrl}/sync`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-user-id': userId,
        },
        body: JSON.stringify({
          clientId,
          push: {
            clientCommitId: `commit-1-${RUN}`,
            operations: [
              {
                table: 'tasks',
                row_id: taskId,
                op: 'upsert',
                payload: {
                  title: 'CF Test Task',
                  completed: 0,
                  project_id: 'p0',
                },
                base_version: null,
              },
            ],
            schemaVersion: 1,
          },
        }),
      });

      expect(pushRes.status).toBe(200);
      const pushJson = (await pushRes.json()) as {
        ok: boolean;
        push?: { status: string; commitSeq?: number };
      };
      expect(pushJson.ok).toBe(true);
      expect(pushJson.push?.status).toBe('applied');

      // Pull — should get back the task we just pushed
      const pullRes = await _fetch(`${workerUrl}/sync`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-user-id': userId,
        },
        body: JSON.stringify({
          clientId,
          pull: {
            limitCommits: 50,
            subscriptions: [
              {
                id: 'sub-tasks',
                table: 'tasks',
                scopes: { user_id: userId, project_id: 'p0' },
                cursor: 0,
                bootstrapState: null,
              },
            ],
          },
        }),
      });

      expect(pullRes.status).toBe(200);
      const pullJson = (await pullRes.json()) as {
        ok: boolean;
        pull?: {
          subscriptions: Array<{
            id: string;
            commits?: Array<{
              changes: Array<{
                row_id: string;
                row_json: Record<string, unknown> | null;
              }>;
            }>;
          }>;
        };
      };
      expect(pullJson.ok).toBe(true);

      // Verify the task appears in the pull response
      const sub = pullJson.pull?.subscriptions?.find(
        (s) => s.id === 'sub-tasks'
      );
      expect(sub).toBeDefined();
      const allChanges = sub?.commits?.flatMap((c) => c.changes) ?? [];
      const taskChange = allChanges.find((ch) => ch.row_id === taskId);
      expect(taskChange).toBeDefined();
      expect(
        (taskChange?.row_json as Record<string, unknown> | null)?.title
      ).toBe('CF Test Task');
    }
  );

  // -------------------------------------------------------------------------
  // 3. WebSocket connects to realtime endpoint
  // -------------------------------------------------------------------------

  it.skipIf(!isEnabled())('WebSocket connects to /sync/realtime', async () => {
    const wsUrl = workerUrl.replace('http://', 'ws://');
    const ws = new WebSocket(
      `${wsUrl}/sync/realtime?clientId=ws-client-1&userId=ws-user-1`
    );

    const received: unknown[] = [];

    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error('WebSocket connect timeout')),
        10_000
      );

      ws.addEventListener('open', () => {
        // Connection established — wait briefly for a heartbeat or just succeed
        setTimeout(() => {
          clearTimeout(timeout);
          resolve();
        }, 2_000);
      });

      ws.addEventListener('message', (event) => {
        try {
          received.push(JSON.parse(String(event.data)));
        } catch {
          received.push(event.data);
        }
      });

      ws.addEventListener('error', (e) => {
        clearTimeout(timeout);
        reject(new Error(`WebSocket error: ${String(e)}`));
      });
    });

    ws.close();

    // If we got here, the WS connected successfully.
    // Heartbeats arrive every 30s by default, so we may or may not have one.
    expect(true).toBe(true);
  });

  // -------------------------------------------------------------------------
  // 4. Two-client sync — Client A pushes, Client B pulls
  // -------------------------------------------------------------------------

  it.skipIf(!isEnabled())('two-client sync: A pushes, B pulls', async () => {
    const userId = `cf-multi-user-${RUN}`;
    const clientA = `cf-client-A-${RUN}`;
    const clientB = `cf-client-B-${RUN}`;
    const taskId = `cf-multi-task-1-${RUN}`;

    // Client A pushes a task
    const pushRes = await _fetch(`${workerUrl}/sync`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-user-id': userId,
      },
      body: JSON.stringify({
        clientId: clientA,
        push: {
          clientCommitId: `multi-commit-1-${RUN}`,
          operations: [
            {
              table: 'tasks',
              row_id: taskId,
              op: 'upsert',
              payload: {
                title: 'Multi-client Task',
                completed: 0,
                project_id: 'p0',
              },
              base_version: null,
            },
          ],
          schemaVersion: 1,
        },
      }),
    });

    expect(pushRes.status).toBe(200);
    const pushJson = (await pushRes.json()) as {
      ok: boolean;
      push?: { status: string };
    };
    expect(pushJson.push?.status).toBe('applied');

    // Client B pulls — should see Client A's task
    const pullRes = await _fetch(`${workerUrl}/sync`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-user-id': userId,
      },
      body: JSON.stringify({
        clientId: clientB,
        pull: {
          limitCommits: 50,
          subscriptions: [
            {
              id: 'sub-tasks',
              table: 'tasks',
              scopes: { user_id: userId, project_id: 'p0' },
              cursor: 0,
              bootstrapState: null,
            },
          ],
        },
      }),
    });

    expect(pullRes.status).toBe(200);
    const pullJson = (await pullRes.json()) as {
      ok: boolean;
      pull?: {
        subscriptions: Array<{
          id: string;
          commits?: Array<{
            changes: Array<{
              row_id: string;
              row_json: Record<string, unknown> | null;
            }>;
          }>;
        }>;
      };
    };
    expect(pullJson.ok).toBe(true);

    const sub = pullJson.pull?.subscriptions?.find((s) => s.id === 'sub-tasks');
    const allChanges = sub?.commits?.flatMap((c) => c.changes) ?? [];
    const taskChange = allChanges.find((ch) => ch.row_id === taskId);
    expect(taskChange).toBeDefined();
    expect(
      (taskChange?.row_json as Record<string, unknown> | null)?.title
    ).toBe('Multi-client Task');
  });

  // -------------------------------------------------------------------------
  // 5. WebSocket sync notification — push triggers WS event
  // -------------------------------------------------------------------------

  it.skipIf(!isEnabled())('WebSocket sync notification on push', async () => {
    const userId = `cf-ws-notify-user-${RUN}`;
    const wsClientId = `cf-ws-notify-client-${RUN}`;
    const pushClientId = `cf-push-notify-client-${RUN}`;

    // First, do a pull to register client scope keys
    await _fetch(`${workerUrl}/sync`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-user-id': userId,
      },
      body: JSON.stringify({
        clientId: wsClientId,
        pull: {
          limitCommits: 50,
          subscriptions: [
            {
              id: 'sub-tasks',
              table: 'tasks',
              scopes: { user_id: userId, project_id: 'p0' },
              cursor: 0,
              bootstrapState: null,
            },
          ],
        },
      }),
    });

    // Open WebSocket for the receiving client
    const wsUrl = workerUrl.replace('http://', 'ws://');
    const ws = new WebSocket(
      `${wsUrl}/sync/realtime?clientId=${wsClientId}&userId=${userId}`
    );

    const syncEvents: Array<{ event: string; data: unknown }> = [];

    const wsReady = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error('WebSocket connect timeout')),
        10_000
      );
      ws.addEventListener('open', () => {
        clearTimeout(timeout);
        resolve();
      });
      ws.addEventListener('error', (e) => {
        clearTimeout(timeout);
        reject(new Error(`WebSocket error: ${String(e)}`));
      });
    });

    ws.addEventListener('message', (event) => {
      try {
        const msg = JSON.parse(String(event.data)) as {
          event: string;
          data: unknown;
        };
        if (msg.event === 'sync') {
          syncEvents.push(msg);
        }
      } catch {
        // ignore non-JSON messages
      }
    });

    await wsReady;

    // Wait a bit for the WS to be fully registered
    await new Promise((r) => setTimeout(r, 500));

    // Push from a different client to trigger a sync notification
    const pushRes = await _fetch(`${workerUrl}/sync`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-user-id': userId,
      },
      body: JSON.stringify({
        clientId: pushClientId,
        push: {
          clientCommitId: `ws-notify-commit-1-${RUN}`,
          operations: [
            {
              table: 'tasks',
              row_id: `cf-ws-notify-task-1-${RUN}`,
              op: 'upsert',
              payload: {
                title: 'WS Notify Task',
                completed: 0,
                project_id: 'p0',
              },
              base_version: null,
            },
          ],
          schemaVersion: 1,
        },
        pull: {
          limitCommits: 50,
          subscriptions: [
            {
              id: 'sub-tasks',
              table: 'tasks',
              scopes: { user_id: userId, project_id: 'p0' },
              cursor: 0,
              bootstrapState: null,
            },
          ],
        },
      }),
    });

    expect(pushRes.status).toBe(200);

    // Wait for the sync event to arrive via WebSocket
    const deadline = Date.now() + 5_000;
    while (syncEvents.length === 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 100));
    }

    ws.close();

    expect(syncEvents.length).toBeGreaterThan(0);
    const syncEvent = syncEvents[0]!;
    expect(syncEvent.event).toBe('sync');
    expect((syncEvent.data as Record<string, unknown>).cursor).toBeDefined();
  });

  // -------------------------------------------------------------------------
  // 6. Blob lifecycle — upload + complete + download
  // -------------------------------------------------------------------------

  it.skipIf(!isEnabled())(
    'blob lifecycle: upload, complete, download',
    async () => {
      const userId = `cf-blob-user-${RUN}`;

      // Generate random content and compute SHA-256 hash
      const content = new Uint8Array(256);
      crypto.getRandomValues(content);
      const hashBuffer = await crypto.subtle.digest('SHA-256', content);
      const hashHex = Array.from(new Uint8Array(hashBuffer))
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('');
      const hash = `sha256:${hashHex}`;

      // 1. Initiate upload
      const initiateRes = await _fetch(`${workerUrl}/sync/blobs/upload`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-user-id': userId,
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
        exists?: boolean;
      };
      expect(initiateJson.uploadUrl).toBeDefined();

      // 2. Upload the content
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

      // 3. Complete upload
      const completeRes = await _fetch(
        `${workerUrl}/sync/blobs/${encodeURIComponent(hash)}/complete`,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-user-id': userId,
          },
        }
      );

      expect(completeRes.status).toBe(200);
      const completeJson = (await completeRes.json()) as {
        ok: boolean;
      };
      expect(completeJson.ok).toBe(true);

      // 4. Get download URL
      const urlRes = await _fetch(
        `${workerUrl}/sync/blobs/${encodeURIComponent(hash)}/url`,
        {
          headers: { 'x-user-id': userId },
        }
      );

      expect(urlRes.status).toBe(200);
      const urlJson = (await urlRes.json()) as { url: string };
      expect(urlJson.url).toBeDefined();

      // 5. Download and verify content matches
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

      // Generate content and hash
      const content = new Uint8Array(128);
      crypto.getRandomValues(content);
      const hashBuffer = await crypto.subtle.digest('SHA-256', content);
      const hashHex = Array.from(new Uint8Array(hashBuffer))
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('');
      const hash = `sha256:${hashHex}`;

      const initHeaders = {
        'content-type': 'application/json',
        'x-user-id': userId,
      };
      const initBody = JSON.stringify({
        hash,
        size: content.byteLength,
        mimeType: 'application/octet-stream',
      });

      // First upload — full flow
      const init1 = await _fetch(`${workerUrl}/sync/blobs/upload`, {
        method: 'POST',
        headers: initHeaders,
        body: initBody,
      });
      expect(init1.status).toBe(200);
      const init1Json = (await init1.json()) as {
        uploadUrl: string;
        method: string;
        exists?: boolean;
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
          headers: { 'content-type': 'application/json', 'x-user-id': userId },
        }
      );

      // Second initiate — should detect the blob already exists
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

      // Register scope keys via pull
      await _fetch(`${workerUrl}/sync`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-user-id': userId,
        },
        body: JSON.stringify({
          clientId: wsClientId,
          pull: {
            limitCommits: 50,
            subscriptions: [
              {
                id: 'sub-tasks',
                table: 'tasks',
                scopes: { user_id: userId, project_id: 'p0' },
                cursor: 0,
                bootstrapState: null,
              },
            ],
          },
        }),
      });

      const wsUrl = workerUrl.replace('http://', 'ws://');

      // Open WS #1 and close it
      const ws1 = new WebSocket(
        `${wsUrl}/sync/realtime?clientId=${wsClientId}&userId=${userId}`
      );
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(
          () => reject(new Error('WS #1 connect timeout')),
          10_000
        );
        ws1.addEventListener('open', () => {
          clearTimeout(timeout);
          resolve();
        });
        ws1.addEventListener('error', (e) => {
          clearTimeout(timeout);
          reject(new Error(`WS #1 error: ${String(e)}`));
        });
      });
      ws1.close();
      // Wait for server to clean up
      await new Promise((r) => setTimeout(r, 500));

      // Open WS #2 with the same clientId
      const ws2 = new WebSocket(
        `${wsUrl}/sync/realtime?clientId=${wsClientId}&userId=${userId}`
      );

      const syncEvents: Array<{ event: string; data: unknown }> = [];

      const ws2Ready = new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(
          () => reject(new Error('WS #2 connect timeout')),
          10_000
        );
        ws2.addEventListener('open', () => {
          clearTimeout(timeout);
          resolve();
        });
        ws2.addEventListener('error', (e) => {
          clearTimeout(timeout);
          reject(new Error(`WS #2 error: ${String(e)}`));
        });
      });

      ws2.addEventListener('message', (event) => {
        try {
          const msg = JSON.parse(String(event.data)) as {
            event: string;
            data: unknown;
          };
          if (msg.event === 'sync') syncEvents.push(msg);
        } catch {
          // ignore
        }
      });

      await ws2Ready;
      await new Promise((r) => setTimeout(r, 500));

      // Push from a different client
      const pushRes = await _fetch(`${workerUrl}/sync`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-user-id': userId,
        },
        body: JSON.stringify({
          clientId: pushClientId,
          push: {
            clientCommitId: `ws-recon-commit-${RUN}`,
            operations: [
              {
                table: 'tasks',
                row_id: `cf-ws-recon-task-${RUN}`,
                op: 'upsert',
                payload: {
                  title: 'WS Reconnect Task',
                  completed: 0,
                  project_id: 'p0',
                },
                base_version: null,
              },
            ],
            schemaVersion: 1,
          },
          pull: {
            limitCommits: 50,
            subscriptions: [
              {
                id: 'sub-tasks',
                table: 'tasks',
                scopes: { user_id: userId, project_id: 'p0' },
                cursor: 0,
                bootstrapState: null,
              },
            ],
          },
        }),
      });

      expect(pushRes.status).toBe(200);

      // Wait for sync event on WS #2
      const deadline = Date.now() + 5_000;
      while (syncEvents.length === 0 && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 100));
      }

      ws2.close();

      expect(syncEvents.length).toBeGreaterThan(0);
      expect(syncEvents[0]!.event).toBe('sync');
    }
  );
});
