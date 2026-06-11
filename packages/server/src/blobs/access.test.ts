import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { type BlobRef, createDatabase } from '@syncular/core';
import { createBunSqliteDialect } from '@syncular/dialects/bun-sqlite';
import type { Kysely } from 'kysely';
import { createServerHandler } from '../handlers';
import type { SyncCoreDb } from '../schema';
import {
  createScopedBlobAccessChecker,
  type ScopedBlobAccessDecision,
} from './access';

interface TasksTable {
  id: string;
  user_id: string;
  image: string | null;
  server_version: number;
}

interface TestDb extends SyncCoreDb {
  tasks: TasksTable;
}

interface ClientDb {
  tasks: {
    id: string;
    user_id: string;
    image: BlobRef | null;
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
});
