import { describe, expect, it } from 'bun:test';
import {
  SyncPullRequestSchema,
  SyncSnapshotChunkRefSchema,
} from '../schemas/sync';
import {
  BinarySnapshotTableWriter,
  decodeBinarySnapshotTable,
  encodeBinarySnapshotTable,
  isSyncSnapshotChunkEncoding,
  SYNC_SNAPSHOT_CHUNK_ENCODING_BINARY_TABLE_V1,
  SYNC_SNAPSHOT_CHUNK_ENCODING_JSON_ROW_FRAME_V1,
} from '../snapshot-chunks';

describe('snapshot chunk protocol negotiation', () => {
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

describe('binary snapshot table format', () => {
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
});
