import { test, expect } from 'bun:test';
import { PGlite } from '@electric-sql/pglite';
import { SyncClient, ClientSyncError } from '@syncular/client';
import { BunClientDatabase } from '@syncular/client/bun';
import {
  handleSyncRequest,
  handleSegmentDownload,
  MemorySegmentStore,
  PostgresServerStorage,
  type SyncRequestContext,
} from '@syncular/server';
import { pgliteExecutor } from '@syncular/server/pglite';
import { CLIENT_SCHEMA, SERVER_SCHEMA, taskValues } from './helpers';

test('PGlite sync preserves a sparse conflict after the server deletes its base', async () => {
  const pg = await PGlite.create();
  const storage = new PostgresServerStorage(pgliteExecutor(pg));
  const segments = new MemorySegmentStore();
  const context: SyncRequestContext = {
    partition: 'sparse-missing-base',
    actorId: 'member',
    schema: SERVER_SCHEMA,
    storage,
    segments,
    resolveScopes: () => ({ project_id: ['p1'] }),
    clock: () => 1750000000000,
  };
  const databases = [new BunClientDatabase(), new BunClientDatabase()];
  const clients = databases.map(
    (database, index) =>
      new SyncClient({
        database,
        schema: CLIENT_SCHEMA,
        clientId: `pglite-sparse-${index}`,
        retainFailedCommits: true,
        transport: (bytes) => handleSyncRequest(bytes, context),
        segments: async (request) =>
          (
            await handleSegmentDownload(context, {
              segmentId: request.segmentId,
              scopesHeader: request.requestedScopesJson,
            })
          ).bytes,
      }),
  );
  try {
    const [a, b] = clients;
    await a!.start();
    await b!.start();
    a!.subscribe({
      id: 'tasks',
      table: 'tasks',
      scopes: { project_id: ['p1'] },
    });
    b!.subscribe({
      id: 'tasks',
      table: 'tasks',
      scopes: { project_id: ['p1'] },
    });
    await a!.syncUntilIdle();
    await b!.syncUntilIdle();
    expect(() => b!.patch('tasks', 'absent', { title: 'mine' })).toThrow(
      ClientSyncError,
    );
    expect(b!.pendingCommits()).toEqual([]);
    a!.mutate([
      {
        op: 'upsert',
        table: 'tasks',
        values: taskValues('t1', 'p1', 'original'),
      },
    ]);
    await a!.syncUntilIdle();
    await b!.syncUntilIdle();
    const intended = b!.patch(
      'tasks',
      't1',
      { title: 'mine' },
      { baseVersion: 1 },
    );
    a!.mutate([{ op: 'delete', table: 'tasks', rowId: 't1', baseVersion: 1 }]);
    await a!.syncUntilIdle();
    await b!.syncUntilIdle();
    expect(b!.query('SELECT * FROM tasks')).toEqual([]);
    const outcome = b!.commitOutcome(intended)!;
    expect(outcome.operations?.[0]?.values).toEqual({
      id: 't1',
      title: 'mine',
    });
    expect(outcome.retainedRows?.[0]?.serverRow).toBeNull();
    expect(outcome.resolution).toBe('active');
    b!.resolveCommitOutcome({
      clientCommitId: intended,
      resolution: 'resolved_keep_server',
    });
    expect(b!.query('SELECT * FROM tasks')).toEqual([]);
    expect(b!.commitOutcome(intended)?.retainedRows).toBeUndefined();
  } finally {
    for (const client of clients) await client.close();
    for (const database of databases) database.close();
    await pg.close();
  }
}, 15000);
