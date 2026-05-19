import { describe, expect, it } from 'bun:test';
import {
  SyncPullRequestSchema,
  SyncSnapshotChunkRefSchema,
} from '../schemas/sync';
import {
  BinarySnapshotTableWriter,
  createScopedSnapshotArtifactManifest,
  decodeBinarySnapshotTable,
  encodeBinarySnapshotTable,
  isSyncSnapshotChunkEncoding,
  scopedSnapshotArtifactDigestPayload,
  SYNC_SCOPED_SNAPSHOT_ARTIFACT_KIND_SQLITE_V1,
  SYNC_SCOPED_SNAPSHOT_ARTIFACT_MANIFEST_VERSION,
  SYNC_SNAPSHOT_ARTIFACT_COMPRESSION_NONE,
  SYNC_SNAPSHOT_CHUNK_ENCODING_BINARY_TABLE_V1,
  SYNC_SNAPSHOT_CHUNK_ENCODING_JSON_ROW_FRAME_V1,
} from '../snapshot-chunks';

describe('snapshot chunk protocol', () => {
  it('accepts advertised JSON and binary snapshot encodings on pull requests', () => {
    const parsed = SyncPullRequestSchema.parse({
      clientId: 'client-1',
      limitCommits: 50,
      limitSnapshotRows: 1000,
      maxSnapshotPages: 4,
      snapshotEncodings: [
        SYNC_SNAPSHOT_CHUNK_ENCODING_BINARY_TABLE_V1,
        SYNC_SNAPSHOT_CHUNK_ENCODING_JSON_ROW_FRAME_V1,
      ],
      subscriptions: [],
    });

    expect(parsed.snapshotEncodings).toEqual([
      SYNC_SNAPSHOT_CHUNK_ENCODING_BINARY_TABLE_V1,
      SYNC_SNAPSHOT_CHUNK_ENCODING_JSON_ROW_FRAME_V1,
    ]);
  });

  it('accepts binary snapshot chunk refs for forward-compatible transport metadata', () => {
    const parsed = SyncSnapshotChunkRefSchema.parse({
      id: 'chunk-1',
      byteLength: 128,
      sha256: '0'.repeat(64),
      encoding: SYNC_SNAPSHOT_CHUNK_ENCODING_BINARY_TABLE_V1,
      compression: 'gzip',
    });

    expect(parsed.encoding).toBe(SYNC_SNAPSHOT_CHUNK_ENCODING_BINARY_TABLE_V1);
    expect(isSyncSnapshotChunkEncoding(parsed.encoding)).toBe(true);
  });

  it('supports generated table writers without generic row lookups', () => {
    const columns = [
      { name: 'id', type: 'string' },
      { name: 'completed', type: 'integer' },
      { name: 'metadata', type: 'json', nullable: true },
    ] as const;
    const writer = new BinarySnapshotTableWriter('tasks', columns, 2);

    writer.beginRow();
    writer.writeString('task-1', 'binary snapshot tasks.id');
    writer.writeInteger(0, 'binary snapshot tasks.completed');
    writer.writeJson({ priority: 'high' }, 'binary snapshot tasks.metadata');

    writer.beginRow();
    writer.writeString('task-2', 'binary snapshot tasks.id');
    writer.writeInteger(1, 'binary snapshot tasks.completed');
    writer.writeNull(2);

    const encoded = writer.finish();
    const generic = encodeBinarySnapshotTable({
      table: 'tasks',
      columns,
      rows: [
        { id: 'task-1', completed: 0, metadata: { priority: 'high' } },
        { id: 'task-2', completed: 1, metadata: null },
      ],
    });

    expect(Array.from(encoded)).toEqual(Array.from(generic));
    expect(decodeBinarySnapshotTable(encoded).rows).toEqual([
      { id: 'task-1', completed: 0, metadata: { priority: 'high' } },
      { id: 'task-2', completed: 1, metadata: null },
    ]);
  });
});

