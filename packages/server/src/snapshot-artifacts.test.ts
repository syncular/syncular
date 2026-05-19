import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { createDatabase } from '@syncular/core';
import type { Kysely } from 'kysely';
import { createBunSqliteDialect } from '../../dialect-bun-sqlite/src';
import { createSqliteServerDialect } from '../../server-dialect-sqlite/src';
import { ensureSyncSchema } from './migrate';
import type { SyncCoreDb } from './schema';
import {
  createScopedSnapshotArtifactManifestForPage,
  createScopedSnapshotArtifactScopeCacheKey,
  insertScopedSnapshotArtifact,
  readScopedSnapshotArtifact,
  readScopedSnapshotArtifactRefByPageKey,
} from './snapshot-artifacts';

interface TestDb extends SyncCoreDb {}

describe('scoped snapshot artifacts', () => {
  let db: Kysely<TestDb>;

  beforeEach(async () => {
    db = createDatabase<TestDb>({
      dialect: createBunSqliteDialect({ path: ':memory:' }),
      family: 'sqlite',
    });
    await ensureSyncSchema(db, createSqliteServerDialect());
  });

  afterEach(async () => {
    await db.destroy();
  });

  it('builds cache keys from scope, subscription, schema, artifact, and features', async () => {
    const base = {
      partitionId: 'workspace-1',
      subscriptionId: 'sub-tasks',
      scopes: { user_id: ['u2', 'u1'], project_id: 'p1' },
      schemaVersion: 7,
      features: ['crdt-yjs', 'blobs'],
    };

    const original = await createScopedSnapshotArtifactScopeCacheKey(base);
    const same = await createScopedSnapshotArtifactScopeCacheKey({
      ...base,
      scopes: { project_id: 'p1', user_id: ['u1', 'u2'] },
      features: ['blobs', 'crdt-yjs', 'blobs'],
    });
    const subscriptionChanged =
      await createScopedSnapshotArtifactScopeCacheKey({
        ...base,
        subscriptionId: 'sub-comments',
      });
    const schemaChanged = await createScopedSnapshotArtifactScopeCacheKey({
      ...base,
      schemaVersion: 8,
    });

    expect(original).toBe(same);
    expect(original.startsWith('snapshot-artifact-v1:')).toBe(true);
    expect(original).toContain(':scope:');
    expect(subscriptionChanged).not.toBe(original);
    expect(schemaChanged).not.toBe(original);
  });

  it('persists artifact metadata and returns the existing id on page-key conflicts', async () => {
    const scopeKey = await createScopedSnapshotArtifactScopeCacheKey({
      partitionId: 'workspace-1',
      subscriptionId: 'sub-tasks',
      scopes: { user_id: 'user-1' },
      schemaVersion: 7,
      features: ['blobs'],
    });
    const expiresAt = new Date(Date.now() + 60_000).toISOString();

    const first = await insertScopedSnapshotArtifact(db, {
      artifactId: 'artifact-1',
      partitionId: 'workspace-1',
      scopeKey,
      subscriptionId: 'sub-tasks',
      table: 'tasks',
      schemaVersion: 7,
      asOfCommitSeq: 42,
      rowCursor: null,
      rowLimit: 50_000,
      rowCount: 12_345,
      nextRowCursor: 'task-12345',
      isFirstPage: true,
      isLastPage: false,
      sha256: 'b'.repeat(64),
      byteLength: 4096,
      featureSet: ['blobs'],
      blobHash: 'sha256:artifact-body',
      expiresAt,
    });
    const second = await insertScopedSnapshotArtifact(db, {
      artifactId: 'artifact-2',
      partitionId: 'workspace-1',
      scopeKey,
      subscriptionId: 'sub-tasks',
      table: 'tasks',
      schemaVersion: 7,
      asOfCommitSeq: 42,
      rowCursor: null,
      rowLimit: 50_000,
      rowCount: 12_345,
      nextRowCursor: 'task-12345',
      isFirstPage: true,
      isLastPage: false,
      sha256: 'b'.repeat(64),
      byteLength: 4096,
      featureSet: ['blobs'],
      blobHash: 'sha256:artifact-body',
      expiresAt: new Date(Date.now() + 120_000).toISOString(),
    });

    expect(second.id).toBe(first.id);
    expect(second.id).toBe('artifact-1');

    const byPageKey = await readScopedSnapshotArtifactRefByPageKey(db, {
      partitionId: 'workspace-1',
      scopeKey,
      subscriptionId: 'sub-tasks',
      table: 'tasks',
      asOfCommitSeq: 42,
      rowCursor: null,
      rowLimit: 50_000,
      artifactKind: 'sqlite-snapshot-v1',
      schemaVersion: '7',
      compression: 'none',
    });
    const byId = await readScopedSnapshotArtifact(db, 'artifact-1');

    expect(byPageKey?.manifest.scopeDigest).toBe(scopeKey.split(':scope:')[1]);
    expect(byPageKey?.rowCount).toBe(12_345);
    expect(byPageKey?.nextRowCursor).toBe('task-12345');
    expect(byId?.blobHash).toBe('sha256:artifact-body');
    expect(byId?.featureSet).toEqual(['blobs']);
  });

  it('binds manifest digest to the scoped page key', async () => {
    const scopeKey = await createScopedSnapshotArtifactScopeCacheKey({
      partitionId: 'workspace-1',
      subscriptionId: 'sub-tasks',
      scopes: { user_id: 'user-1' },
      schemaVersion: 7,
      features: [],
    });
    const manifest = await createScopedSnapshotArtifactManifestForPage({
      partitionId: 'workspace-1',
      scopeKey,
      subscriptionId: 'sub-tasks',
      table: 'tasks',
      schemaVersion: 7,
      asOfCommitSeq: 42,
      rowCursor: null,
      rowLimit: 50_000,
      rowCount: 1,
      nextRowCursor: null,
      isFirstPage: true,
      isLastPage: true,
      byteLength: 16,
      sha256: 'b'.repeat(64),
    });
    const otherScopeKey = await createScopedSnapshotArtifactScopeCacheKey({
      partitionId: 'workspace-1',
      subscriptionId: 'sub-tasks',
      scopes: { user_id: 'user-2' },
      schemaVersion: 7,
      features: [],
    });
    const otherManifest = await createScopedSnapshotArtifactManifestForPage({
      partitionId: 'workspace-1',
      scopeKey: otherScopeKey,
      subscriptionId: 'sub-tasks',
      table: 'tasks',
      schemaVersion: 7,
      asOfCommitSeq: 42,
      rowCursor: null,
      rowLimit: 50_000,
      rowCount: 1,
      nextRowCursor: null,
      isFirstPage: true,
      isLastPage: true,
      byteLength: 16,
      sha256: 'b'.repeat(64),
    });

    expect(otherManifest.digest).not.toBe(manifest.digest);
  });
});
