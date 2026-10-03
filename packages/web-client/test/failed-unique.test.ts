import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { SyncClient, type ClientSchema } from '@syncular/client';
import { BunClientDatabase } from '@syncular/client/bun';
import {
  handleSyncRequest,
  handleSegmentDownload,
  MemorySegmentStore,
  PostgresServerStorage,
  SqliteServerStorage,
  ValidationRejection,
} from '@syncular/server';
import { pgliteExecutor } from '@syncular/server/pglite';

const schema: ClientSchema = {
  version: 1,
  tables: [
    {
      name: 'versions',
      primaryKey: 'id',
      scopes: ['theatre:{theatre_id}'],
      columns: [
        { name: 'id', type: 'string', nullable: false },
        { name: 'theatre_id', type: 'string', nullable: false },
        { name: 'publication_number', type: 'integer', nullable: false },
        { name: 'body', type: 'string', nullable: false },
      ],
      indexes: [
        {
          name: 'versions_publication',
          columns: ['theatre_id', 'publication_number'],
          unique: true,
        },
      ],
    },
  ],
};

for (const backend of ['sqlite', 'pglite'] as const) {
  for (const resolution of [
    'server',
    'mine',
    'edit',
    'revoke',
    'purge',
  ] as const) {
    test(`${backend}: retained distinct-ID UNIQUE insert survives pull/reopen and ${resolution}`, async () => {
      const directory = mkdtempSync(join(tmpdir(), 'syncular-failed-unique-'));
      const pg = backend === 'pglite' ? await PGlite.create() : undefined;
      const storage = pg
        ? new PostgresServerStorage(pgliteExecutor(pg))
        : new SqliteServerStorage();
      const segments = new MemorySegmentStore();
      let allowed = ['one'];
      const databases: BunClientDatabase[] = [];
      const clients: SyncClient[] = [];
      async function open(id: string) {
        const database = new BunClientDatabase(join(directory, `${id}.db`));
        databases.push(database);
        const context = {
          partition: 'test',
          actorId: id,
          schema,
          storage,
          segments,
          resolveScopes: () => ({ theatre_id: allowed }),
          clock: () => 1750000000000,
        };
        const client = new SyncClient({
          schema,
          database,
          clientId: id,
          retainFailedCommits: true,
          transport: (bytes) => handleSyncRequest(bytes, context),
          segments: async (request) =>
            (
              await handleSegmentDownload(context, {
                segmentId: request.segmentId,
                scopesHeader: request.requestedScopesJson,
              })
            ).bytes,
        });
        clients.push(client);
        await client.start();
        client.subscribe({
          id: 'versions',
          table: 'versions',
          scopes: { theatre_id: ['one'] },
        });
        return client;
      }
      try {
        const a = await open('winner');
        let b = await open('loser');
        await a.syncUntilIdle();
        await b.syncUntilIdle();
        a.mutate([
          {
            table: 'versions',
            op: 'upsert',
            values: {
              id: 'a',
              theatre_id: 'one',
              publication_number: 1,
              body: 'server',
            },
          },
        ]);
        const losing = b.mutate([
          {
            table: 'versions',
            op: 'upsert',
            values: {
              id: 'b',
              theatre_id: 'one',
              publication_number: 1,
              body: 'mine',
            },
          },
        ]);
        await a.syncUntilIdle();
        await b.syncUntilIdle();
        await b.syncUntilIdle();
        expect(b.pendingCommits()).toEqual([]);
        expect(b.query('SELECT id, body FROM versions')).toEqual([
          { id: 'a', body: 'server' },
        ]);
        expect(b.commitOutcome(losing)).toMatchObject({
          status: 'rejected',
          resolution: 'active',
          retainedRows: [
            {
              rowId: 'b',
              localRow: { id: 'b', body: 'mine' },
              serverRow: null,
              uniqueConflicts: [
                {
                  index: 'versions_publication',
                  columns: ['theatre_id', 'publication_number'],
                  rowId: 'a',
                  serverVersion: 1,
                  serverRow: { id: 'a', body: 'server' },
                },
              ],
            },
          ],
        });
        await b.close();
        // Simulate an interrupted 0.30.10 replica whose winner committed before replay failed.
        databases
          .at(-1)!
          .exec(
            'ALTER TABLE _syncular_failed_rows DROP COLUMN unique_conflicts',
          );
        databases.at(-1)!.close();
        b = await open('loser');
        await b.syncUntilIdle();
        expect(b.query('SELECT id FROM versions')).toEqual([{ id: 'a' }]);
        a.patch('versions', 'a', { body: 'latest' });
        await a.syncUntilIdle();
        const batches: boolean[] = [];
        b.onChange((batch) => batches.push(batch.outcomesChanged));
        await b.syncUntilIdle();
        expect(batches).toContain(true);
        expect(b.commitOutcome(losing)?.retainedRows).toMatchObject([
          {
            uniqueConflicts: [
              { serverVersion: 2, serverRow: { body: 'latest' } },
            ],
          },
        ]);
        if (resolution === 'revoke' || resolution === 'purge') {
          if (resolution === 'revoke') {
            allowed = [];
            await b.syncUntilIdle();
          } else
            b.purgeLocalData({
              purgeId: 'revocation',
              targets: [
                { table: 'versions', selectors: { theatre_id: ['one'] } },
              ],
            });
          expect(b.query('SELECT id FROM versions')).toEqual([]);
          expect(b.commitOutcome(losing)?.retainedRows).toBeUndefined();
          expect(b.commitOutcome(losing)?.operations).toBeUndefined();
        } else {
          const replacement =
            resolution === 'mine'
              ? b.patch('versions', 'a', { body: 'mine' }, { baseVersion: 2 })
              : resolution === 'edit'
                ? b.mutate([
                    {
                      table: 'versions',
                      op: 'upsert',
                      values: {
                        id: 'b',
                        theatre_id: 'one',
                        publication_number: 2,
                        body: 'edited',
                      },
                      baseVersion: 0,
                    },
                  ])
                : undefined;
          b.resolveCommitOutcome({
            clientCommitId: losing,
            resolution: replacement ? 'superseded' : 'resolved_keep_server',
            ...(replacement ? { replacementClientCommitId: replacement } : {}),
          });
          await b.syncUntilIdle();
          expect(b.commitOutcome(losing)?.retainedRows).toBeUndefined();
          expect(b.query('SELECT id, body FROM versions ORDER BY id')).toEqual(
            resolution === 'edit'
              ? [
                  { id: 'a', body: 'latest' },
                  { id: 'b', body: 'edited' },
                ]
              : [{ id: 'a', body: resolution === 'mine' ? 'mine' : 'latest' }],
          );
        }
        expect(b.query('PRAGMA integrity_check')).toEqual([
          { integrity_check: 'ok' },
        ]);
      } finally {
        for (const client of clients) await client.close();
        for (const database of databases) database.close();
        if (storage instanceof SqliteServerStorage) storage.db.close();
        await pg?.close();
        rmSync(directory, { recursive: true, force: true });
      }
    }, 15000);
  }
}

