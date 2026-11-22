/**
 * §7.4.3 table generations: a schema bump keeps a table whose generation is
 * unchanged, with its rows and the state of every unit that covers only kept
 * tables. Every other table and unit resets; a schema without generations
 * resets everything.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { decodeMessage, unitId, type RowColumn } from '@syncular/core';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { classifySyncAvailability, type ClientSchema } from '@syncular/client';
import type { ServerSchema } from '@syncular/server';
import { compileClientSchema } from '../src/schema';
import { makeClient, makeServer, type TestServer } from './helpers';

const CATALOG_COLUMNS: readonly RowColumn[] = [
  { name: 'id', type: 'string', nullable: false },
  { name: 'lib_id', type: 'string', nullable: false },
  { name: 'shelf_id', type: 'string', nullable: false },
  { name: 'title', type: 'string', nullable: false },
];
const NOTE_COLUMNS: readonly RowColumn[] = [
  { name: 'id', type: 'string', nullable: false },
  { name: 'shelf_id', type: 'string', nullable: false },
  { name: 'owner_id', type: 'string', nullable: false },
  { name: 'body', type: 'string', nullable: false },
];
const catalog = (generation?: string) => ({
  name: 'catalog',
  ...(generation === undefined ? {} : { generation }),
  columns: CATALOG_COLUMNS,
  primaryKey: 'id',
  scopes: ['lib:{lib_id}', 'shelf:{shelf_id}'],
});
const notes = (generation?: string, pinned = false) => ({
  name: 'notes',
  ...(generation === undefined ? {} : { generation }),
  columns: pinned
    ? [
        ...NOTE_COLUMNS,
        { name: 'pinned', type: 'boolean' as const, nullable: true },
      ]
    : NOTE_COLUMNS,
  primaryKey: 'id',
  scopes: ['shelf:{shelf_id}', 'owner:{owner_id}'],
});

function schemas(generations: boolean) {
  const v1 = {
    version: 1,
    tables: generations
      ? [catalog('catalog-1'), notes('notes-1')]
      : [catalog(), notes()],
  };
  const v2 = {
    version: 2,
    tables: generations
      ? [catalog('catalog-1'), notes('notes-2', true)]
      : [catalog(), notes(undefined, true)],
  };
  return {
    v1: v1 as ClientSchema,
    v2: v2 as ClientSchema,
    server: makeServer(v2 as ServerSchema, {
      olderSchemas: [v1 as ServerSchema],
    }),
  };
}

/** A covers only `catalog`, O only `notes`, S both. */
const LIB = { lib_id: 'l1' };
const OWNER = { owner_id: 'u1' };
const SHELF = { shelf_id: 's1' };

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true });
});

async function seededReplica(server: TestServer, v1: ClientSchema) {
  server.allowed['actor-1'] = {
    lib_id: ['*'],
    shelf_id: ['*'],
    owner_id: ['*'],
  };
  const writer = await makeClient(server, { clientId: 'writer', schema: v1 });
  writer.client.mutate([
    {
      table: 'catalog',
      op: 'upsert',
      values: { id: 'c1', lib_id: 'l1', shelf_id: 's1', title: 'one' },
    },
    {
      table: 'catalog',
      op: 'upsert',
      values: { id: 'c2', lib_id: 'l1', shelf_id: 's2', title: 'two' },
    },
    {
      table: 'notes',
      op: 'upsert',
      values: { id: 'n1', shelf_id: 's1', owner_id: 'u1', body: 'note' },
    },
  ]);
  await writer.client.syncUntilIdle();
  await writer.client.close();
  writer.db.close();

  const dir = mkdtempSync(join(tmpdir(), 'syncular-bump-keep-'));
  dirs.push(dir);
  const databasePath = join(dir, 'client.sqlite');
  const reader = await makeClient(server, {
    clientId: 'reader',
    databasePath,
    schema: v1,
  });
  reader.client.subscribe(LIB);
  reader.client.subscribe(OWNER);
  reader.client.subscribe(SHELF);
  await reader.client.syncUntilIdle();
  const cursor = Number(
    reader.db.query(
      "SELECT value FROM _syncular_meta WHERE key='replicaCursor'",
    )[0]?.value,
  );
  expect(cursor).toBeGreaterThan(0);
  // A row no server bootstrap delivers: a re-bootstrap of LIB would clear it
  // with the unit's first page (§5.6).
  reader.db.exec(
    "INSERT INTO catalog(id,lib_id,shelf_id,title,_sync_version)VALUES('kept','l1','s9','local',1)",
  );
  return { reader, databasePath, cursor };
}

