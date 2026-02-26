/**
 * D1 runtime tests — proves D1 dialect works with sync in Workers runtime.
 *
 * Spawns wrangler dev --local, sends HTTP requests for conformance and sync.
 * Gated behind SYNCULAR_TEST_RUN_D1=true.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createIntegrationServer } from '../../integration/harness/create-server';
import type { IntegrationServer } from '../../integration/harness/types';
import {
  getNativeFetch,
  pickFreePort,
  shutdown,
  waitForHealthy,
} from '../shared/utils';

const _fetch = getNativeFetch();

function isEnabled(): boolean {
  return process.env.SYNCULAR_TEST_RUN_D1 === 'true';
}

describe('D1 runtime (Cloudflare Workers)', () => {
  let wranglerProc: ReturnType<typeof Bun.spawn>;
  let workerUrl: string;
  let server: IntegrationServer;
  let persistDir: string | null = null;

  beforeAll(async () => {
    if (!isEnabled()) return;

    // Start integration server for sync tests
    server = await createIntegrationServer('sqlite');

    // Start wrangler dev
    const workerPort = await pickFreePort();
    const wranglerBin = path.join(
      process.cwd(),
      'node_modules',
      '.bin',
      'wrangler'
    );
    const configPath = path.resolve(
      import.meta.dir,
      '../apps/d1/wrangler.toml'
    );
    persistDir = await mkdtemp(path.join(os.tmpdir(), 'syncular-d1-runtime-'));

    wranglerProc = Bun.spawn(
      [
        wranglerBin,
        'dev',
        '--local',
        '--persist-to',
        persistDir,
        '--ip',
        '127.0.0.1',
        '--port',
        String(workerPort),
        '--config',
        configPath,
      ],
      {
        cwd: path.resolve(import.meta.dir, '../apps/d1'),
        env: { ...process.env },
        stdin: 'ignore',
        stdout: 'pipe',
        stderr: 'pipe',
      }
    );

    workerUrl = `http://127.0.0.1:${workerPort}`;
    await waitForHealthy(workerUrl, 30_000);
  }, 120_000);

  afterAll(async () => {
    if (wranglerProc) await shutdown(wranglerProc);
    if (server) await server.destroy();
    if (persistDir) {
      await rm(persistDir, { recursive: true, force: true });
    }
  }, 30_000);

  it.skipIf(!isEnabled())(
    'passes conformance (types, nulls, unique)',
    async () => {
      const res = await _fetch(`${workerUrl}/conformance`, {
        method: 'POST',
      });
      const json = (await res.json()) as { ok: boolean; error?: string };
      if (!json.ok) throw new Error(`Conformance failed: ${json.error}`);
      expect(json.ok).toBe(true);
    }
  );

  // Client-side sync on D1 is skipped: the client sync engine uses
  // db.transaction() which D1/kysely-d1 doesn't support.
  // D1-as-server is tested in the Cloudflare runtime test instead.
  it.skip('bootstraps from server (skip: D1 has no tx support)', async () => {
    // Seed server with test data
    await server.db
      .insertInto('tasks')
      .values([
        {
          id: 'd1-rt-1',
          title: 'Task 1',
          completed: 0,
          user_id: 'd1-boot-user',
          project_id: 'p1',
          server_version: 1,
        },
        {
          id: 'd1-rt-2',
          title: 'Task 2',
          completed: 1,
          user_id: 'd1-boot-user',
          project_id: 'p1',
          server_version: 1,
        },
      ])
      .execute();

    const res = await _fetch(`${workerUrl}/bootstrap`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        serverUrl: server.baseUrl,
        actorId: 'd1-boot-user',
        clientId: 'd1-client-1',
      }),
    });

    const json = (await res.json()) as {
      ok: boolean;
      rowCount?: number;
      error?: string;
    };
    if (!json.ok) throw new Error(`Bootstrap failed: ${json.error}`);
    expect(json.ok).toBe(true);
    expect(json.rowCount).toBe(2);
  });

  it.skip('pushes and pulls data (skip: D1 has no tx support)', async () => {
    const res = await _fetch(`${workerUrl}/push-pull`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        serverUrl: server.baseUrl,
        actorId: 'd1-push-user',
        clientId: 'd1-client-2',
      }),
    });

    const json = (await res.json()) as {
      ok: boolean;
      finalRowCount?: number;
      error?: string;
    };
    if (!json.ok) throw new Error(`Push-pull failed: ${json.error}`);
    expect(json.ok).toBe(true);
    expect(json.finalRowCount).toBe(1);

    // Verify server has the task
    const serverRows = await server.db
      .selectFrom('tasks')
      .selectAll()
      .where('id', '=', 'd1-task-1')
      .execute();
    expect(serverRows.length).toBe(1);
    expect(serverRows[0]!.title).toBe('D1 Task');
  });
});