test('a later winner imports over visible failed intent; freeing the key restores intent and clears evidence', async () => {
  const storage = new SqliteServerStorage();
  const segments = new MemorySegmentStore();
  const databases = [new BunClientDatabase(), new BunClientDatabase()];
  const clients = databases.map(
    (database, index) =>
      new SyncClient({
        schema,
        database,
        clientId: `later-${index}`,
        retainFailedCommits: true,
        transport: (bytes) =>
          handleSyncRequest(bytes, {
            schema,
            storage,
            segments,
            partition: 'late',
            actorId: String(index),
            resolveScopes: () => ({ theatre_id: ['one'] }),
            validators: {
              versions: (operation) => {
                if (operation.row?.body === 'mine')
                  throw new ValidationRejection(
                    'app.invalid_version',
                    'invalid version',
                  );
              },
            },
          }),
      }),
  );
  try {
    const [a, b] = clients;
    for (const client of clients) {
      await client.start();
      client.subscribe({
        id: 'versions',
        table: 'versions',
        scopes: { theatre_id: ['one'] },
      });
      await client.syncUntilIdle();
    }
    const losing = b!.mutate([
      {
        table: 'versions',
        op: 'upsert',
        values: {
          id: 'loser',
          theatre_id: 'one',
          publication_number: 1,
          body: 'mine',
        },
      },
    ]);
    await b!.syncUntilIdle();
    expect(b!.query('SELECT id FROM versions')).toEqual([{ id: 'loser' }]);
    a!.mutate([
      {
        table: 'versions',
        op: 'upsert',
        values: {
          id: 'winner',
          theatre_id: 'one',
          publication_number: 1,
          body: 'server',
        },
      },
    ]);
    await a!.syncUntilIdle();
    await b!.syncUntilIdle();
    expect(b!.query('SELECT id FROM versions')).toEqual([{ id: 'winner' }]);
    expect(b!.commitOutcome(losing)?.retainedRows).toMatchObject([
      { uniqueConflicts: [{ rowId: 'winner' }] },
    ]);
    // An optimistic patch on the winner cannot change its authorized evidence.
    const pending = b!.patch('versions', 'winner', { body: 'pending' });
    expect(b!.commitOutcome(losing)?.retainedRows).toMatchObject([
      {
        uniqueConflicts: [{ serverRow: { body: 'server' }, serverVersion: 1 }],
      },
    ]);
    await b!.syncUntilIdle();
    expect(b!.commitOutcome(pending)?.status).toBe('applied');
    expect(b!.commitOutcome(losing)?.retainedRows).toMatchObject([
      {
        uniqueConflicts: [{ serverRow: { body: 'pending' }, serverVersion: 2 }],
      },
    ]);
    await a!.syncUntilIdle();
    a!.mutate([{ table: 'versions', op: 'delete', rowId: 'winner' }]);
    await a!.syncUntilIdle();
    await b!.syncUntilIdle();
    expect(b!.query('SELECT id, body FROM versions')).toEqual([
      { id: 'loser', body: 'mine' },
    ]);
    expect(
      b!.commitOutcome(losing)?.retainedRows?.[0]?.uniqueConflicts,
    ).toBeUndefined();
  } finally {
    for (const client of clients) await client.close();
    for (const database of databases) database.close();
    storage.db.close();
  }
});
