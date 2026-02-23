import { Database } from 'bun:sqlite';
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import type { SyncClientDb } from '@syncular/client';
import { Kysely } from 'kysely';
import { BunSqliteDialect } from 'kysely-bun-sqlite';

import {
  createFieldEncryptionPlugin,
  createStaticFieldEncryptionKeys,
  generateSymmetricKey,
} from '../index';

interface SharedTasksTable {
  id: string;
  share_id: string;
  owner_id: string;
  title: string;
  completed: number;
}

interface TestDb extends SyncClientDb {
  shared_tasks: SharedTasksTable;
}

async function createTestDb(): Promise<Kysely<TestDb>> {
  const db = new Kysely<TestDb>({
    dialect: new BunSqliteDialect({
      database: new Database(':memory:'),
    }),
  });

  await db.schema
    .createTable('shared_tasks')
    .addColumn('id', 'text', (col) => col.primaryKey())
    .addColumn('share_id', 'text', (col) => col.notNull())
    .addColumn('owner_id', 'text', (col) => col.notNull())
    .addColumn('title', 'text', (col) => col.notNull())
    .addColumn('completed', 'integer', (col) => col.notNull().defaultTo(0))
    .execute();

  return db;
}

describe('refreshEncryptedFields', () => {
  let db: Kysely<TestDb>;

  beforeEach(async () => {
    db = await createTestDb();
  });

  afterEach(async () => {
    await db.destroy();
  });

  test('decrypts existing ciphertext rows and records local mutations', async () => {
    const ownerKid = 'share-demo';
    const ownerKey = generateSymmetricKey();
    const rule = {
      scope: 'shared_tasks',
      table: 'shared_tasks',
      fields: ['title'],
    };

    const ownerPlugin = createFieldEncryptionPlugin({
      rules: [rule],
      keys: createStaticFieldEncryptionKeys({
        keys: { [ownerKid]: ownerKey },
        encryptionKid: ownerKid,
      }),
      decryptionErrorMode: 'keepCiphertext',
    });

    const pushRequest = {
      clientId: 'alice-client',
      clientCommitId: 'commit-1',
      schemaVersion: 1,
      operations: [
        {
          table: 'shared_tasks',
          row_id: 'task-1',
          op: 'upsert' as const,
          base_version: null,
          payload: {
            id: 'task-1',
            share_id: 'share-1',
            owner_id: 'alice',
            title: 'Top secret',
            completed: 0,
          },
        },
      ],
    };

    const encryptedRequest = await ownerPlugin.beforePush!(
      { actorId: 'alice', clientId: 'alice-client' },
      pushRequest
    );

    const encryptedTitle =
      encryptedRequest.operations[0]?.payload?.title ?? null;
    expect(typeof encryptedTitle).toBe('string');
    expect(String(encryptedTitle).startsWith('dgsync:e2ee:1:')).toBe(true);

    await db
      .insertInto('shared_tasks')
      .values({
        id: 'task-1',
        share_id: 'share-1',
        owner_id: 'alice',
        title: String(encryptedTitle),
        completed: 0,
      })
      .execute();

    let importedKey: Uint8Array | null = null;
    const recipientPlugin = createFieldEncryptionPlugin({
      rules: [rule],
      keys: {
        async getKey(kid: string): Promise<Uint8Array> {
          if (!importedKey || kid !== ownerKid) {
            throw new Error(`Missing encryption key for kid "${kid}"`);
          }
          return importedKey;
        },
        getEncryptionKid() {
          return ownerKid;
        },
      },
      decryptionErrorMode: 'keepCiphertext',
    });

    const recordLocalMutations = mock(
      (
        _inputs: Array<{
          table: string;
          rowId: string;
          op: 'upsert' | 'delete';
        }>
      ) => {}
    );
    const engine = { recordLocalMutations };

    const beforeImport = await recipientPlugin.refreshEncryptedFields({
      db,
      engine,
      ctx: { actorId: 'bob', clientId: 'bob-client' },
      targets: [
        { scope: 'shared_tasks', table: 'shared_tasks', fields: ['title'] },
      ],
    });

    expect(beforeImport.rowsUpdated).toBe(0);
    expect(beforeImport.fieldsUpdated).toBe(0);
    expect(recordLocalMutations).toHaveBeenCalledTimes(0);

    importedKey = ownerKey;

    const afterImport = await recipientPlugin.refreshEncryptedFields({
      db,
      engine,
      ctx: { actorId: 'bob', clientId: 'bob-client' },
      targets: [
        { scope: 'shared_tasks', table: 'shared_tasks', fields: ['title'] },
      ],
    });

    expect(afterImport.rowsUpdated).toBe(1);
    expect(afterImport.fieldsUpdated).toBe(1);
    expect(recordLocalMutations).toHaveBeenCalledTimes(1);
    expect(recordLocalMutations.mock.calls[0]?.[0]).toEqual([
      { table: 'shared_tasks', rowId: 'task-1', op: 'upsert' },
    ]);

    const row = await db
      .selectFrom('shared_tasks')
      .select(['title'])
      .where('id', '=', 'task-1')
      .executeTakeFirstOrThrow();

    expect(row.title).toBe('Top secret');
  });
});
