/**
 * §7.4.3 restriction: a unit that covers a changed and a kept table keeps its
 * rows of the kept table through its kept cursor and bootstraps the changed
 * table only (§4.3 RESTRICT, §4.7). A server that predates RESTRICT serves a
 * whole bootstrap, which ends the restriction at its first foreign page
 * (§5.6).
 */
import { afterEach, describe, expect, test } from 'bun:test';
import {
  decodeMessage,
  decodeRowsSegment,
  encodeMessage,
  type RowColumn,
  unitId,
} from '@syncular/core';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ClientSchema, SyncTransport } from '@syncular/client';
import { handleSyncRequest, type ServerSchema } from '@syncular/server';
import { makeClient, makeServer, type TestServer } from './helpers';

const CATALOG_COLUMNS: readonly RowColumn[] = [
  { name: 'id', type: 'string', nullable: false },
  { name: 'shelf_id', type: 'string', nullable: false },
  { name: 'title', type: 'string', nullable: false },
];
const NOTE_COLUMNS: readonly RowColumn[] = [
  { name: 'id', type: 'string', nullable: false },
  { name: 'shelf_id', type: 'string', nullable: false },
  { name: 'body', type: 'string', nullable: false },
];
const catalog = {
  name: 'catalog',
  generation: 'catalog-1',
  columns: CATALOG_COLUMNS,
  primaryKey: 'id',
  scopes: ['shelf:{shelf_id}'],
};
const notes = (version: number) => ({
  name: 'notes',
  generation: `notes-${version}`,
  columns:
    version === 1
      ? NOTE_COLUMNS
      : [
          ...NOTE_COLUMNS,
          { name: 'pinned', type: 'boolean' as const, nullable: true },
        ],
  primaryKey: 'id',
  scopes: ['shelf:{shelf_id}'],
});
const V1 = { version: 1, tables: [catalog, notes(1)] };
const V2 = { version: 2, tables: [catalog, notes(2)] };
const SHELF = { shelf_id: 's1' };

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true });
});

/** A replica of SHELF at v1, then a catalog write it has not pulled. */
async function seeded() {
  const server = makeServer(V2 as ServerSchema, {
    olderSchemas: [V1 as ServerSchema],
  });
  server.allowed['actor-1'] = { shelf_id: ['*'] };
  const writer = await makeClient(server, {
    clientId: 'writer',
    schema: V1 as ClientSchema,
  });
  const write = async (table: string, values: Record<string, string>) => {
    writer.client.mutate([{ table, op: 'upsert', values }]);
    await writer.client.syncUntilIdle();
  };
  await write('catalog', { id: 'c1', shelf_id: 's1', title: 'one' });
  await write('notes', { id: 'n1', shelf_id: 's1', body: 'note' });

  const dir = mkdtempSync(join(tmpdir(), 'syncular-bump-restrict-'));
  dirs.push(dir);
  const databasePath = join(dir, 'client.sqlite');
  const reader = await makeClient(server, {
    clientId: 'reader',
    databasePath,
    schema: V1 as ClientSchema,
  });
  reader.client.subscribe(SHELF);
  await reader.client.syncUntilIdle();
  const cursor = Number(
    reader.db.query(
      "SELECT value FROM _syncular_meta WHERE key='replicaCursor'",
    )[0]?.value,
  );
  // A catalog row no bootstrap delivers: a first-page clear of catalog in
  // SHELF's scope would remove it.
  reader.db.exec(
    "INSERT INTO catalog(id,shelf_id,title,_sync_version)VALUES('local','s1','local',1)",
  );
  await reader.client.close();
  reader.db.close();
  // Commits after the kept cursor: the scan from C delivers them.
  await write('catalog', { id: 'c2', shelf_id: 's1', title: 'two' });
  await write('notes', { id: 'n1', shelf_id: 's1', body: 'edited' });
  await writer.client.close();
  writer.db.close();
  return { server, databasePath, cursor };
}