describe('scoped snapshot artifact manifest', () => {
  it('canonicalizes feature order before digesting', async () => {
    const base = {
      version: SYNC_SCOPED_SNAPSHOT_ARTIFACT_MANIFEST_VERSION,
      artifactKind: SYNC_SCOPED_SNAPSHOT_ARTIFACT_KIND_SQLITE_V1,
      partitionId: 'partition-1',
      subscriptionId: 'sub-tasks',
      table: 'tasks',
      schemaVersion: '7',
      asOfCommitSeq: 42,
      scopeDigest: 'a'.repeat(64),
      rowCursor: null,
      rowLimit: 50_000,
      rowCount: 12_345,
      nextRowCursor: 'task-12345',
      isFirstPage: true,
      isLastPage: false,
      compression: SYNC_SNAPSHOT_ARTIFACT_COMPRESSION_NONE,
      byteLength: 4096,
      sha256: 'b'.repeat(64),
    } as const;

    const first = await createScopedSnapshotArtifactManifest({
      ...base,
      featureSet: ['crdt-yjs', 'blobs', 'crdt-yjs'],
    });
    const second = await createScopedSnapshotArtifactManifest({
      ...base,
      featureSet: ['blobs', 'crdt-yjs'],
    });

    expect(first.featureSet).toEqual(['blobs', 'crdt-yjs']);
    expect(first.digest).toBe(second.digest);
    expect(first.digest).toMatch(/^[a-f0-9]{64}$/);
  });

  it('includes scope and subscription identity in the canonical payload', () => {
    const payload = scopedSnapshotArtifactDigestPayload({
      version: SYNC_SCOPED_SNAPSHOT_ARTIFACT_MANIFEST_VERSION,
      artifactKind: SYNC_SCOPED_SNAPSHOT_ARTIFACT_KIND_SQLITE_V1,
      partitionId: 'partition-1',
      subscriptionId: 'sub-tasks',
      table: 'tasks',
      schemaVersion: '7',
      asOfCommitSeq: 42,
      scopeDigest: 'a'.repeat(64),
      rowCursor: null,
      rowLimit: 50_000,
      rowCount: 100,
      nextRowCursor: null,
      isFirstPage: true,
      isLastPage: true,
      compression: SYNC_SNAPSHOT_ARTIFACT_COMPRESSION_NONE,
      byteLength: 4096,
      sha256: 'b'.repeat(64),
      featureSet: ['blobs'],
    });

    expect(payload).toContain('subscriptionId:s:9:sub-tasks');
    expect(payload).toContain(`scopeDigest:s:64:${'a'.repeat(64)}`);
    expect(payload).toContain('feature.0.name:s:5:blobs');
  });
});

describe('binary snapshot table format', () => {
  it('round-trips integer edge values', () => {
    const encoded = encodeBinarySnapshotTable({
      table: 'numbers',
      columns: [{ name: 'value', type: 'integer' }],
      rows: [
        { value: 0 },
        { value: 0xffff_ffff },
        { value: Number.MAX_SAFE_INTEGER },
        { value: -1 },
      ],
    });

    expect(decodeBinarySnapshotTable(encoded).rows).toEqual([
      { value: 0 },
      { value: 0xffff_ffff },
      { value: Number.MAX_SAFE_INTEGER },
      { value: -1 },
    ]);
  });

  it('round-trips typed table rows', () => {
    const encoded = encodeBinarySnapshotTable({
      table: 'tasks',
      columns: [
        { name: 'id', type: 'string' },
        { name: 'owner_id', type: 'string' },
        { name: 'completed', type: 'boolean' },
        { name: 'server_version', type: 'integer' },
        { name: 'score', type: 'float' },
        { name: 'metadata', type: 'json', nullable: true },
        { name: 'payload', type: 'bytes' },
      ],
      rows: [
        {
          id: 'task-1',
          owner_id: 'user-1',
          completed: false,
          server_version: 42,
          score: 1.5,
          metadata: { priority: 'high' },
          payload: new Uint8Array([1, 2, 3]),
        },
        {
          id: 'task-2',
          owner_id: 'user-2',
          completed: true,
          server_version: 43,
          score: 2.25,
          metadata: null,
          payload: new Uint8Array([]),
        },
      ],
    });

    const decoded = decodeBinarySnapshotTable(encoded);

    expect(decoded.table).toBe('tasks');
    expect(decoded.columns).toEqual([
      { name: 'id', type: 'string' },
      { name: 'owner_id', type: 'string' },
      { name: 'completed', type: 'boolean' },
      { name: 'server_version', type: 'integer' },
      { name: 'score', type: 'float' },
      { name: 'metadata', type: 'json', nullable: true },
      { name: 'payload', type: 'bytes' },
    ]);
    expect(decoded.rows).toEqual([
      {
        id: 'task-1',
        owner_id: 'user-1',
        completed: false,
        server_version: 42,
        score: 1.5,
        metadata: { priority: 'high' },
        payload: new Uint8Array([1, 2, 3]),
      },
      {
        id: 'task-2',
        owner_id: 'user-2',
        completed: true,
        server_version: 43,
        score: 2.25,
        metadata: null,
        payload: new Uint8Array([]),
      },
    ]);
  });

  it('round-trips unicode strings through the binary writer fallback', () => {
    const columns = [{ name: 'title', type: 'string' }] as const;
    const writer = new BinarySnapshotTableWriter('tasks', columns, 1);

    writer.beginRow();
    writer.writeString('München 日本語', 'binary snapshot tasks.title');

    expect(decodeBinarySnapshotTable(writer.finish()).rows).toEqual([
      { title: 'München 日本語' },
    ]);
  });
});
