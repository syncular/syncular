/**
 * Node.js runtime test — proves the sync framework works under native Node.js.
 *
 * Spawns a Node.js process running better-sqlite3 + Hono sync server,
 * then tests push/pull/two-client sync via HTTP.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { type ChildProcess, execSync, spawn } from 'node:child_process';
import path from 'node:path';
import { getNativeFetch } from '../shared/utils';

const _fetch = getNativeFetch();

const RUN = crypto.randomUUID().slice(0, 8);
const REPO_ROOT = path.resolve(import.meta.dir, '../../..');
const ESM_FIX_SCRIPT = path.join(REPO_ROOT, 'config/bin/fix-esm-imports.ts');

describe('Node.js runtime (better-sqlite3)', () => {
  let nodeProc: ChildProcess;
  let serverUrl: string;

  beforeAll(async () => {
    const serverSrc = path.resolve(import.meta.dir, '../apps/node/server.ts');
    const outDir = path.resolve(import.meta.dir, '../apps/node/dist');

    // Bundle for Node — workspace packages are linked via bun, so Node can't
    // resolve them directly. Mark native addons as external.
    execSync(
      `bun build ${serverSrc} --target=node --outdir=${outDir} --external better-sqlite3`,
      { stdio: 'pipe' }
    );

    const bundledScript = path.join(outDir, 'server.js');

    nodeProc = spawn('node', [bundledScript], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env },
    });

    // Wait for the server to print { port } on stdout
    const port = await new Promise<number>((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error('Node server startup timed out')),
        30_000
      );

      let buffer = '';
      nodeProc.stdout!.on('data', (chunk: Buffer) => {
        buffer += chunk.toString();
        const lines = buffer.split('\n');
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const parsed = JSON.parse(line) as { port?: number };
            if (parsed.port) {
              clearTimeout(timeout);
              resolve(parsed.port);
              return;
            }
          } catch {
            // not JSON yet, keep reading
          }
        }
      });

      let stderrBuf = '';
      nodeProc.stderr!.on('data', (chunk: Buffer) => {
        stderrBuf += chunk.toString();
      });

      nodeProc.on('exit', (code) => {
        clearTimeout(timeout);
        reject(
          new Error(
            `Node server exited with code ${code}\nstderr: ${stderrBuf}`
          )
        );
      });
    });

    serverUrl = `http://127.0.0.1:${port}`;
  });

  afterAll(async () => {
    if (nodeProc && nodeProc.exitCode == null) {
      nodeProc.kill('SIGTERM');
      await new Promise<void>((resolve) => {
        const timeout = setTimeout(() => {
          nodeProc.kill('SIGKILL');
          resolve();
        }, 5000);
        nodeProc.on('exit', () => {
          clearTimeout(timeout);
          resolve();
        });
      });
    }
  });

  // -------------------------------------------------------------------------
  // 1. Health check
  // -------------------------------------------------------------------------

  it('server boots and /health responds ok', async () => {
    const res = await _fetch(`${serverUrl}/health`);
    expect(res.status).toBe(200);
    const json = (await res.json()) as { ok: boolean };
    expect(json.ok).toBe(true);
  });

  // -------------------------------------------------------------------------
  // 2. Push + pull through HTTP
  // -------------------------------------------------------------------------

  it('HTTP push + pull works', async () => {
    const userId = `node-user-${RUN}`;
    const clientId = `node-client-${RUN}`;
    const taskId = `node-task-${RUN}`;

    // Push a task
    const pushRes = await _fetch(`${serverUrl}/sync`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-actor-id': userId,
      },
      body: JSON.stringify({
        clientId,
        push: {
          clientCommitId: `node-commit-1-${RUN}`,
          operations: [
            {
              table: 'tasks',
              row_id: taskId,
              op: 'upsert',
              payload: {
                title: 'Node Task',
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
    const pushJson = (await pushRes.json()) as {
      ok: boolean;
      push?: { status: string };
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

    expect(pushJson.push?.status).toBe('applied');

    // Verify task appears in pull response
    const sub = pushJson.pull?.subscriptions?.find((s) => s.id === 'sub-tasks');
    const allChanges = sub?.commits?.flatMap((c) => c.changes) ?? [];
    const taskChange = allChanges.find((ch) => ch.row_id === taskId);
    expect(taskChange).toBeDefined();
    expect(
      (taskChange?.row_json as Record<string, unknown> | null)?.title
    ).toBe('Node Task');
  });

  // -------------------------------------------------------------------------
  // 3. Two-client sync: A pushes, B pulls
  // -------------------------------------------------------------------------

  it('two-client sync: A pushes, B pulls', async () => {
    const userId = `node-2c-user-${RUN}`;
    const taskId = `node-2c-task-${RUN}`;

    // Client A pushes
    const pushRes = await _fetch(`${serverUrl}/sync`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-actor-id': userId,
      },
      body: JSON.stringify({
        clientId: `node-client-a-${RUN}`,
        push: {
          clientCommitId: `node-2c-commit-${RUN}`,
          operations: [
            {
              table: 'tasks',
              row_id: taskId,
              op: 'upsert',
              payload: {
                title: 'Synced Task',
                completed: 1,
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

    // Client B pulls
    const pullRes = await _fetch(`${serverUrl}/sync`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-actor-id': userId,
      },
      body: JSON.stringify({
        clientId: `node-client-b-${RUN}`,
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

    const sub = pullJson.pull?.subscriptions?.find((s) => s.id === 'sub-tasks');
    const allChanges = sub?.commits?.flatMap((c) => c.changes) ?? [];
    const taskChange = allChanges.find((ch) => ch.row_id === taskId);
    expect(taskChange).toBeDefined();
    expect(
      (taskChange?.row_json as Record<string, unknown> | null)?.title
    ).toBe('Synced Task');
    expect(
      (taskChange?.row_json as Record<string, unknown> | null)?.completed
    ).toBe(1);
  });

  it('imports published-style ESM package entries in Node', () => {
    const packageDirs = [
      path.join(REPO_ROOT, 'packages/core'),
      path.join(REPO_ROOT, 'packages/server'),
      path.join(REPO_ROOT, 'packages/relay'),
    ];

    for (const packageDir of packageDirs) {
      execSync('bun run build', { cwd: packageDir, stdio: 'pipe' });
      execSync(`bun ${ESM_FIX_SCRIPT} dist`, {
        cwd: packageDir,
        stdio: 'pipe',
      });
    }

    const smokeScript = [
      `await import(${JSON.stringify(path.join(REPO_ROOT, 'packages/core/dist/index.js'))})`,
      `await import(${JSON.stringify(path.join(REPO_ROOT, 'packages/server/dist/index.js'))})`,
      `await import(${JSON.stringify(path.join(REPO_ROOT, 'packages/relay/dist/index.js'))})`,
    ].join(';');

    execSync(`node --input-type=module -e ${JSON.stringify(smokeScript)}`, {
      cwd: REPO_ROOT,
      stdio: 'pipe',
    });
  });
});
