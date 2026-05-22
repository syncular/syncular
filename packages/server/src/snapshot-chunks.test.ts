import { describe, expect, it } from 'bun:test';
import { createSnapshotChunkScopeCacheKey } from './snapshot-chunks';

describe('snapshot chunk cache keys', () => {
  it('includes schema, compression, gzip level, feature, partition, and scope semantics', async () => {
    const base = {
      partitionId: 'workspace-1',
      scopes: { user_id: ['u2', 'u1'], project_id: 'p1' },
      schemaVersion: 3,
      encoding: 'binary-table-v1' as const,
      compression: 'gzip' as const,
      gzipLevel: 1,
      features: ['crdt-yjs', 'e2ee'],
    };

    const same = await createSnapshotChunkScopeCacheKey({
      ...base,
      scopes: { project_id: 'p1', user_id: ['u1', 'u2'] },
      features: ['e2ee', 'crdt-yjs'],
    });
    const original = await createSnapshotChunkScopeCacheKey(base);
    const schemaChanged = await createSnapshotChunkScopeCacheKey({
      ...base,
      schemaVersion: 4,
    });
    const gzipChanged = await createSnapshotChunkScopeCacheKey({
      ...base,
      gzipLevel: 6,
    });

    expect(original).toBe(same);
    expect(original.startsWith('snapshot-v2:')).toBe(true);
    expect(original).toContain(':scope:');
    expect(schemaChanged).not.toBe(original);
    expect(gzipChanged).not.toBe(original);
  });
});
