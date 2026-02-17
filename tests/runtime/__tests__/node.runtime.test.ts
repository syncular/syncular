/**
 * Node.js runtime test — proves the sync framework works under native Node.js.
 *
 * Spawns a Node.js process running better-sqlite3 + Hono sync server,
 * then tests push/pull/two-client sync via HTTP.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { type ChildProcess, execSync, spawn } from 'node:child_process';
import path from 'node:path';
import {
  createProjectScopedTasksSubscription,
  createProjectScopedTaskUpsertOperation,
  findSubscriptionChange,
  postSyncCombinedRequest,
  stopChildProcess,
  subscriptionChangeRow,
  waitForJsonPortFromStdout,
} from '@syncular/testkit';
import { getNativeFetch } from '../shared/utils';

const _fetch = getNativeFetch();

const RUN = crypto.randomUUID().slice(0, 8);
const REPO_ROOT = path.resolve(import.meta.dir, '../../..');
const ESM_FIX_SCRIPT = path.join(REPO_ROOT, 'config/bin/fix-esm-imports.ts');

describe('Node.js runtime (better-sqlite3)', () => {
  const tasksSubId = 'sub-tasks';
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

    const port = await waitForJsonPortFromStdout(nodeProc, {
      processName: 'Node server',
    });

    serverUrl = `http://127.0.0.1:${port}`;
  });

  afterAll(async () => {
    if (nodeProc) {
      await stopChildProcess(nodeProc);
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
    const { response: pushRes, json: pushJson } = await postSyncCombinedRequest(
      {
        fetch: _fetch,
        url: `${serverUrl}/sync`,
        actorId: userId,
        body: {
          clientId,
          push: {
            clientCommitId: `node-commit-1-${RUN}`,
            operations: [
              createProjectScopedTaskUpsertOperation({
                taskId,
                title: 'Node Task',
              }),
            ],
            schemaVersion: 1,
          },
          pull: {
            limitCommits: 50,
            subscriptions: [
              createProjectScopedTasksSubscription({
                id: tasksSubId,
                userId,
              }),
            ],
          },
        },
      }
    );

    expect(pushRes.status).toBe(200);
    expect(pushJson.push?.status).toBe('applied');

    // Verify task appears in pull response
    const taskRow = subscriptionChangeRow(
      findSubscriptionChange(pushJson.pull?.subscriptions, tasksSubId, taskId)
    );
    expect(taskRow).toBeDefined();
    expect(taskRow?.title).toBe('Node Task');
  });

  // -------------------------------------------------------------------------
  // 3. Two-client sync: A pushes, B pulls
  // -------------------------------------------------------------------------

  it('two-client sync: A pushes, B pulls', async () => {
    const userId = `node-2c-user-${RUN}`;
    const taskId = `node-2c-task-${RUN}`;

    // Client A pushes
    const { response: pushRes } = await postSyncCombinedRequest({
      fetch: _fetch,
      url: `${serverUrl}/sync`,
      actorId: userId,
      body: {
        clientId: `node-client-a-${RUN}`,
        push: {
          clientCommitId: `node-2c-commit-${RUN}`,
          operations: [
            createProjectScopedTaskUpsertOperation({
              taskId,
              title: 'Synced Task',
              completed: 1,
            }),
          ],
          schemaVersion: 1,
        },
      },
    });

    expect(pushRes.status).toBe(200);

    // Client B pulls
    const { response: pullRes, json: pullJson } = await postSyncCombinedRequest(
      {
        fetch: _fetch,
        url: `${serverUrl}/sync`,
        actorId: userId,
        body: {
          clientId: `node-client-b-${RUN}`,
          pull: {
            limitCommits: 50,
            subscriptions: [
              createProjectScopedTasksSubscription({
                id: tasksSubId,
                userId,
              }),
            ],
          },
        },
      }
    );

    expect(pullRes.status).toBe(200);
    const taskRow = subscriptionChangeRow(
      findSubscriptionChange(pullJson.pull?.subscriptions, tasksSubId, taskId)
    );
    expect(taskRow).toBeDefined();
    expect(taskRow?.title).toBe('Synced Task');
    expect(taskRow?.completed).toBe(1);
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
