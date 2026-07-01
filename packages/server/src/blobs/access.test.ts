import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { type BlobRef, createDatabase } from '@syncular/core';
import { createBunSqliteDialect } from '@syncular/server/bun-sqlite';
import type { Kysely } from 'kysely';
import { createServerHandler } from '../handlers';
import type { SyncCoreDb } from '../schema';
import {
  createScopedBlobAccessChecker,
  createScopedBlobAccessDecisionChecker,
  type ScopedBlobAccessDecision,
} from './access';

interface TasksTable {
  id: string;
  user_id: string;
  image: string | null;
  image_hash: string | null;
  server_version: number;
}

interface PackageAssetsTable {
  id: string;
  partition_id: string;
  project_id: string;
  asset_hash: string;
  asset: string | null;
  server_version: number;
}

interface TestDb extends SyncCoreDb {
  tasks: TasksTable;
  package_assets: PackageAssetsTable;
}

interface ClientDb {
  tasks: {
    id: string;
    user_id: string;
    image: BlobRef | null;
    image_hash: string | null;
    server_version: number;
  };
  package_assets: {
    id: string;
    partition_id: string;
    project_id: string;
    asset_hash: string;
    asset: BlobRef | null;
    server_version: number;
  };
}

describe('createScopedBlobAccessChecker', () => {
  let db: Kysely<TestDb>;

  beforeEach(async () => {
    db = createDatabase<TestDb>({
      dialect: createBunSqliteDialect({ path: ':memory:' }),
      family: 'sqlite',
    });
    await db.schema
      .createTable('tasks')
      .addColumn('id', 'text', (col) => col.primaryKey())
      .addColumn('user_id', 'text', (col) => col.notNull())
      .addColumn('image', 'text')
      .addColumn('image_hash', 'text')
      .addColumn('server_version', 'integer', (col) =>
        col.notNull().defaultTo(0)
      )
      .execute();
  });

  afterEach(async () => {
    await db.destroy();
  });

  const tasksHandler = createServerHandler<TestDb, ClientDb, 'tasks'>({
    table: 'tasks',
    scopes: ['user:{user_id}'],
    resolveScopes: async (ctx) => ({ user_id: [ctx.actorId] }),
  });

  it('allows a blob referenced by a row in the actor scope', async () => {
    const blob: BlobRef = {
      hash: `sha256:${'a'.repeat(64)}`,
      size: 3,
      mimeType: 'image/png',
    };
    await db
      .insertInto('tasks')
      .values({
        id: 'task-1',
        user_id: 'user-1',
        image: JSON.stringify(blob),
        server_version: 1,
      })
      .execute();

    const decisions: ScopedBlobAccessDecision[] = [];
    const canAccessBlob = createScopedBlobAccessChecker({
      db,
      handlers: [tasksHandler],
      references: [{ table: 'tasks', blobColumns: ['image'] }],
      onDecision: (decision) => decisions.push(decision),
    });

    await expect(
      canAccessBlob({
        actorId: 'user-1',
        partitionId: 'default',
        hash: blob.hash,
      })
    ).resolves.toBe(true);
    expect(decisions).toEqual([
      expect.objectContaining({
        allowed: true,
        reason: 'allowed',
        table: 'tasks',
        column: 'image',
        rowId: 'task-1',
      }),
    ]);
  });

  it('can use an exact hash column before checking the blob reference payload', async () => {
    const blob: BlobRef = {
      hash: `sha256:${'f'.repeat(64)}`,
      size: 8,
      mimeType: 'image/png',
    };
    await db
      .insertInto('tasks')
      .values({
        id: 'task-hash-column',
        user_id: 'user-1',
        image: JSON.stringify(blob),
        image_hash: blob.hash,
        server_version: 1,
      })
      .execute();

    const decideBlobAccess = createScopedBlobAccessDecisionChecker({
      db,
      handlers: [tasksHandler],
      references: [
        {
          table: 'tasks',
          blobColumns: ['image'],
          hashColumn: 'image_hash',
        },
      ],
    });

    await expect(
      decideBlobAccess({
        actorId: 'user-1',
        partitionId: 'default',
        hash: blob.hash,
      })
    ).resolves.toMatchObject({
      allowed: true,
      reason: 'allowed',
      table: 'tasks',
      column: 'image',
      rowId: 'task-hash-column',
    });
  });

  it('denies a known hash when the referencing row is outside actor scope', async () => {
    const blob: BlobRef = {
      hash: `sha256:${'b'.repeat(64)}`,
      size: 4,
      mimeType: 'image/png',
    };
    await db
      .insertInto('tasks')
      .values({
        id: 'task-2',
        user_id: 'user-2',
        image: JSON.stringify(blob),
        server_version: 1,
      })
      .execute();

    const decisions: ScopedBlobAccessDecision[] = [];
    const canAccessBlob = createScopedBlobAccessChecker({
      db,
      handlers: [tasksHandler],
      references: [{ table: 'tasks', blobColumns: ['image'] }],
      onDecision: (decision) => decisions.push(decision),
    });

    await expect(
      canAccessBlob({
        actorId: 'user-1',
        partitionId: 'default',
        hash: blob.hash,
      })
    ).resolves.toBe(false);
    expect(decisions).toEqual([
      expect.objectContaining({
        allowed: false,
        reason: 'scope_denied',
        table: 'tasks',
        column: 'image',
        rowId: 'task-2',
      }),
    ]);
  });

  it('denies an unreferenced hash without granting access by hash knowledge', async () => {
    const decisions: ScopedBlobAccessDecision[] = [];
    const canAccessBlob = createScopedBlobAccessChecker({
      db,
      handlers: [tasksHandler],
      references: [{ table: 'tasks', blobColumns: ['image'] }],
      onDecision: (decision) => decisions.push(decision),
    });

    await expect(
      canAccessBlob({
        actorId: 'user-1',
        partitionId: 'default',
        hash: `sha256:${'c'.repeat(64)}`,
      })
    ).resolves.toBe(false);
    expect(decisions).toEqual([
      expect.objectContaining({
        allowed: false,
        reason: 'missing_reference',
      }),
    ]);
  });

  it('returns the scoped access decision for routes that expose typed details', async () => {
    const blob: BlobRef = {
      hash: `sha256:${'d'.repeat(64)}`,
      size: 5,
      mimeType: 'image/png',
    };
    await db
      .insertInto('tasks')
      .values({
        id: 'task-3',
        user_id: 'user-2',
        image: JSON.stringify(blob),
        server_version: 1,
      })
      .execute();

    const decideBlobAccess = createScopedBlobAccessDecisionChecker({
      db,
      handlers: [tasksHandler],
      references: [{ table: 'tasks', blobColumns: ['image'] }],
    });

    await expect(
      decideBlobAccess({
        actorId: 'user-1',
        partitionId: 'default',
        hash: blob.hash,
      })
    ).resolves.toMatchObject({
      allowed: false,
      reason: 'scope_denied',
      table: 'tasks',
      column: 'image',
      rowId: 'task-3',
    });
  });

  it('requires a scoped metadata row in the requested partition for shared bytes', async () => {
    const blob: BlobRef = {
      hash: `sha256:${'e'.repeat(64)}`,
      size: 6,
      mimeType: 'application/octet-stream',
    };
    await db.schema
      .createTable('package_assets')
      .addColumn('id', 'text', (col) => col.primaryKey())
      .addColumn('partition_id', 'text', (col) => col.notNull())
      .addColumn('project_id', 'text', (col) => col.notNull())
      .addColumn('asset_hash', 'text', (col) => col.notNull())
      .addColumn('asset', 'text')
      .addColumn('server_version', 'integer', (col) =>
        col.notNull().defaultTo(0)
      )
      .execute();

    const packageAssetsHandler = createServerHandler<
      TestDb,
      ClientDb,
      'package_assets'
    >({
      table: 'package_assets',
      scopes: ['project:{project_id}'],
      resolveScopes: async () => ({ project_id: ['project-1'] }),
    });
    const decideBlobAccess = createScopedBlobAccessDecisionChecker({
      db,
      handlers: [packageAssetsHandler],
      references: [
        {
          table: 'package_assets',
          blobColumns: ['asset'],
          hashColumn: 'asset_hash',
          partitionColumn: 'partition_id',
        },
      ],
    });

    await db
      .insertInto('package_assets')
      .values({
        id: 'base-asset-global',
        partition_id: 'global',
        project_id: 'project-1',
        asset_hash: blob.hash,
        asset: JSON.stringify(blob),
        server_version: 1,
      })
      .execute();

    await expect(
      decideBlobAccess({
        actorId: 'user-1',
        partitionId: 'campaign-a',
        hash: blob.hash,
      })
    ).resolves.toMatchObject({
      allowed: false,
      reason: 'missing_reference',
    });

    await db
      .insertInto('package_assets')
      .values({
        id: 'base-asset-campaign-a',
        partition_id: 'campaign-a',
        project_id: 'project-1',
        asset_hash: blob.hash,
        asset: JSON.stringify(blob),
        server_version: 1,
      })
      .execute();

    await expect(
      decideBlobAccess({
        actorId: 'user-1',
        partitionId: 'campaign-a',
        hash: blob.hash,
      })
    ).resolves.toMatchObject({
      allowed: true,
      reason: 'allowed',
      table: 'package_assets',
      column: 'asset',
      rowId: 'base-asset-campaign-a',
    });
  });
});
