/** Worker-host E2EE: portable keyrings cross structured clone into the worker. */
import { expect, test } from 'bun:test';
import {
  type ClientSchema,
  createSyncClientHandle,
  type SyncClientHandle,
} from '@syncular/client';
import type { RowColumn } from '@syncular/core';
import type { ServerSchema } from '@syncular/server';
import { makeServer, PARTITION } from './helpers';
import { serveOverHttp } from './http-server';

const WORKER_URL = new URL('./rpc-worker.ts', import.meta.url).href;

const COLUMNS: readonly RowColumn[] = [
  { name: 'id', type: 'string', nullable: false },
  { name: 'project_id', type: 'string', nullable: false },
  { name: 'encryption_key_id', type: 'string', nullable: false },
  {
    name: 'note',
    type: 'bytes',
    nullable: false,
    encrypted: true,
    declaredType: 'string',
  },
];

const TABLE = {
  name: 'secrets',
  columns: COLUMNS,
  primaryKey: 'id',
  scopes: ['project:{project_id}'],
} as const;
const SERVER_SCHEMA: ServerSchema = { version: 1, tables: [TABLE] };
const CLIENT_SCHEMA: ClientSchema = { version: 1, tables: [TABLE] };
const KEY = new Uint8Array(32).fill(0x2a);

function contains(haystack: Uint8Array, needle: Uint8Array): boolean {
  outer: for (
    let index = 0;
    index + needle.length <= haystack.length;
    index += 1
  ) {
    for (let offset = 0; offset < needle.length; offset += 1) {
      if (haystack[index + offset] !== needle[offset]) continue outer;
    }
    return true;
  }
  return false;
}

test('worker keyring encrypts by a row key-id column and decrypts locally', async () => {
  const server = makeServer(SERVER_SCHEMA);
  server.allowed['actor-1'] = { project_id: ['p1'] };
  const http = serveOverHttp(server);
  const handles: SyncClientHandle[] = [];
  const makeHandle = async (clientId: string) => {
    const handle = await createSyncClientHandle({
      worker: () => new Worker(WORKER_URL),
      schema: CLIENT_SCHEMA,
      database: { mode: 'custom' },
      endpoints: { syncUrl: http.syncUrl, segmentsUrl: http.segmentsUrl },
      clientId,
      autoSync: false,
      lockName: `worker-encryption-${clientId}`,
      encryption: {
        keys: { 'practice-key-v1': KEY },
        keyIdColumns: { secrets: 'encryption_key_id' },
      },
    });
    handles.push(handle);
    await handle.subscribe({
      id: 'secrets',
      table: 'secrets',
      scopes: { project_id: ['p1'] },
    });
    await handle.syncUntilIdle();
    return handle;
  };

  try {
    const writer = await makeHandle('worker-encryption-writer');
    const reader = await makeHandle('worker-encryption-reader');
    await writer.mutate([
      {
        table: 'secrets',
        op: 'upsert',
        values: {
          id: 'secret-1',
          project_id: 'p1',
          encryption_key_id: 'practice-key-v1',
          note: 'patient identity',
        },
      },
    ]);
    expect(
      await writer.query('SELECT note FROM secrets WHERE id = ?', ['secret-1']),
    ).toEqual([{ note: 'patient identity' }]);

    await writer.syncUntilIdle();
    const stored = await server.storage.getRow(
      PARTITION,
      'secrets',
      'secret-1',
    );
    expect(stored).toBeDefined();
    expect(
      contains(
        stored?.payload ?? new Uint8Array(),
        new TextEncoder().encode('patient identity'),
      ),
    ).toBe(false);

    await reader.syncUntilIdle();
    expect(
      await reader.query(
        'SELECT encryption_key_id, note FROM secrets WHERE id = ?',
        ['secret-1'],
      ),
    ).toEqual([
      { encryption_key_id: 'practice-key-v1', note: 'patient identity' },
    ]);
  } finally {
    for (const handle of handles) await handle.close();
    await http.stop();
  }
});
