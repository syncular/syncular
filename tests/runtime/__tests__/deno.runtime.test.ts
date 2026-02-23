/**
 * Deno runtime test — proves the sync framework works under Deno.
 *
 * Bundles the server (node:sqlite adapter), spawns a Deno subprocess,
 * then tests push/pull/two-client sync via HTTP.
 *
 * Requires Deno 2.x installed (uses node:sqlite built-in).
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import {
  type ChildProcess,
  execFileSync,
  execSync,
  spawn,
} from 'node:child_process';
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

/** Resolve `deno` binary — checks PATH first, then common install locations. */
function findDeno(): string {
  try {
    return execFileSync('which', ['deno'], { encoding: 'utf-8' }).trim();
  } catch {
    // Check common install paths
    const candidates = [
      path.join(process.env.HOME ?? '', '.deno', 'bin', 'deno'),
      '/usr/local/bin/deno',
    ];
    for (const p of candidates) {
      try {
        execFileSync(p, ['--version'], { stdio: 'pipe' });
        return p;
      } catch {
        // not here
      }
    }
    throw new Error('deno not found in PATH or common install locations');
  }
}

describe('Deno runtime (node:sqlite)', () => {
  const tasksSubId = 'sub-tasks';
  let denoProc: ChildProcess;
  let serverUrl: string;

  beforeAll(async () => {
    const serverSrc = path.resolve(import.meta.dir, '../apps/deno/server.ts');
    const outDir = path.resolve(import.meta.dir, '../apps/deno/dist');

    // Bundle for Deno — workspace packages are linked via bun, so Deno can't
    // resolve them directly. Mark node:sqlite as external (built-in to Deno 2.x).
    execSync(
      `bun build ${serverSrc} --target=node --outdir=${outDir} --external node:sqlite`,
      { stdio: 'pipe' }
    );

    const bundledScript = path.join(outDir, 'server.js');

    const denoBin = findDeno();
    denoProc = spawn(denoBin, ['run', '--allow-all', bundledScript], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env },
    });

    const port = await waitForJsonPortFromStdout(denoProc, {
      processName: 'Deno server',
    });

    serverUrl = `http://127.0.0.1:${port}`;
  });

  afterAll(async () => {
    if (denoProc) {
      await stopChildProcess(denoProc);
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
    const userId = `deno-user-${RUN}`;
    const clientId = `deno-client-${RUN}`;
    const taskId = `deno-task-${RUN}`;

    // Push a task
    const { response: pushRes, json: pushJson } = await postSyncCombinedRequest(
      {
        fetch: _fetch,
        url: `${serverUrl}/sync`,
        actorId: userId,
        body: {
          clientId,
          push: {
            clientCommitId: `deno-commit-1-${RUN}`,
            operations: [
              createProjectScopedTaskUpsertOperation({
                taskId,
                title: 'Deno Task',
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
    expect(taskRow?.title).toBe('Deno Task');
  });

  // -------------------------------------------------------------------------
  // 3. Two-client sync: A pushes, B pulls
  // -------------------------------------------------------------------------

  it('two-client sync: A pushes, B pulls', async () => {
    const userId = `deno-2c-user-${RUN}`;
    const taskId = `deno-2c-task-${RUN}`;

    // Client A pushes
    const { response: pushRes } = await postSyncCombinedRequest({
      fetch: _fetch,
      url: `${serverUrl}/sync`,
      actorId: userId,
      body: {
        clientId: `deno-client-a-${RUN}`,
        push: {
          clientCommitId: `deno-2c-commit-${RUN}`,
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
          clientId: `deno-client-b-${RUN}`,
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
});