/** The PULL_HEADER cursor and the PROGRESS cursor per unit id. */
function pullOf(bytes: Uint8Array) {
  const frames = decodeMessage(bytes).frames as readonly {
    readonly type: string;
    readonly cursor?: number;
    readonly id?: string;
  }[];
  return {
    cursor: frames.find((frame) => frame.type === 'PULL_HEADER')?.cursor,
    progress: Object.fromEntries(
      frames
        .filter((frame) => frame.type === 'PROGRESS')
        .map((frame) => [frame.id, frame.cursor]),
    ),
  };
}

describe('schema bump keeps tables with unchanged generations (§7.4.3)', () => {
  test('an unchanged table keeps its rows and its units; a changed one re-bootstraps', async () => {
    const { v1, v2, server } = schemas(true);
    const { reader, databasePath, cursor } = await seededReplica(server, v1);
    reader.client.mutate([
      {
        table: 'catalog',
        op: 'upsert',
        values: { id: 'c2', lib_id: 'l1', shelf_id: 's2', title: 'pending' },
      },
    ]);
    await reader.client.close();
    reader.db.close();

    const bumped = await makeClient(server, {
      clientId: 'reader',
      databasePath,
      schema: v2,
    });
    const units = Object.fromEntries(
      bumped.client.units().map((unit) => [unit.id, unit]),
    );
    expect(units[unitId(LIB)]?.cursor).toBeUndefined();
    expect(units[unitId(LIB)]?.echo).toBeDefined();
    expect(units[unitId(OWNER)]?.cursor).toBe(-1);
    expect(units[unitId(SHELF)]?.cursor).toBe(-1);
    expect(bumped.db.query('SELECT id,title FROM catalog ORDER BY id')).toEqual(
      [
        { id: 'c1', title: 'one' },
        { id: 'c2', title: 'pending' },
        { id: 'kept', title: 'local' },
      ],
    );
    expect(bumped.db.query('SELECT id FROM notes')).toEqual([]);

    await bumped.client.syncUntilIdle();
    const first = pullOf(bumped.requests[0]!);
    expect(first.cursor).toBe(cursor);
    expect(first.progress).toEqual({
      [unitId(OWNER)]: -1,
      [unitId(SHELF)]: -1,
    });
    expect(bumped.db.query('SELECT id,title FROM catalog ORDER BY id')).toEqual(
      [
        { id: 'c1', title: 'one' },
        { id: 'c2', title: 'pending' },
        { id: 'kept', title: 'local' },
      ],
    );
    expect(bumped.db.query('SELECT id,pinned FROM notes')).toEqual([
      { id: 'n1', pinned: null },
    ]);
    expect(bumped.client.pendingCommits()).toEqual([]);
    expect(bumped.client.statusSnapshot().upgrading).toBe(false);
    await bumped.client.close();
    bumped.db.close();
  });

  test('a bump that keeps a table reports ready while the reset unit rebuilds (§7.4.5)', async () => {
    const { v1, v2, server } = schemas(true);
    const { reader, databasePath } = await seededReplica(server, v1);
    await reader.client.setWindow({ variable: 'lib_id' }, ['l1']);
    await reader.client.setWindow({ variable: 'owner_id' }, ['u1']);
    await reader.client.syncUntilIdle();
    await reader.client.close();
    reader.db.close();

    const bumped = await makeClient(server, {
      clientId: 'reader',
      databasePath,
      schema: v2,
    });
    const catalogRead = () =>
      bumped.client.querySnapshot({
        sql: 'SELECT id FROM catalog ORDER BY id',
        coverage: [
          { table: 'catalog', base: { variable: 'lib_id' }, units: ['l1'] },
        ],
      });
    const notesRead = () =>
      bumped.client.querySnapshot({
        sql: 'SELECT id FROM notes',
        coverage: [
          { table: 'notes', base: { variable: 'owner_id' }, units: ['u1'] },
        ],
      });
    const status = bumped.client.statusSnapshot();
    expect(status).toMatchObject({ upgrading: true, upgradeKeptTables: true });
    expect(classifySyncAvailability(status)).toEqual({ state: 'ready' });
    expect(catalogRead()).toMatchObject({
      rows: [{ id: 'c1' }, { id: 'c2' }, { id: 'kept' }],
      coverage: { complete: true },
    });
    expect(notesRead()).toMatchObject({
      rows: [],
      coverage: { complete: false },
    });

    await bumped.client.syncUntilIdle();
    expect(notesRead()).toMatchObject({
      rows: [{ id: 'n1' }],
      coverage: { complete: true },
    });
    expect(bumped.client.statusSnapshot()).toMatchObject({
      upgrading: false,
      upgradeKeptTables: false,
    });
    await bumped.client.close();
    bumped.db.close();
  });

  test('a schema without generations resets every table and unit', async () => {
    const { v1, v2, server } = schemas(false);
    const { reader, databasePath } = await seededReplica(server, v1);
    await reader.client.close();
    reader.db.close();

    const bumped = await makeClient(server, {
      clientId: 'reader',
      databasePath,
      schema: v2,
    });
    expect(bumped.client.units().map((unit) => unit.cursor)).toEqual([
      -1, -1, -1,
    ]);
    const status = bumped.client.statusSnapshot();
    expect(status).toMatchObject({ upgrading: true, upgradeKeptTables: false });
    expect(classifySyncAvailability(status)).toEqual({
      state: 'migrating',
      currentSchemaVersion: 2,
    });
    expect(bumped.db.query('SELECT id FROM catalog')).toEqual([]);
    await bumped.client.syncUntilIdle();
    const first = pullOf(bumped.requests[0]!);
    expect(first.cursor).toBe(-1);
    expect(Object.keys(first.progress)).toHaveLength(3);
    expect(bumped.db.query('SELECT id FROM catalog ORDER BY id')).toEqual([
      { id: 'c1' },
      { id: 'c2' },
    ]);
    await bumped.client.close();
    bumped.db.close();
  });

  test('invalid persisted generations refuse the bump before any write', async () => {
    const { v1, v2, server } = schemas(true);
    const { reader, databasePath } = await seededReplica(server, v1);
    reader.db.exec(
      "UPDATE _syncular_meta SET value='[1]' WHERE key='localTableGenerations'",
    );
    await reader.client.close();
    reader.db.close();

    await expect(
      makeClient(server, { clientId: 'reader', databasePath, schema: v2 }),
    ).rejects.toMatchObject({ code: 'sync.local_corrupt' });
    const { BunClientDatabase } = await import('@syncular/client/bun');
    const db = new BunClientDatabase(databasePath);
    expect(
      db.query(
        "SELECT value FROM _syncular_meta WHERE key='localSchemaVersion'",
      ),
    ).toEqual([{ value: '1' }]);
    expect(db.query('SELECT COUNT(*) AS n FROM notes')).toEqual([{ n: 1 }]);
    db.close();
  });
});

test('a schema whose equivalentGenerations are not strings is refused (§7.4.3)', () => {
  // A hand-edited generated module: JSON carries no static type.
  for (const list of ['"g1"', '[1]']) {
    const schema: ClientSchema = JSON.parse(
      `{"version":1,"tables":[${JSON.stringify(catalog('g2')).slice(0, -1)},"equivalentGenerations":${list}}]}`,
    );
    expect(() => compileClientSchema(schema)).toThrow(
      'equivalentGenerations must be strings',
    );
  }
});
