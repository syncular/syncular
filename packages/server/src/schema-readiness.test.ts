import { afterEach, describe, expect, it } from 'bun:test';
import { createDatabase } from '@syncular/core';
import { createBunSqliteDialect } from '@syncular/server/bun-sqlite';
import { createSqliteServerDialect } from '@syncular/server/sqlite';
import type { Kysely } from 'kysely';
import { ensureSyncSchema } from './migrate';
import type { SyncCoreDb } from './schema';
import {
  getSyncularServerSchemaReadiness,
  SYNCULAR_CORE_TABLES,
} from './schema-readiness';

interface TasksTable {
  id: string;
  title: string;
}

interface TestDb extends SyncCoreDb {
  tasks: TasksTable;
}

describe('getSyncularServerSchemaReadiness', () => {
  let db: Kysely<TestDb> | undefined;

  afterEach(async () => {
    await db?.destroy();
    db = undefined;
  });

  it('reports missing Syncular core tables and app tables without migrating', async () => {
    db = createTestDb();

    const result = await getSyncularServerSchemaReadiness(db, {
      expectedAppTables: ['tasks'],
      expectedSchemaVersion: 1,
      now: () => 1,
    });

    expect(result).toMatchObject({
      generatedAt: 1,
      status: 'not-ready',
      ready: false,
      requiresAction: true,
      tables: {
        missingCore: [...SYNCULAR_CORE_TABLES],
        missingApp: ['tasks'],
      },
      schemaVersion: {
        expectedSchemaVersion: 1,
        requiredSchemaVersion: null,
        latestSchemaVersion: null,
      },
    });
    expect(result.issues.map((issue) => issue.code)).toEqual([
      'server.sync_schema_missing',
      'server.app_tables_missing',
    ]);
  });

  it('reports ready when Syncular and app tables are installed', async () => {
    db = createTestDb();
    await ensureSyncSchema(db, createSqliteServerDialect());
    await db.schema
      .createTable('tasks')
      .addColumn('id', 'text', (column) => column.primaryKey())
      .addColumn('title', 'text', (column) => column.notNull())
      .execute();

    const result = await getSyncularServerSchemaReadiness(db, {
      expectedAppTables: ['tasks'],
      expectedSchemaVersion: 1,
      requiredSchemaVersion: 1,
      latestSchemaVersion: 1,
    });

    expect(result.status).toBe('ready');
    expect(result.ready).toBe(true);
    expect(result.tables.missingCore).toEqual([]);
    expect(result.tables.missingApp).toEqual([]);
    expect(result.tables.installed).toContain('tasks');
    expect(result.issues).toEqual([]);
  });

  it('distinguishes stale server schema from newer server requirements', async () => {
    db = createTestDb();
    await ensureSyncSchema(db, createSqliteServerDialect());

    const staleServer = await getSyncularServerSchemaReadiness(db, {
      expectedSchemaVersion: 2,
      latestSchemaVersion: 1,
    });
    expect(staleServer.status).toBe('not-ready');
    expect(staleServer.issues).toEqual([
      expect.objectContaining({
        code: 'server.schema_version_server_stale',
        recommendedAction: 'redeployServer',
      }),
    ]);

    const requiredNewerClient = await getSyncularServerSchemaReadiness(db, {
      expectedSchemaVersion: 1,
      requiredSchemaVersion: 2,
      latestSchemaVersion: 2,
    });
    expect(requiredNewerClient.status).toBe('not-ready');
    expect(requiredNewerClient.issues.map((issue) => issue.code)).toEqual([
      'server.schema_version_required_newer_client',
      'server.schema_version_newer_available',
    ]);
  });
});

function createTestDb(): Kysely<TestDb> {
  return createDatabase<TestDb>({
    dialect: createBunSqliteDialect({ path: ':memory:' }),
    family: 'sqlite',
  });
}
