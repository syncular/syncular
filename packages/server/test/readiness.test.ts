import { describe, expect, test } from 'bun:test';
import {
  ensureSyncServerReady,
  type ServerSchema,
  SqliteServerStorage,
  SyncServerReadinessError,
} from '@syncular/server';

const V1: ServerSchema = {
  version: 1,
  tables: [
    {
      name: 'tasks',
      primaryKey: 'id',
      scopes: ['project:{project_id}'],
      columns: [
        { name: 'id', type: 'string', nullable: false },
        { name: 'project_id', type: 'string', nullable: false },
        { name: 'title', type: 'string', nullable: false },
      ],
    },
  ],
};

describe('explicit server readiness', () => {
  test('accepts the generated ServerSchema shape and prepares storage', async () => {
    const storage = new SqliteServerStorage();
    await ensureSyncServerReady({ schema: V1, storage });

    const transaction = await storage.begin('tenant-1');
    await transaction.rollback();
  });

  test('classifies schema compilation separately from storage migration', async () => {
    const duplicateTable: ServerSchema = {
      version: 2,
      tables: [...V1.tables, V1.tables[0]!],
    };
    const compileFailure = ensureSyncServerReady({
      schema: duplicateTable,
      storage: new SqliteServerStorage(),
    });
    await expect(compileFailure).rejects.toBeInstanceOf(
      SyncServerReadinessError,
    );
    await compileFailure.catch((error: SyncServerReadinessError) => {
      expect(error.code).toBe('sync.schema_not_ready');
      expect(error.phase).toBe('schema_compile');
      expect(error.schemaVersion).toBe(2);
      expect(error.cause).toBeInstanceOf(Error);
    });

    const storage = new SqliteServerStorage();
    await ensureSyncServerReady({ schema: V1, storage });
    const requiredAppend: ServerSchema = {
      version: 2,
      tables: [
        {
          ...V1.tables[0]!,
          columns: [
            ...V1.tables[0]!.columns,
            { name: 'required_new', type: 'string', nullable: false },
          ],
        },
      ],
    };
    const migrationFailure = ensureSyncServerReady({
      schema: requiredAppend,
      storage,
    });
    await expect(migrationFailure).rejects.toBeInstanceOf(
      SyncServerReadinessError,
    );
    await migrationFailure.catch((error: SyncServerReadinessError) => {
      expect(error.code).toBe('sync.schema_not_ready');
      expect(error.phase).toBe('storage_migration');
      expect(error.schemaVersion).toBe(2);
      expect((error.cause as Error).message).toContain('must be nullable');
    });
  });
});
