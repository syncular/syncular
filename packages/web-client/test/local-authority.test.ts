/**
 * SPEC §12 in the browser worker: rounds reach the local authority in the
 * replica's sibling file until `attachLocalAuthority` moves the rows to the
 * remote server, and the sqlite-wasm adapter the browser uses.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import {
  ClientSyncError,
  createSyncClientHandle,
  LOCAL_AUTHORITY_UNCONFIGURED_CODE,
  type SyncClientHandle,
} from '@syncular/client';
import { clientSqliteDatabase, openLocalAuthority } from '@syncular/server';
import { openWasmDatabase } from '../src/wasm-database';
import {
  CLIENT_SCHEMA,
  makeServer,
  type TestServer,
  taskValues,
} from './helpers';
import { type HttpTestServer, serveOverHttp } from './http-server';

let server: TestServer;
let http: HttpTestServer;
const handles: SyncClientHandle[] = [];

beforeAll(() => {
  server = makeServer();
  http = serveOverHttp(server);
});

afterAll(async () => {
  for (const handle of handles) await handle.close();
  await http.stop();
});

async function handleFor(
  worker: string,
  clientId: string,
): Promise<SyncClientHandle> {
  const handle = await createSyncClientHandle({
    worker: () => new Worker(new URL(worker, import.meta.url).href),
    schema: CLIENT_SCHEMA,
    database: { mode: 'custom' },
    endpoints: { syncUrl: http.syncUrl, segmentsUrl: http.segmentsUrl },
    localAuthority: true,
    autoSync: false,
    multiTab: false,
    clientId,
    lockName: `local-authority-${clientId}`,
  });
  handles.push(handle);
  return handle;
}

/** Remote row ids; the remote creates its tables at its first request. */
const remoteTasks = (): string[] =>
  server.storage.db
    .query<{ n: number }, []>(
      "SELECT count(*) AS n FROM sqlite_master WHERE name='tasks'",
    )
    .get()?.n === 0
    ? []
    : server.storage.db
        .query<{ id: string }, []>(
          'SELECT _sync_row_id AS id FROM tasks ORDER BY id',
        )
        .all()
        .map((row) => row.id);

test('the worker syncs against its local authority, then attaches to the remote server', async () => {
  const handle = await handleFor('./local-authority-worker.ts', 'local-worker');
  expect(await handle.localAuthorityState()).toBe('local');
  await handle.subscribe({
    id: 'tasks',
    table: 'tasks',
    scopes: { project_id: ['p1'] },
  });
  await handle.mutate([
    {
      table: 'tasks',
      op: 'upsert',
      values: taskValues('local-1', 'p1', 'one'),
    },
    {
      table: 'tasks',
      op: 'upsert',
      values: taskValues('local-2', 'p1', 'two'),
    },
  ]);
  await handle.syncUntilIdle();

  expect(await handle.pendingCommits()).toEqual([]);
  expect(remoteTasks()).toEqual([]);

  await handle.attachLocalAuthority();
  expect(await handle.localAuthorityState()).toBe('attached');
  expect(remoteTasks()).toEqual(['local-1', 'local-2']);

  await handle.syncUntilIdle();
  await handle.mutate([
    {
      table: 'tasks',
      op: 'upsert',
      values: taskValues('remote-3', 'p1', 'three'),
    },
  ]);
  await handle.syncUntilIdle();
  expect(remoteTasks()).toEqual(['local-1', 'local-2', 'remote-3']);
  expect(await handle.query('SELECT id FROM tasks ORDER BY id')).toEqual([
    { id: 'local-1' },
    { id: 'local-2' },
    { id: 'remote-3' },
  ]);
});

test('localAuthority without a worker override fails with a stable code', async () => {
  let caught: unknown;
  try {
    await handleFor('./rpc-worker.ts', 'unconfigured-worker');
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(ClientSyncError);
  expect((caught as ClientSyncError).code).toBe(
    LOCAL_AUTHORITY_UNCONFIGURED_CODE,
  );
});

test('a sqlite-wasm database serves a local authority through clientSqliteDatabase', async () => {
  const database = await openWasmDatabase();
  const authority = await openLocalAuthority({
    database: clientSqliteDatabase(database),
    schema: CLIENT_SCHEMA,
  });
  expect(authority.state).toBe('local');
  expect(
    database.query("SELECT name FROM sqlite_master WHERE name='sync_commits'"),
  ).toEqual([{ name: 'sync_commits' }]);
  database.close();
});
