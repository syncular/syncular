import { describe, expect, test } from 'bun:test';
import {
  type ClientChangeBatch,
  SyncClient,
  type WindowBase,
} from '@syncular/client';
import { BunClientDatabase } from '@syncular/client/bun';
import { CLIENT_SCHEMA, makeClient, makeServer, taskValues } from './helpers';

const BASE: WindowBase = { table: 'tasks', variable: 'project_id' };

describe('revisioned local observation (SPEC §7.5)', () => {
  test('mutation revision is atomic with rows/status and scope moves include before + after', async () => {
    const client = await makeClient(makeServer(), { clientId: 'observer' });
    const batches: ClientChangeBatch[] = [];
    client.client.onChange((batch) => batches.push(batch));

    client.client.mutate([
      {
        table: 'tasks',
        op: 'upsert',
        values: taskValues('t1', 'p1', 'one'),
      },
    ]);
    const first = client.client.querySnapshot({
      sql: 'SELECT * FROM tasks WHERE id = ?',
      params: ['t1'],
    });
    expect(first.revision).toBe(1n);
    expect(first.rows).toHaveLength(1);
    expect(batches).toHaveLength(1);
    expect(batches[0]?.revision).toBe(first.revision);
    expect(batches[0]?.status?.outbox).toBe(1);
    expect([...(batches[0]?.tables[0]?.scopeKeys ?? [])]).toEqual([
      'project:p1',
    ]);

    client.client.patch('tasks', 't1', { project_id: 'p2' });
    const moved = batches.at(-1);
    expect(moved?.revision).toBe(2n);
    expect(new Set(moved?.tables[0]?.scopeKeys)).toEqual(
      new Set(['project:p1', 'project:p2']),
    );
  });

  test('window registration and zero-row completion are window-only changes', async () => {
    const client = await makeClient(makeServer(), { clientId: 'windowed' });
    const batches: ClientChangeBatch[] = [];
    client.client.onChange((batch) => batches.push(batch));

    const command = await client.client.setWindowCommand(BASE, ['empty']);
    expect(command.effects.sync).toEqual({ kind: 'interactive' });
    const pending = client.client.querySnapshot({
      sql: 'SELECT * FROM tasks WHERE project_id = ?',
      params: ['empty'],
      coverage: [{ base: BASE, units: ['empty'] }],
    });
    expect(pending.coverage.complete).toBe(false);
    expect(pending.coverage.pending).toHaveLength(1);
    expect(batches.at(-1)?.tables).toEqual([]);
    expect(batches.at(-1)?.windows[0]?.units.has('empty')).toBe(true);

    batches.length = 0;
    await client.client.syncUntilIdle();
    const ready = client.client.querySnapshot({
      sql: 'SELECT * FROM tasks WHERE project_id = ?',
      params: ['empty'],
      coverage: [{ base: BASE, units: ['empty'] }],
    });
    expect(ready.coverage.complete).toBe(true);
    expect(ready.rows).toEqual([]);
    expect(batches.some((batch) => batch.tables.length > 0)).toBe(false);
    expect(
      batches.some((batch) =>
        batch.windows.some((window) => window.units.has('empty')),
      ),
    ).toBe(true);
  });

  test('persisted identity cannot be silently rebound', async () => {
    const db = new BunClientDatabase();
    const transport = async () => new Uint8Array();
    const first = new SyncClient({
      database: db,
      schema: CLIENT_SCHEMA,
      transport,
      clientId: 'device-a',
    });
    await first.start();
    await first.close();

    const rebound = new SyncClient({
      database: db,
      schema: CLIENT_SCHEMA,
      transport,
      clientId: 'device-b',
    });
    await expect(rebound.start()).rejects.toMatchObject({
      code: 'client.identity_mismatch',
    });
    db.close();
  });

  test('retryable transport failures produce explicit exponential background deadlines', async () => {
    const client = await makeClient(makeServer(), { clientId: 'retrying' });
    client.faults.dropResponseOnce = true;
    await expect(client.client.sync()).rejects.toThrow(
      'simulated response loss',
    );
    expect(client.intents).toEqual([{ kind: 'background', delayMs: 250 }]);

    client.faults.dropResponseOnce = true;
    await expect(client.client.sync()).rejects.toThrow(
      'simulated response loss',
    );
    expect(client.intents.at(-1)).toEqual({
      kind: 'background',
      delayMs: 500,
    });

    await client.client.sync();
    client.faults.dropResponseOnce = true;
    await expect(client.client.sync()).rejects.toThrow(
      'simulated response loss',
    );
    expect(client.intents.at(-1)).toEqual({
      kind: 'background',
      delayMs: 250,
    });
  });
});
