/**
 * §2.2 scope migration delivery (#44): the delete under the old scope and the
 * upsert under the new one arrive in separate subscription sections. The
 * reader must apply them as one change and keep the row whatever order the
 * sections arrive in.
 */
import { describe, expect, test } from 'bun:test';
import { decodeMessage } from '@syncular/core';
import { makeClient, makeServer, tableRows, taskValues } from './helpers';

describe('scope move delivery (§2.2)', () => {
  for (const order of ['old-first', 'new-first'] as const) {
    test(`a reader of both scopes keeps the row (${order})`, async () => {
      const server = makeServer();
      server.allowed['actor-1'] = { project_id: ['p1', 'p2'] };
      const mover = await makeClient(server, { clientId: 'mover' });
      mover.client.subscribe({
        id: 'home',
        table: 'tasks',
        scopes: { project_id: ['p1'] },
      });
      mover.client.mutate([
        { table: 'tasks', op: 'upsert', values: taskValues('t1', 'p1') },
      ]);
      await mover.client.syncUntilIdle();

      const reader = await makeClient(server, { clientId: `reader-${order}` });
      const sections: readonly (readonly [string, string])[] =
        order === 'old-first'
          ? [
              ['old', 'p1'],
              ['new', 'p2'],
            ]
          : [
              ['new', 'p2'],
              ['old', 'p1'],
            ];
      for (const [id, projectId] of sections) {
        reader.client.subscribe({
          id,
          table: 'tasks',
          scopes: { project_id: [projectId] },
        });
      }
      await reader.client.syncUntilIdle();
      expect(
        tableRows(reader.db, 'tasks').map((row) => row.project_id),
      ).toEqual(['p1']);

      // The consumer's scope move: one commit, delete the old home and
      // re-insert the same row under the new one (§40).
      mover.client.mutate([
        { table: 'tasks', op: 'delete', rowId: 't1' },
        {
          table: 'tasks',
          op: 'upsert',
          values: taskValues('t1', 'p2', 'moved'),
          baseVersion: 0,
        },
      ]);
      await mover.client.syncUntilIdle();
      await reader.client.syncUntilIdle();

      const rows = tableRows(reader.db, 'tasks');
      expect(rows).toHaveLength(1);
      expect(rows[0]?.id).toBe('t1');
      expect(rows[0]?.project_id).toBe('p2');
      expect(rows[0]?.title).toBe('moved');
      const serverRow = (
        await server.storage.scanRows('part-1', {
          table: 'tasks',
          scopeFilter: { project_id: ['p2'] },
          afterRowId: null,
          limit: 10,
        })
      )[0];
      expect(serverRow?.rowId).toBe('t1');
    });
  }
});

describe('client id reset (§1.5)', () => {
  test('the next request carries the new id and the replica persists it', async () => {
    const server = makeServer();
    server.allowed['actor-1'] = { project_id: ['p1'], projectId: ['p1'] };
    const a = await makeClient(server, { clientId: 'old-client' });
    const next = a.client.resetClientId();
    expect(next).not.toBe('old-client');
    expect(a.client.clientId).toBe(next);
    expect(
      a.db.query("SELECT value FROM _syncular_meta WHERE key='clientId'"),
    ).toEqual([{ value: next }]);

    a.client.subscribe({
      id: 'tasks',
      table: 'tasks',
      scopes: { project_id: ['p1'] },
    });
    await a.client.syncUntilIdle();
    const request = decodeMessage(a.requests.at(-1)!);
    expect(request.msgKind).toBe('request');
    expect(request.frames[0]).toMatchObject({
      type: 'REQ_HEADER',
      clientId: next,
    });
  });
});
