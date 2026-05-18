import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { createDatabase, decodeBinarySnapshotTable } from '@syncular/core';
import { createBunSqliteDialect } from '../../dialect-bun-sqlite/src';
import { createSqliteServerDialect } from '../../server-dialect-sqlite/src';
import {
  createEncryptedCrdtSystemHandlers,
  encryptedCrdtStreamId,
  pruneEncryptedCrdtSystemRows,
  SYNC_CRDT_CHECKPOINTS_TABLE,
  SYNC_CRDT_UPDATES_TABLE,
} from './encrypted-crdt';
import { ensureSyncSchema } from './migrate';
import type { SyncCoreDb } from './schema';

const dialect = createSqliteServerDialect();

describe('encrypted CRDT system handlers', () => {
  let db: ReturnType<typeof createDatabase<SyncCoreDb>>;

  beforeEach(async () => {
    db = createDatabase<SyncCoreDb>({
      dialect: createBunSqliteDialect({ path: ':memory:' }),
      family: 'sqlite',
    });
    await ensureSyncSchema(db, dialect);
  });

  afterEach(async () => {
    await db.destroy();
  });

  it('creates shared system tables for all encrypted CRDT fields', async () => {
    const tables = await db.introspection.getTables();
    const names = tables.map((table) => table.name);

    expect(names).toContain(SYNC_CRDT_UPDATES_TABLE);
    expect(names).toContain(SYNC_CRDT_CHECKPOINTS_TABLE);
  });

  it('appends encrypted update rows and emits a hidden table change', async () => {
    const [updates] = createEncryptedCrdtSystemHandlers({
      resolveScopes: () => ({ user_id: 'user-1' }),
    });
    const streamId = encryptedCrdtStreamId({
      table: 'tasks',
      rowId: 'task-1',
      field: 'body',
    });

    const result = await dialect.executeInTransaction(db, (trx) =>
      updates.applyOperation(
        {
          db: trx,
          trx,
          actorId: 'user-1',
          auth: { actorId: 'user-1' },
          clientId: 'client-1',
          commitId: 'commit-1',
          schemaVersion: 1,
        },
        {
          table: SYNC_CRDT_UPDATES_TABLE,
          row_id: 'update-1',
          op: 'upsert',
          base_version: null,
          payload: {
            stream_id: streamId,
            app_table: 'tasks',
            row_id: 'task-1',
            field_name: 'body',
            update_id: 'update-1',
            key_id: 'kid-1',
            ciphertext: 'ciphertext',
            scopes: { user_id: 'user-1' },
          },
        },
        0
      )
    );

    expect(result.result.status).toBe('applied');
    expect(result.emittedChanges).toHaveLength(1);
    expect(result.emittedChanges[0]?.table).toBe(SYNC_CRDT_UPDATES_TABLE);
    expect(result.emittedChanges[0]?.row_id).toBe('update-1');
    expect(result.emittedChanges[0]?.row_version).toBe(1);

    const stored = await db
      .selectFrom(SYNC_CRDT_UPDATES_TABLE)
      .select(['stream_id', 'app_table', 'row_id', 'field_name', 'update_id'])
      .executeTakeFirstOrThrow();
    expect(stored).toEqual({
      stream_id: streamId,
      app_table: 'tasks',
      row_id: 'task-1',
      field_name: 'body',
      update_id: 'update-1',
    });
  });

  it('encodes encrypted CRDT system rows as binary tables', () => {
    const [updates, checkpoints] = createEncryptedCrdtSystemHandlers({
      resolveScopes: () => ({ user_id: 'user-1' }),
    });

    const updateBytes = updates.snapshotBinaryEncoder?.([
      {
        seq: 7,
        partition_id: 'default',
        stream_id: 'tasks:task-1:body',
        app_table: 'tasks',
        row_id: 'task-1',
        field_name: 'body',
        update_id: 'update-1',
        actor_id: null,
        client_id: 'client-1',
        key_id: 'kid-1',
        ciphertext: 'ciphertext',
        scopes: { user_id: 'user-1' },
      },
    ]);
    expect(updateBytes).toBeInstanceOf(Uint8Array);
    const updateTable = decodeBinarySnapshotTable(updateBytes!);
    expect(updateTable.table).toBe(SYNC_CRDT_UPDATES_TABLE);
    expect(updateTable.rows[0]).toEqual({
      seq: 7,
      partition_id: 'default',
      stream_id: 'tasks:task-1:body',
      app_table: 'tasks',
      row_id: 'task-1',
      field_name: 'body',
      update_id: 'update-1',
      actor_id: null,
      client_id: 'client-1',
      key_id: 'kid-1',
      ciphertext: 'ciphertext',
      scopes: { user_id: 'user-1' },
    });

    const checkpointBytes = checkpoints.snapshotBinaryEncoder?.([
      {
        seq: 9,
        partition_id: 'default',
        stream_id: 'tasks:task-1:body',
        app_table: 'tasks',
        row_id: 'task-1',
        field_name: 'body',
        checkpoint_id: 'checkpoint-1',
        covers_seq: 8,
        actor_id: 'user-1',
        client_id: null,
        key_id: 'kid-1',
        ciphertext: 'checkpoint-ciphertext',
        scopes: { user_id: 'user-1' },
      },
    ]);
    expect(checkpointBytes).toBeInstanceOf(Uint8Array);
    const checkpointTable = decodeBinarySnapshotTable(checkpointBytes!);
    expect(checkpointTable.table).toBe(SYNC_CRDT_CHECKPOINTS_TABLE);
    expect(checkpointTable.rows[0]?.checkpoint_id).toBe('checkpoint-1');
    expect(checkpointTable.rows[0]?.covers_seq).toBe(8);
    expect(checkpointTable.rows[0]?.scopes).toEqual({ user_id: 'user-1' });
  });

  it('prunes encrypted updates covered by retained same-key checkpoints', async () => {
    const [, checkpoints] = createEncryptedCrdtSystemHandlers({
      resolveScopes: () => ({ user_id: 'user-1' }),
    });
    const [updates] = createEncryptedCrdtSystemHandlers({
      resolveScopes: () => ({ user_id: 'user-1' }),
    });
    const streamId = encryptedCrdtStreamId({
      table: 'tasks',
      rowId: 'task-1',
      field: 'body',
    });

    await dialect.executeInTransaction(db, async (trx) => {
      for (const id of ['update-1', 'update-2', 'update-3']) {
        await updates.applyOperation(
          {
            db: trx,
            trx,
            actorId: 'user-1',
            auth: { actorId: 'user-1' },
            clientId: 'client-1',
            commitId: `commit-${id}`,
            schemaVersion: 1,
          },
          {
            table: SYNC_CRDT_UPDATES_TABLE,
            row_id: id,
            op: 'upsert',
            base_version: null,
            payload: {
              stream_id: streamId,
              app_table: 'tasks',
              row_id: 'task-1',
              field_name: 'body',
              update_id: id,
              key_id: 'kid-1',
              ciphertext: `ciphertext-${id}`,
              scopes: { user_id: 'user-1' },
            },
          },
          0
        );
      }

      await checkpoints.applyOperation(
        {
          db: trx,
          trx,
          actorId: 'user-1',
          auth: { actorId: 'user-1' },
          clientId: 'client-1',
          commitId: 'commit-checkpoint-1',
          schemaVersion: 1,
        },
        {
          table: SYNC_CRDT_CHECKPOINTS_TABLE,
          row_id: 'checkpoint-1',
          op: 'upsert',
          base_version: null,
          payload: {
            stream_id: streamId,
            app_table: 'tasks',
            row_id: 'task-1',
            field_name: 'body',
            checkpoint_id: 'checkpoint-1',
            covers_seq: 2,
            key_id: 'kid-1',
            ciphertext: 'checkpoint-ciphertext',
            scopes: { user_id: 'user-1' },
          },
        },
        0
      );
    });

    const report = await pruneEncryptedCrdtSystemRows(db, {
      partitionId: 'default',
      maxCheckpointsPerStream: 1,
    });
    expect(report).toEqual({ updatesDeleted: 2, checkpointsDeleted: 0 });

    const remainingUpdates = await db
      .selectFrom(SYNC_CRDT_UPDATES_TABLE)
      .select('update_id')
      .orderBy('seq')
      .execute();
    expect(remainingUpdates.map((row) => row.update_id)).toEqual(['update-3']);
  });
});
