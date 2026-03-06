/**
 * Node.js runtime test — proves the sync framework works under native Node.js.
 *
 * Spawns a Node.js process running better-sqlite3 + Hono sync server,
 * then tests push/pull/two-client sync via HTTP.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import {
  type ChildProcess,
  execFileSync,
  execSync,
  spawn,
} from 'node:child_process';
import {
  mkdir,
  mkdtemp,
  readdir,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
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
const ROOT_BUN_NODE_MODULES = path.join(
  REPO_ROOT,
  'node_modules/.bun/node_modules'
);

interface PublishedPackageFixture {
  name: string;
  dir: string;
}

const publishedPackages: PublishedPackageFixture[] = [
  {
    name: '@syncular/core',
    dir: path.join(REPO_ROOT, 'packages/core'),
  },
  {
    name: '@syncular/transport-http',
    dir: path.join(REPO_ROOT, 'packages/transport-http'),
  },
  {
    name: '@syncular/client',
    dir: path.join(REPO_ROOT, 'packages/client'),
  },
  {
    name: '@syncular/client-react',
    dir: path.join(REPO_ROOT, 'packages/client-react'),
  },
  {
    name: '@syncular/server',
    dir: path.join(REPO_ROOT, 'packages/server'),
  },
  {
    name: '@syncular/relay',
    dir: path.join(REPO_ROOT, 'packages/relay'),
  },
];

const publishedExternalPackages = [
  'hono',
  'kysely',
  'openapi-fetch',
  'react',
  'zod',
];

function packagePath(root: string, packageName: string): string {
  return path.join(root, ...packageName.split('/'));
}

async function linkInstalledPackage(args: {
  projectRoot: string;
  packageName: string;
}): Promise<void> {
  const { projectRoot, packageName } = args;
  const source = packagePath(ROOT_BUN_NODE_MODULES, packageName);
  const target = packagePath(
    path.join(projectRoot, 'node_modules'),
    packageName
  );

  await mkdir(path.dirname(target), { recursive: true });
  await symlink(source, target, 'dir');
}

async function packWorkspacePackage(args: {
  packageDir: string;
  destinationDir: string;
}): Promise<string> {
  const { packageDir, destinationDir } = args;

  execSync('bun run build', { cwd: packageDir, stdio: 'pipe' });
  execSync(`bun ${ESM_FIX_SCRIPT} dist`, {
    cwd: packageDir,
    stdio: 'pipe',
  });
  execFileSync('bun', ['pm', 'pack', '--destination', destinationDir], {
    cwd: packageDir,
    stdio: 'pipe',
  });
  const tarballs = (await readdir(destinationDir))
    .filter((entry) => entry.endsWith('.tgz'))
    .sort();
  const tarballName = tarballs.at(-1);
  if (!tarballName) {
    throw new Error(`No tarball created for ${packageDir}`);
  }
  return path.join(destinationDir, tarballName);
}

async function extractPackedPackage(args: {
  tarballPath: string;
  projectRoot: string;
  packageName: string;
}): Promise<void> {
  const { tarballPath, projectRoot, packageName } = args;
  const installDir = packagePath(
    path.join(projectRoot, 'node_modules'),
    packageName
  );
  await mkdir(installDir, { recursive: true });
  execFileSync(
    'tar',
    ['-xzf', tarballPath, '--strip-components=1', '-C', installDir],
    {
      stdio: 'pipe',
    }
  );
}

async function createPackedWorkspaceProject(): Promise<string> {
  const projectRoot = await mkdtemp(
    path.join(os.tmpdir(), 'syncular-runtime-packages-')
  );
  const packDir = path.join(projectRoot, 'tarballs');
  await mkdir(packDir, { recursive: true });
  await writeFile(
    path.join(projectRoot, 'package.json'),
    JSON.stringify({
      name: 'syncular-runtime-smoke',
      private: true,
      type: 'module',
    })
  );

  for (const fixture of publishedPackages) {
    const fixturePackDir = path.join(
      packDir,
      fixture.name.replaceAll('@', '').replaceAll('/', '-')
    );
    await mkdir(fixturePackDir, { recursive: true });
    const tarballPath = await packWorkspacePackage({
      packageDir: fixture.dir,
      destinationDir: fixturePackDir,
    });
    await extractPackedPackage({
      tarballPath,
      projectRoot,
      packageName: fixture.name,
    });
  }

  for (const packageName of publishedExternalPackages) {
    await linkInstalledPackage({ projectRoot, packageName });
  }

  return projectRoot;
}

describe('Node.js runtime (better-sqlite3)', () => {
  const tasksSubId = 'sub-tasks';
  let nodeProc: ChildProcess;
  let serverUrl: string;

  beforeAll(async () => {
    const serverSrc = path.resolve(import.meta.dir, '../apps/node/server.ts');
    const outDir = path.resolve(import.meta.dir, '../apps/node/dist');

    // Bundle for Node. Use the Bun condition so workspace package imports
    // resolve to source entries instead of relying on prebuilt dist exports.
    // Mark native addons as external.
    execSync(
      `bun build ${serverSrc} --target=node --conditions bun --outdir=${outDir} --external better-sqlite3`,
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

  it('imports packed workspace archives through installed package names', async () => {
    const projectRoot = await createPackedWorkspaceProject();

    try {
      const smokeScript = [
        "const core = await import('@syncular/core')",
        "if (typeof core.createDatabase !== 'function') throw new Error('Missing createDatabase export')",
        "const transport = await import('@syncular/transport-http')",
        "if (typeof transport.createHttpTransport !== 'function') throw new Error('Missing createHttpTransport export')",
        "const client = await import('@syncular/client')",
        "if (typeof client.enqueueOutboxCommit !== 'function') throw new Error('Missing enqueueOutboxCommit export')",
        "const clientReact = await import('@syncular/client-react')",
        "if (typeof clientReact.createSyncularReact !== 'function') throw new Error('Missing createSyncularReact export')",
        "const server = await import('@syncular/server')",
        "if (typeof server.ensureSyncSchema !== 'function') throw new Error('Missing ensureSyncSchema export')",
        "await import('@syncular/server/schema')",
        "await import('@syncular/server/dialect/types')",
        "await import('@syncular/server/snapshot-chunks')",
        "const relay = await import('@syncular/relay')",
        "if (typeof relay.createRelayServer !== 'function') throw new Error('Missing createRelayServer export')",
      ].join(';');

      execSync(`node --input-type=module -e ${JSON.stringify(smokeScript)}`, {
        cwd: projectRoot,
        stdio: 'pipe',
      });
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });
});
