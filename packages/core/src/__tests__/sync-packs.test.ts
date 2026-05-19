import { describe, expect, it } from 'bun:test';
import type {
  SyncCombinedResponse,
  SyncSnapshotChunkRef,
} from '../schemas/sync';
import {
  SyncCombinedRequestSchema,
  SyncPullRequestSchema,
} from '../schemas/sync';
import {
  createSnapshotManifest,
  encodeBinarySnapshotTable,
  SYNC_SNAPSHOT_CHUNK_ENCODING_BINARY_TABLE_V1,
} from '../snapshot-chunks';
import {
  decodeBinarySyncPack,
  encodeBinarySyncPack,
  isBinarySyncPackContentType,
  isSyncPackEncoding,
  SYNC_PACK_CONTENT_TYPE,
  SYNC_PACK_ENCODING_BINARY_V1,
  SYNC_PACK_ENCODING_JSON_V1,
} from '../sync-packs';

describe('sync pack protocol negotiation', () => {
  it('accepts advertised JSON and binary pack encodings on pull requests', () => {
    const parsed = SyncPullRequestSchema.parse({
      clientId: 'client-1',
      limitCommits: 50,
      limitSnapshotRows: 1000,
      syncPackEncodings: [
        SYNC_PACK_ENCODING_BINARY_V1,
        SYNC_PACK_ENCODING_JSON_V1,
      ],
      subscriptions: [],
    });

    expect(parsed.syncPackEncodings).toEqual([
      SYNC_PACK_ENCODING_BINARY_V1,
      SYNC_PACK_ENCODING_JSON_V1,
    ]);
    expect(isSyncPackEncoding(parsed.syncPackEncodings[0])).toBe(true);
  });

  it('accepts root-level pack negotiation for combined push/pull responses', () => {
    const parsed = SyncCombinedRequestSchema.parse({
      clientId: 'client-1',
      syncPackEncodings: [SYNC_PACK_ENCODING_BINARY_V1],
      pull: {
        limitCommits: 50,
        limitSnapshotRows: 1000,
        subscriptions: [],
      },
    });

    expect(parsed.syncPackEncodings).toEqual([SYNC_PACK_ENCODING_BINARY_V1]);
    expect(
      isBinarySyncPackContentType(`${SYNC_PACK_CONTENT_TYPE}; charset=binary`)
    ).toBe(true);
  });
});

describe('binary sync pack format', () => {
  it('round-trips combined push and pull responses without JSON envelope fields', async () => {
    const chunk = {
      id: 'chunk-1',
      byteLength: 128,
      sha256: '0'.repeat(64),
      encoding: SYNC_SNAPSHOT_CHUNK_ENCODING_BINARY_TABLE_V1,
      compression: 'gzip',
    } satisfies SyncSnapshotChunkRef;
    const manifest = await createSnapshotManifest({
      version: 1,
      table: 'tasks',
      asOfCommitSeq: 42,
      scopeDigest: 'c'.repeat(64),
      rowCursor: null,
      rowLimit: 1000,
      nextRowCursor: 'task-1',
      isFirstPage: true,
      isLastPage: true,
      chunks: [chunk],
    });
    const response: SyncCombinedResponse = {
      ok: true,
      requiredSchemaVersion: 2,
      latestSchemaVersion: 3,
      push: {
        ok: true,
        commits: [
          {
            ok: true,
            clientCommitId: 'local-commit-1',
            status: 'applied',
            commitSeq: 41,
            results: [{ opIndex: 0, status: 'applied' }],
          },
          {
            ok: true,
            clientCommitId: 'local-commit-2',
            status: 'rejected',
            results: [
              {
                opIndex: 0,
                status: 'conflict',
                message: 'server row changed',
                code: 'CONFLICT',
                server_version: 7,
                server_row: { id: 'task-2', title: 'Server' },
              },
            ],
          },
        ],
      },
      pull: {
        ok: true,
        subscriptions: [
          {
            id: 'sub-tasks',
            status: 'active',
            scopes: { user_id: 'user-1' },
            bootstrap: false,
            bootstrapState: null,
            nextCursor: 42,
            commits: [
              {
                commitSeq: 42,
                createdAt: '2026-05-17T10:00:00.000Z',
                actorId: 'user-2',
                commitDigest: 'a'.repeat(64),
                commitChainRoot: 'b'.repeat(64),
                changes: [
                  {
                    table: 'tasks',
                    row_id: 'task-1',
                    op: 'upsert',
                    row_json: {
                      id: 'task-1',
                      title: 'Remote',
                      server_version: 42,
                      rank: 1.25,
                      done: false,
                      labels: ['inbox', 'rust'],
                      metadata: {
                        nullable: null,
                        nested: { priority: 3 },
                      },
                    },
                    row_version: 42,
                    scopes: { user_id: 'user-1' },
                  },
                ],
              },
            ],
            snapshots: [
              {
                table: 'tasks',
                rows: [],
                chunks: [chunk],
                manifest,
                isFirstPage: true,
                isLastPage: true,
                bootstrapStateAfter: {
                  asOfCommitSeq: 42,
                  tables: ['tasks'],
                  tableIndex: 0,
                  rowCursor: 'task-1',
                },
              },
            ],
          },
        ],
      },
    };

    const encoded = encodeBinarySyncPack(response);
    expect(encoded[0]).toBe(0x53);
    expect(encoded[4]).toBe(11);
    expect(encoded[5]).toBe(0);

    const decoded = decodeBinarySyncPack(encoded);
    expect(decoded).toEqual(response);
    expect(encoded.length).toBeLessThan(JSON.stringify(response).length);
  });

  it('round-trips generated binary row groups for incremental changes', () => {
    const taskChanges = Array.from({ length: 20 }, (_, index) => ({
      table: 'tasks',
      row_id: `task-${index}`,
      op: 'upsert' as const,
      row_json: {
        id: `task-${index}`,
        title: `Remote ${index}`,
        server_version: index + 1,
        done: index % 2 === 0,
      },
      row_version: index + 1,
      scopes: { user_id: 'user-1' },
    }));
    const response: SyncCombinedResponse = {
      ok: true,
      pull: {
        ok: true,
        subscriptions: [
          {
            id: 'sub-tasks',
            status: 'active',
            scopes: { user_id: 'user-1' },
            bootstrap: false,
            bootstrapState: null,
            nextCursor: 44,
            commits: [
              {
                commitSeq: 44,
                createdAt: '2026-05-17T10:00:00.000Z',
                actorId: 'user-2',
                changes: [
                  ...taskChanges,
                  {
                    table: 'tasks',
                    row_id: 'task-deleted',
                    op: 'delete',
                    row_json: null,
                    row_version: 45,
                    scopes: { user_id: 'user-1' },
                  },
                ],
              },
            ],
          },
        ],
      },
    };

    const encoded = encodeBinarySyncPack(response, {
      changeRowEncoders: {
        tasks: (rows) =>
          encodeBinarySnapshotTable({
            table: 'tasks',
            columns: [
              { name: 'id', type: 'string' },
              { name: 'title', type: 'string' },
              { name: 'server_version', type: 'integer' },
              { name: 'done', type: 'boolean' },
            ],
            rows: rows as Record<string, unknown>[],
          }),
      },
    });

    expect(decodeBinarySyncPack(encoded)).toEqual(response);
    expect(encoded.length).toBeLessThan(encodeBinarySyncPack(response).length);
  });
});
