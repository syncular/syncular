/**
 * `SyncularRealtimeHost` over a caller-built `PostgresServerStorage` (PGlite
 * stands in for PostgreSQL behind Hyperdrive): the host coordinates the
 * storage it was given, and a fresh host over the same database (a Durable
 * Object wake) serves the committed rows.
 */
import { expect, test } from 'bun:test';
import { PGlite } from '@electric-sql/pglite';
import {
  decodeMessage,
  encodeMessage,
  encodeSparseRow,
  type RequestFrame,
  type RowColumn,
} from '@syncular/core';
import {
  compileSchema,
  MemorySegmentStore,
  PostgresServerStorage,
  type ServerSchema,
  SSP2_CONTENT_TYPE,
} from '@syncular/server';
import { pgliteExecutor } from '@syncular/server/pglite';
import {
  type RealtimeDOConfig,
  SYNC_DO_REQUEST_PATH,
  SyncularRealtimeHost,
  writeRequestIdentityHeaders,
} from '../src/index';

const COLUMNS: readonly RowColumn[] = [
  { name: 'id', type: 'string', nullable: false },
  { name: 'list_id', type: 'string', nullable: false },
];

const SCHEMA: ServerSchema = {
  version: 1,
  tables: [
    {
      name: 'tasks',
      columns: COLUMNS,
      primaryKey: 'id',
      scopes: ['list:{list_id}'],
    },
  ],
};

const STATE = { acceptWebSocket: () => {}, getWebSockets: () => [] };

async function round(
  host: SyncularRealtimeHost<PostgresServerStorage>,
  clientId: string,
  frames: RequestFrame[],
) {
  const request = new Request(new URL(SYNC_DO_REQUEST_PATH, 'https://do'), {
    method: 'POST',
    headers: { 'content-type': SSP2_CONTENT_TYPE },
    body: encodeMessage({
      wireVersion: 3,
      msgKind: 'request',
      frames: [
        { type: 'REQ_HEADER', clientId, schemaVersion: 1, logEpoch: 'epoch' },
        ...frames,
      ],
    }).slice().buffer as ArrayBuffer,
  });
  writeRequestIdentityHeaders(request.headers, {
    partition: 'part-1',
    actorId: 'actor-1',
  });
  const response = await host.fetch(request);
  expect(response.status).toBe(200);
  return decodeMessage(new Uint8Array(await response.arrayBuffer())).frames;
}

test('the host serves rounds over a PostgreSQL storage it was given', async () => {
  const db = await PGlite.create();
  const received: PostgresServerStorage[] = [];
  const config: RealtimeDOConfig<PostgresServerStorage> = {
    syncConfig: (storage) => {
      received.push(storage);
      return {
        schema: SCHEMA,
        storage,
        resolveScopes: () => ({ list_id: ['L'] }),
        segments: new MemorySegmentStore(),
      };
    },
  };
  const storage = new PostgresServerStorage(pgliteExecutor(db));
  await storage.ensureSchema(compileSchema(SCHEMA));
  await storage.touchPartition('part-1', 0, 'epoch');
  const pushed = await round(
    new SyncularRealtimeHost(STATE, storage, config),
    'writer',
    [
      {
        type: 'PUSH_COMMIT',
        clientCommitId: 'c1',
        operations: [
          {
            table: 'tasks',
            rowId: 't1',
            op: 'upsert',
            payload: encodeSparseRow(COLUMNS, 0, ['t1', 'L']),
          },
        ],
      },
    ],
  );
  expect(pushed).toContainEqual(
    expect.objectContaining({ type: 'PUSH_RESULT', status: 'applied' }),
  );
  expect(received).toEqual([storage]);
  // A wake builds a new host and storage over the same database.
  const woken = new PostgresServerStorage(pgliteExecutor(db));
  const pulled = await round(
    new SyncularRealtimeHost(STATE, woken, config),
    'reader',
    [
      {
        type: 'PULL_HEADER',
        limitCommits: 100,
        limitSnapshotRows: 100,
        maxSnapshotPages: 4,
        accept: 0b0011,
      },
      {
        type: 'SUBSCRIPTION',
        id: 's1',
        table: 'tasks',
        scopes: { list_id: ['L'] },
        cursor: -1,
      },
    ],
  );
  expect(received).toEqual([storage, woken]);
  expect(pulled.some((frame) => frame.type === 'ERROR')).toBe(false);
  expect(pulled).toContainEqual(expect.objectContaining({ type: 'SUB_START' }));
  await db.close();
});