/** A loopback transport that records the tables of every segment served and
 * can drop RESTRICT frames, as a server that predates them skips them. */
function recording(server: TestServer, skipRestrict: boolean) {
  const segments: string[] = [];
  const restricts: unknown[] = [];
  const transport: SyncTransport = async (bytes) => {
    const request = decodeMessage(bytes);
    for (const frame of request.frames)
      if (frame.type === 'RESTRICT') restricts.push(frame);
    const served = skipRestrict
      ? encodeMessage({
          ...request,
          frames: request.frames.filter((frame) => frame.type !== 'RESTRICT'),
        } as typeof request)
      : bytes;
    const response = await handleSyncRequest(served, server.ctxFor('actor-1'));
    for (const frame of decodeMessage(response).frames) {
      if (frame.type === 'SEGMENT_INLINE')
        segments.push(decodeRowsSegment(frame.payload).table);
      if (frame.type === 'SEGMENT_REF') segments.push(frame.table);
    }
    return response;
  };
  return { transport, segments, restricts };
}

describe('schema bump restricts a unit to its changed tables (§7.4.3)', () => {
  test('the unit bootstraps the changed table only and joins at its kept cursor', async () => {
    const { server, databasePath, cursor } = await seeded();
    const wire = recording(server, false);
    const bumped = await makeClient(server, {
      clientId: 'reader',
      databasePath,
      schema: V2 as ClientSchema,
      transport: wire.transport,
    });
    const [unit] = bumped.client.units();
    expect(unit?.cursor).toBe(-1);
    expect(unit?.echo).toBeDefined();
    expect(
      bumped.db.query(
        `SELECT restriction FROM _syncular_units WHERE id='${unitId(SHELF)}'`,
      ),
    ).toEqual([{ restriction: JSON.stringify({ cursor, tables: ['notes'] }) }]);
    await bumped.client.syncUntilIdle();
    expect(wire.restricts[0]).toEqual({
      type: 'RESTRICT',
      cursor,
      tables: ['notes'],
    });
    expect(wire.segments).toEqual(['notes']);
    expect(bumped.db.query('SELECT id,title FROM catalog ORDER BY id')).toEqual(
      [
        { id: 'c1', title: 'one' },
        { id: 'c2', title: 'two' },
        { id: 'local', title: 'local' },
      ],
    );
    expect(bumped.db.query('SELECT id,body,pinned FROM notes')).toEqual([
      { id: 'n1', body: 'edited', pinned: null },
    ]);
    expect(
      bumped.db.query(
        `SELECT cursor,restriction FROM _syncular_units WHERE id='${unitId(SHELF)}'`,
      ),
    ).toEqual([{ cursor: null, restriction: null }]);
    expect(bumped.client.statusSnapshot().upgrading).toBe(false);
    await bumped.client.close();
    bumped.db.close();
  });

  test('a server that predates RESTRICT serves a whole bootstrap and the restriction ends', async () => {
    const { server, databasePath } = await seeded();
    const wire = recording(server, true);
    const bumped = await makeClient(server, {
      clientId: 'reader',
      databasePath,
      schema: V2 as ClientSchema,
      transport: wire.transport,
    });
    await bumped.client.syncUntilIdle();
    expect(wire.segments.sort()).toEqual(['catalog', 'notes']);
    // The whole bootstrap's first catalog page cleared the unit's scope.
    expect(bumped.db.query('SELECT id FROM catalog ORDER BY id')).toEqual([
      { id: 'c1' },
      { id: 'c2' },
    ]);
    expect(bumped.db.query('SELECT id,body FROM notes')).toEqual([
      { id: 'n1', body: 'edited' },
    ]);
    expect(
      bumped.db.query(
        `SELECT cursor,restriction FROM _syncular_units WHERE id='${unitId(SHELF)}'`,
      ),
    ).toEqual([{ cursor: null, restriction: null }]);
    expect(bumped.client.statusSnapshot().upgrading).toBe(false);
    await bumped.client.close();
    bumped.db.close();
  });
});
