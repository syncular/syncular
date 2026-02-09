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

    // Wait for the server to print { port } on stdout
    const port = await new Promise<number>((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error('Deno server startup timed out')),
        30_000
      );

      let buffer = '';
      denoProc.stdout!.on('data', (chunk: Buffer) => {
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
      denoProc.stderr!.on('data', (chunk: Buffer) => {
        stderrBuf += chunk.toString();
      });

      denoProc.on('exit', (code) => {
        clearTimeout(timeout);
        reject(
          new Error(
            `Deno server exited with code ${code}\nstderr: ${stderrBuf}`
          )
        );
      });
    });

    serverUrl = `http://127.0.0.1:${port}`;
  });

  afterAll(async () => {
    if (denoProc && denoProc.exitCode == null) {
      denoProc.kill('SIGTERM');
      await new Promise<void>((resolve) => {
        const timeout = setTimeout(() => {
          denoProc.kill('SIGKILL');
          resolve();
        }, 5000);
        denoProc.on('exit', () => {
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
    const userId = `deno-user-${RUN}`;
    const clientId = `deno-client-${RUN}`;
    const taskId = `deno-task-${RUN}`;

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
          clientCommitId: `deno-commit-1-${RUN}`,
          operations: [
            {
              table: 'tasks',
              row_id: taskId,
              op: 'upsert',
              payload: {
                title: 'Deno Task',
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
    ).toBe('Deno Task');
  });

  // -------------------------------------------------------------------------
  // 3. Two-client sync: A pushes, B pulls
  // -------------------------------------------------------------------------

  it('two-client sync: A pushes, B pulls', async () => {
    const userId = `deno-2c-user-${RUN}`;
    const taskId = `deno-2c-task-${RUN}`;

    // Client A pushes
    const pushRes = await _fetch(`${serverUrl}/sync`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-actor-id': userId,
      },
      body: JSON.stringify({
        clientId: `deno-client-a-${RUN}`,
        push: {
          clientCommitId: `deno-2c-commit-${RUN}`,
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
        clientId: `deno-client-b-${RUN}`,
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
});
