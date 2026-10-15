/**
 * §2.4 primary-key eligibility: `integer` and `boolean` keys author, patch,
 * delete, and push like string keys; the rowId is the key's string form.
 */
import { expect, test } from 'bun:test';
import { decodeRow, type RowColumn } from '@syncular/core';
import type { ClientSchema } from '@syncular/client';
import type { ServerSchema } from '@syncular/server';
import { makeClient, makeServer, PARTITION } from './helpers';

const COUNTER_COLUMNS: readonly RowColumn[] = [
  { name: 'id', type: 'integer', nullable: false },
  { name: 'project_id', type: 'string', nullable: false },
  { name: 'title', type: 'string', nullable: false },
];
const FLAG_COLUMNS: readonly RowColumn[] = [
  { name: 'id', type: 'boolean', nullable: false },
  { name: 'project_id', type: 'string', nullable: false },
  { name: 'title', type: 'string', nullable: false },
];
const TABLES = [
  {
    name: 'counters',
    columns: COUNTER_COLUMNS,
    primaryKey: 'id',
    scopes: ['project:{project_id}'],
  },
  {
    name: 'flags',
    columns: FLAG_COLUMNS,
    primaryKey: 'id',
    scopes: ['project:{project_id}'],
  },
] as const;
const SERVER: ServerSchema = { version: 1, tables: TABLES };
const CLIENT: ClientSchema = { version: 1, tables: TABLES };

test('integer and boolean primary keys round-trip mutate, patch, and delete', async () => {
  const server = makeServer(SERVER);
  server.allowed['actor'] = { project_id: ['p1'] };
  const { client, db } = await makeClient(server, {
    clientId: 'typed-pk',
    actorId: 'actor',
    schema: CLIENT,
  });

  client.mutate([
    {
      table: 'counters',
      op: 'upsert',
      values: { id: 42, project_id: 'p1', title: 'created' },
    },
    {
      table: 'flags',
      op: 'upsert',
      values: { id: true, project_id: 'p1', title: 'on' },
    },
  ]);
  client.patch('counters', '42', { title: 'patched' });
  client.patch('flags', 'true', { title: 'patched' });
  expect(db.query('SELECT id, title FROM counters')).toEqual([
    { id: 42, title: 'patched' },
  ]);
  expect(db.query('SELECT id, title FROM flags')).toEqual([
    { id: 1, title: 'patched' },
  ]);
  await client.syncUntilIdle();

  const counter = await server.storage.getRow(PARTITION, 'counters', '42');
  expect(decodeRow(COUNTER_COLUMNS, counter!.payload)).toEqual([
    42,
    'p1',
    'patched',
  ]);
  const flag = await server.storage.getRow(PARTITION, 'flags', 'true');
  expect(decodeRow(FLAG_COLUMNS, flag!.payload)).toEqual([
    true,
    'p1',
    'patched',
  ]);

  client.mutate([
    { table: 'counters', op: 'delete', rowId: '42' },
    { table: 'flags', op: 'delete', rowId: 'true' },
  ]);
  expect(db.query('SELECT id FROM counters')).toEqual([]);
  expect(db.query('SELECT id FROM flags')).toEqual([]);
  await client.syncUntilIdle();
  expect(
    await server.storage.getRow(PARTITION, 'counters', '42'),
  ).toBeUndefined();
  expect(
    await server.storage.getRow(PARTITION, 'flags', 'true'),
  ).toBeUndefined();
  await client.close();
  db.close();
});

test('a non-canonical integer rowId names no row', async () => {
  const server = makeServer(SERVER);
  const { client, db } = await makeClient(server, {
    clientId: 'typed-pk-canonical',
    schema: CLIENT,
  });
  client.mutate([
    {
      table: 'counters',
      op: 'upsert',
      values: { id: 42, project_id: 'p1', title: 'created' },
    },
  ]);
  for (const rowId of ['042', '+42', '42.0']) {
    expect(() => client.patch('counters', rowId, { title: 'x' })).toThrow(
      expect.objectContaining({ code: 'sync.row_missing' }),
    );
  }
  await client.close();
  db.close();
});
