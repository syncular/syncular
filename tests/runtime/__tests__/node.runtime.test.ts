/**
 * Node runtime tests — proves better-sqlite3 works with sync in native Node.
 *
 * Spawns a Node process (via tsx) that runs an HTTP server.
 * The coordinator sends commands for conformance, bootstrap, and push-pull.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
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

describe('Node runtime (better-sqlite3)', () => {
  let nodeProc: ReturnType<typeof Bun.spawn>;
  let nodeUrl: string;
  let server: IntegrationServer;

  beforeAll(async () => {
    // Start integration server for sync tests
    server = await createIntegrationServer('sqlite');

    // Start Node process with the runtime server
    const nodePort = await pickFreePort();
    const serverPath = path.resolve(import.meta.dir, '../apps/node/server.ts');

    nodeProc = Bun.spawn(
      ['node', '--import', 'tsx', serverPath, `--port=${nodePort}`],
      {
        cwd: path.resolve(import.meta.dir, '..'),
        env: { ...process.env },
        stdin: 'ignore',
        stdout: 'pipe',
        stderr: 'pipe',
      }
    );

    nodeUrl = `http://127.0.0.1:${nodePort}`;
    await waitForHealthy(nodeUrl, 30_000);
  });

  afterAll(async () => {
    if (nodeProc) await shutdown(nodeProc);
    if (server) await server.destroy();
  });

  it('passes conformance (types, nulls, unique, tx)', async () => {
    const res = await _fetch(`${nodeUrl}/conformance`, { method: 'POST' });
    const json = (await res.json()) as { ok: boolean; error?: string };
    expect(json.ok).toBe(true);
  });

  it('bootstraps from server', async () => {
    // Seed server with test data (unique actor for scope isolation)
    await server.db
      .insertInto('tasks')
      .values([
        {
          id: 'node-rt-1',
          title: 'Task 1',
          completed: 0,
          user_id: 'boot-user',
          project_id: 'p1',
          server_version: 1,
        },
        {
          id: 'node-rt-2',
          title: 'Task 2',
          completed: 1,
          user_id: 'boot-user',
          project_id: 'p1',
          server_version: 1,
        },
        {
          id: 'node-rt-3',
          title: 'Task 3',
          completed: 0,
          user_id: 'boot-user',
          project_id: 'p1',
          server_version: 1,
        },
      ])
      .execute();

    const res = await _fetch(`${nodeUrl}/bootstrap`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        serverUrl: server.baseUrl,
        actorId: 'boot-user',
        clientId: 'node-client-1',
      }),
    });

    const json = (await res.json()) as {
      ok: boolean;
      rowCount?: number;
      error?: string;
    };
    expect(json.ok).toBe(true);
    expect(json.rowCount).toBe(3);
  });

  it('pushes and pulls data', async () => {
    // Use a different actor for scope isolation from bootstrap test
    const res = await _fetch(`${nodeUrl}/push-pull`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        serverUrl: server.baseUrl,
        actorId: 'push-user',
        clientId: 'node-client-2',
      }),
    });

    const json = (await res.json()) as {
      ok: boolean;
      finalRowCount?: number;
      error?: string;
    };
    expect(json.ok).toBe(true);
    expect(json.finalRowCount).toBe(1);

    // Verify server has the task
    const serverRows = await server.db
      .selectFrom('tasks')
      .selectAll()
      .where('id', '=', 'rt-task-1')
      .execute();
    expect(serverRows.length).toBe(1);
    expect(serverRows[0]!.title).toBe('Runtime Task');
  });
});
