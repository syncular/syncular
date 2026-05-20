import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import {
  createDatabase,
  SYNC_SCOPED_SNAPSHOT_ARTIFACT_KIND_SQLITE_V1,
  SYNC_SNAPSHOT_CHUNK_COMPRESSION,
  SYNC_SNAPSHOT_CHUNK_ENCODING_BINARY_TABLE_V1,
} from '@syncular/core';
import type { Kysely } from 'kysely';
import { createBunSqliteDialect } from '../../dialect-bun-sqlite/src';
import { createSqliteServerDialect } from '../../server-dialect-sqlite/src';
import { createServerHandler, createServerHandlerCollection } from './handlers';
import { ensureSyncSchema } from './migrate';
import { notifyExternalDataChange } from './notify';
import { pull } from './pull';
import type { SyncCoreDb } from './schema';
import {
  createScopedSnapshotArtifactScopeCacheKey,
  insertScopedSnapshotArtifact,
} from './snapshot-artifacts';

interface TasksTable {
  id: string;
  user_id: string;
  title: string;
  server_version: number;
}

interface TestDb extends SyncCoreDb {
  tasks: TasksTable;
}

interface ClientDb {
  tasks: TasksTable;
}

const dialect = createSqliteServerDialect();

describe('pull scoped snapshot artifacts', () => {
  let db: Kysely<TestDb>;

  beforeEach(async () => {
    db = createDatabase<TestDb>({
      dialect: createBunSqliteDialect({ path: ':memory:' }),
      family: 'sqlite',
    });
    await ensureSyncSchema(db, dialect);
    await db.schema
      .createTable('tasks')
      .addColumn('id', 'text', (col) => col.primaryKey())
      .addColumn('user_id', 'text', (col) => col.notNull())
      .addColumn('title', 'text', (col) => col.notNull())
      .addColumn('server_version', 'integer', (col) =>
        col.notNull().defaultTo(0)
      )
      .execute();
  });

  afterEach(async () => {
    await db.destroy();
  });

  it('advertises a matching scoped artifact without querying snapshot rows', async () => {
    await db
      .insertInto('tasks')
      .values([
        { id: 'task-1', user_id: 'u1', title: 'One', server_version: 1 },
        { id: 'task-2', user_id: 'u1', title: 'Two', server_version: 1 },
      ])
      .execute();
    const external = await notifyExternalDataChange({
      db,
      dialect,
      tables: ['tasks'],
    });
    const scopeKey = await createScopedSnapshotArtifactScopeCacheKey({
      partitionId: 'default',
      subscriptionId: 'sub-tasks',
      scopes: { user_id: 'u1' },
      schemaVersion: 7,
      artifactKind: SYNC_SCOPED_SNAPSHOT_ARTIFACT_KIND_SQLITE_V1,
      compression: SYNC_SNAPSHOT_CHUNK_COMPRESSION,
      features: [],
    });
    await insertScopedSnapshotArtifact(db, {
      artifactId: 'artifact-1',
      partitionId: 'default',
      scopeKey,
      subscriptionId: 'sub-tasks',
      table: 'tasks',
      schemaVersion: 7,
      asOfCommitSeq: external.commitSeq,
      rowCursor: null,
      rowLimit: 50_000,
      rowCount: 2,
      nextRowCursor: null,
      isFirstPage: true,
      isLastPage: true,
      sha256: 'a'.repeat(64),
      byteLength: 2048,
      blobHash: 'sha256:artifact-1',
      compression: SYNC_SNAPSHOT_CHUNK_COMPRESSION,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });

    let snapshotCalls = 0;
    const handlers = createServerHandlerCollection<TestDb>([
      createServerHandler<TestDb, ClientDb, 'tasks'>({
        table: 'tasks',
        scopes: ['user:{user_id}'],
        resolveScopes: async (ctx) => ({ user_id: [ctx.actorId] }),
        snapshot: async () => {
          snapshotCalls += 1;
          return { rows: [], nextCursor: null };
        },
      }),
    ]);

    const result = await pull({
      db,
      dialect,
      handlers,
      auth: { actorId: 'u1' },
      snapshotChunkCacheSchemaVersion: 7,
      request: {
        clientId: 'client-1',
        limitCommits: 1000,
        limitSnapshotRows: 50_000,
        maxSnapshotPages: 1,
        snapshotEncodings: [SYNC_SNAPSHOT_CHUNK_ENCODING_BINARY_TABLE_V1],
        snapshotArtifacts: {
          schemaVersion: '7',
          artifactKinds: [SYNC_SCOPED_SNAPSHOT_ARTIFACT_KIND_SQLITE_V1],
          compressions: [SYNC_SNAPSHOT_CHUNK_COMPRESSION],
        },
        subscriptions: [
          {
            id: 'sub-tasks',
            table: 'tasks',
            scopes: { user_id: 'u1' },
            cursor: -1,
          },
        ],
      },
    });

    const snapshot = result.response.subscriptions[0]?.snapshots?.[0];
    expect(snapshotCalls).toBe(0);
    expect(snapshot?.rows).toEqual([]);
    expect(snapshot?.chunks).toBeUndefined();
    expect(snapshot?.artifacts?.[0]?.id).toBe('artifact-1');
    expect(snapshot?.artifacts?.[0]?.manifest.scopeDigest).toBe(
      scopeKey.split(':scope:')[1]
    );
    expect(result.response.subscriptions[0]?.bootstrapState).toBeNull();
  });

  it('continues artifact bootstrap when the best artifact is smaller than the pull capacity', async () => {
    await db
      .insertInto('tasks')
      .values([
        { id: 'task-1', user_id: 'u1', title: 'One', server_version: 1 },
        { id: 'task-2', user_id: 'u1', title: 'Two', server_version: 1 },
      ])
      .execute();
    const external = await notifyExternalDataChange({
      db,
      dialect,
      tables: ['tasks'],
    });
    const scopeKey = await createScopedSnapshotArtifactScopeCacheKey({
      partitionId: 'default',
      subscriptionId: 'sub-tasks',
      scopes: { user_id: 'u1' },
      schemaVersion: 7,
      artifactKind: SYNC_SCOPED_SNAPSHOT_ARTIFACT_KIND_SQLITE_V1,
      compression: SYNC_SNAPSHOT_CHUNK_COMPRESSION,
      features: [],
    });
    const expiresAt = new Date(Date.now() + 60_000).toISOString();
    await insertScopedSnapshotArtifact(db, {
      artifactId: 'artifact-page-1',
      partitionId: 'default',
      scopeKey,
      subscriptionId: 'sub-tasks',
      table: 'tasks',
      schemaVersion: 7,
      asOfCommitSeq: external.commitSeq,
      rowCursor: null,
      rowLimit: 1,
      rowCount: 1,
      nextRowCursor: 'task-1',
      isFirstPage: true,
      isLastPage: false,
      sha256: '1'.repeat(64),
      byteLength: 1024,
      blobHash: 'sha256:artifact-page-1',
      compression: SYNC_SNAPSHOT_CHUNK_COMPRESSION,
      expiresAt,
    });
    await insertScopedSnapshotArtifact(db, {
      artifactId: 'artifact-page-2',
      partitionId: 'default',
      scopeKey,
      subscriptionId: 'sub-tasks',
      table: 'tasks',
      schemaVersion: 7,
      asOfCommitSeq: external.commitSeq,
      rowCursor: 'task-1',
      rowLimit: 1,
      rowCount: 1,
      nextRowCursor: null,
      isFirstPage: false,
      isLastPage: true,
      sha256: '2'.repeat(64),
      byteLength: 1024,
      blobHash: 'sha256:artifact-page-2',
      compression: SYNC_SNAPSHOT_CHUNK_COMPRESSION,
      expiresAt,
    });

    let snapshotCalls = 0;
    const handlers = createServerHandlerCollection<TestDb>([
      createServerHandler<TestDb, ClientDb, 'tasks'>({
        table: 'tasks',
        scopes: ['user:{user_id}'],
        resolveScopes: async (ctx) => ({ user_id: [ctx.actorId] }),
        snapshot: async () => {
          snapshotCalls += 1;
          return { rows: [], nextCursor: null };
        },
      }),
    ]);

    const result = await pull({
      db,
      dialect,
      handlers,
      auth: { actorId: 'u1' },
      snapshotChunkCacheSchemaVersion: 7,
      request: {
        clientId: 'client-1',
        limitCommits: 1000,
        limitSnapshotRows: 1,
        maxSnapshotPages: 2,
        snapshotEncodings: [SYNC_SNAPSHOT_CHUNK_ENCODING_BINARY_TABLE_V1],
        snapshotArtifacts: {
          schemaVersion: '7',
          artifactKinds: [SYNC_SCOPED_SNAPSHOT_ARTIFACT_KIND_SQLITE_V1],
          compressions: [SYNC_SNAPSHOT_CHUNK_COMPRESSION],
        },
        subscriptions: [
          {
            id: 'sub-tasks',
            table: 'tasks',
            scopes: { user_id: 'u1' },
            cursor: -1,
          },
        ],
      },
    });

    const snapshots = result.response.subscriptions[0]?.snapshots ?? [];
    expect(snapshotCalls).toBe(0);
    expect(snapshots.map((snapshot) => snapshot.artifacts?.[0]?.id)).toEqual([
      'artifact-page-1',
      'artifact-page-2',
    ]);
    expect(result.response.subscriptions[0]?.bootstrapState).toBeNull();
  });

  it('uses the row snapshot path when the scoped artifact key does not match', async () => {
    await db
      .insertInto('tasks')
      .values({ id: 'task-1', user_id: 'u1', title: 'One', server_version: 1 })
      .execute();
    const external = await notifyExternalDataChange({
      db,
      dialect,
      tables: ['tasks'],
    });
    const otherScopeKey = await createScopedSnapshotArtifactScopeCacheKey({
      partitionId: 'default',
      subscriptionId: 'sub-tasks',
      scopes: { user_id: 'u2' },
      schemaVersion: 7,
      artifactKind: SYNC_SCOPED_SNAPSHOT_ARTIFACT_KIND_SQLITE_V1,
      compression: SYNC_SNAPSHOT_CHUNK_COMPRESSION,
      features: [],
    });
    await insertScopedSnapshotArtifact(db, {
      artifactId: 'artifact-u2',
      partitionId: 'default',
      scopeKey: otherScopeKey,
      subscriptionId: 'sub-tasks',
      table: 'tasks',
      schemaVersion: 7,
      asOfCommitSeq: external.commitSeq,
      rowCursor: null,
      rowLimit: 50_000,
      rowCount: 1,
      nextRowCursor: null,
      isFirstPage: true,
      isLastPage: true,
      sha256: 'b'.repeat(64),
      byteLength: 1024,
      blobHash: 'sha256:artifact-u2',
      compression: SYNC_SNAPSHOT_CHUNK_COMPRESSION,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });

    let snapshotCalls = 0;
    const handlers = createServerHandlerCollection<TestDb>([
      createServerHandler<TestDb, ClientDb, 'tasks'>({
        table: 'tasks',
        scopes: ['user:{user_id}'],
        resolveScopes: async (ctx) => ({ user_id: [ctx.actorId] }),
        snapshot: async (ctx) => {
          snapshotCalls += 1;
          const rows = await ctx.db
            .selectFrom('tasks')
            .selectAll()
            .where('user_id', '=', 'u1')
            .orderBy('id', 'asc')
            .limit(ctx.limit)
            .execute();
          return { rows, nextCursor: null };
        },
      }),
    ]);

    const result = await pull({
      db,
      dialect,
      handlers,
      auth: { actorId: 'u1' },
      snapshotChunkCacheSchemaVersion: 7,
      request: {
        clientId: 'client-1',
        limitCommits: 1000,
        limitSnapshotRows: 50_000,
        maxSnapshotPages: 1,
        snapshotEncodings: [SYNC_SNAPSHOT_CHUNK_ENCODING_BINARY_TABLE_V1],
        snapshotArtifacts: {
          schemaVersion: '7',
          artifactKinds: [SYNC_SCOPED_SNAPSHOT_ARTIFACT_KIND_SQLITE_V1],
          compressions: [SYNC_SNAPSHOT_CHUNK_COMPRESSION],
        },
        subscriptions: [
          {
            id: 'sub-tasks',
            table: 'tasks',
            scopes: { user_id: 'u1' },
            cursor: -1,
          },
        ],
      },
    });

    const snapshot = result.response.subscriptions[0]?.snapshots?.[0];
    expect(snapshotCalls).toBe(1);
    expect(snapshot?.artifacts).toBeUndefined();
    expect(snapshot?.chunks).toHaveLength(1);
  });
});
