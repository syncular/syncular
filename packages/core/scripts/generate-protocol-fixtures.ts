import { mkdirSync, writeFileSync } from 'node:fs';
import {
  decodeBinarySnapshotTable,
  decodeSnapshotRows,
  createSnapshotManifest,
  encodeBinarySnapshotTable,
  encodeSnapshotRows,
  SYNC_SNAPSHOT_CHUNK_ENCODING_BINARY_TABLE_V1,
  SYNC_SNAPSHOT_CHUNK_ENCODING_JSON_ROW_FRAME_V1,
  type BinarySnapshotTable,
} from '../src/snapshot-chunks';
import {
  encodeBinarySyncPack,
  SYNC_PACK_ENCODING_BINARY_V1,
  SYNC_PACK_ENCODING_JSON_V1,
} from '../src/sync-packs';

const fixturesDir = new URL(
  '../../../rust/crates/runtime/tests/fixtures/',
  import.meta.url
);

mkdirSync(fixturesDir, { recursive: true });

writeFixture('json-combined-sync-v1.json', jsonCombinedSyncFixture());
writeFixture(
  'binary-sync-pack-v1-combined-response.json',
  await binarySyncPackFixture()
);
writeFixture('binary-snapshot-table-v1-tasks.json', binarySnapshotFixture());
writeFixture('json-row-frame-v1-tasks.json', jsonRowFrameFixture());

function writeFixture(name: string, value: unknown): void {
  writeFileSync(new URL(name, fixturesDir), `${JSON.stringify(value, null, 2)}\n`);
}

function readU16Le(bytes: Uint8Array, offset: number): number {
  return bytes[offset] | (bytes[offset + 1] << 8);
}

function jsonCombinedSyncFixture() {
  return {
    name: 'json-combined-sync-v1',
    request: {
      clientId: 'fixture-client-1',
      syncPackEncodings: [
        SYNC_PACK_ENCODING_BINARY_V1,
        SYNC_PACK_ENCODING_JSON_V1,
      ],
      push: {
        commits: [
          {
            clientCommitId: 'fixture-commit-1',
            schemaVersion: 3,
            operations: [
              {
                table: 'tasks',
                row_id: 'task-local-1',
                op: 'upsert',
                payload: {
                  id: 'task-local-1',
                  title: 'Local edit',
                  done: false,
                },
                base_version: 5,
              },
              {
                table: 'tasks',
                row_id: 'task-deleted-1',
                op: 'delete',
                payload: null,
                base_version: 6,
              },
            ],
          },
        ],
      },
      pull: {
        limitCommits: 50,
        limitSnapshotRows: 1000,
        maxSnapshotPages: 4,
        dedupeRows: true,
        snapshotEncodings: [
          SYNC_SNAPSHOT_CHUNK_ENCODING_BINARY_TABLE_V1,
          SYNC_SNAPSHOT_CHUNK_ENCODING_JSON_ROW_FRAME_V1,
        ],
        syncPackEncodings: [
          SYNC_PACK_ENCODING_BINARY_V1,
          SYNC_PACK_ENCODING_JSON_V1,
        ],
        subscriptions: [
          {
            id: 'sub-tasks',
            table: 'tasks',
            scopes: {
              user_id: 'user-1',
              project_id: ['p1', 'p2'],
            },
            params: {
              includeDone: true,
            },
            cursor: 41,
            bootstrapState: {
              asOfCommitSeq: 40,
              tables: ['projects', 'tasks'],
              tableIndex: 1,
              rowCursor: 'task-0',
            },
          },
        ],
      },
    },
    response: {
      ok: true,
      requiredSchemaVersion: 3,
      latestSchemaVersion: 4,
      push: {
        ok: true,
        commits: [
          {
            ok: true,
            clientCommitId: 'fixture-commit-1',
            status: 'applied',
            commitSeq: 42,
            results: [
              { opIndex: 0, status: 'applied' },
              { opIndex: 1, status: 'applied' },
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
            scopes: {
              user_id: 'user-1',
              project_id: 'p1',
            },
            bootstrap: true,
            bootstrapState: {
              asOfCommitSeq: 42,
              tables: ['tasks'],
              tableIndex: 0,
              rowCursor: 'task-1',
            },
            nextCursor: 42,
            commits: [
              {
                commitSeq: 42,
                createdAt: '2026-05-19T10:00:00.000Z',
                actorId: 'user-2',
                changes: [
                  {
                    table: 'tasks',
                    row_id: 'task-remote-1',
                    op: 'upsert',
                    row_json: {
                      id: 'task-remote-1',
                      title: 'Remote row',
                      server_version: 42,
                    },
                    row_version: 42,
                    scopes: {
                      user_id: 'user-1',
                      project_id: 'p1',
                    },
                  },
                ],
              },
            ],
            snapshots: [
              {
                table: 'tasks',
                rows: [
                  {
                    id: 'task-snapshot-1',
                    title: 'Snapshot row',
                    server_version: 41,
                  },
                ],
                isFirstPage: true,
                isLastPage: false,
                bootstrapStateAfter: {
                  asOfCommitSeq: 42,
                  tables: ['tasks'],
                  tableIndex: 0,
                  rowCursor: 'task-snapshot-1',
                },
              },
            ],
          },
        ],
      },
    },
  };
}

async function binarySyncPackFixture() {
  const chunk = {
    id: 'chunk-1',
    byteLength: 128,
    sha256: '0'.repeat(64),
    encoding: SYNC_SNAPSHOT_CHUNK_ENCODING_BINARY_TABLE_V1,
    compression: 'gzip' as const,
  };
  const decodedResponse = {
    ok: true,
    requiredSchemaVersion: 2,
    latestSchemaVersion: 3,
    push: {
      ok: true,
      commits: [
        {
          ok: true,
          clientCommitId: 'fixture-local-1',
          status: 'applied',
          commitSeq: 41,
          results: [{ opIndex: 0, status: 'applied' }],
        },
        {
          ok: true,
          clientCommitId: 'fixture-local-2',
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
                    done: false,
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
                manifest: await createSnapshotManifest({
                  version: 1,
                  table: 'tasks',
                  asOfCommitSeq: 42,
                  scopeDigest: 'c'.repeat(64),
                  rowCursor: null,
                  rowLimit: 1000,
                  nextRowCursor: null,
                  isFirstPage: true,
                  isLastPage: true,
                  chunks: [chunk],
                }),
                isFirstPage: true,
                isLastPage: true,
              bootstrapStateAfter: null,
            },
          ],
        },
      ],
    },
  };
  const encoded = encodeBinarySyncPack(decodedResponse);
  return {
    name: 'binary-sync-pack-v1-combined-response',
    generatedBy: 'packages/core/src/sync-packs.ts encodeBinarySyncPack',
    contentType: 'application/vnd.syncular.sync-pack.v1',
    wireVersion: readU16Le(encoded, 4),
    encodedHex: Buffer.from(encoded).toString('hex'),
    decodedResponse,
  };
}

function binarySnapshotFixture() {
  const table: BinarySnapshotTable = {
    table: 'tasks',
    columns: [
      { name: 'id', type: 'string' },
      { name: 'title', type: 'string' },
      { name: 'server_version', type: 'integer' },
      { name: 'score', type: 'float' },
      { name: 'done', type: 'boolean' },
      { name: 'metadata', type: 'json', nullable: true },
    ],
    rows: [
      {
        id: 'task-1',
        title: 'Remote',
        server_version: 42,
        score: 1.5,
        done: false,
        metadata: { priority: 'high', tags: ['rust', 'fixture'] },
      },
      {
        id: 'task-2',
        title: 'Done',
        server_version: 43,
        score: -2.25,
        done: true,
        metadata: null,
      },
    ],
  };
  const encoded = encodeBinarySnapshotTable(table);
  return {
    name: 'binary-snapshot-table-v1-tasks',
    generatedBy: 'packages/core/src/snapshot-chunks.ts encodeBinarySnapshotTable',
    encoding: SYNC_SNAPSHOT_CHUNK_ENCODING_BINARY_TABLE_V1,
    wireVersion: 1,
    encodedHex: Buffer.from(encoded).toString('hex'),
    decodedTable: decodeBinarySnapshotTable(encoded),
  };
}

function jsonRowFrameFixture() {
  const rows = [
    {
      id: 'task-frame-1',
      title: 'Frame one',
      server_version: 51,
      metadata: { source: SYNC_SNAPSHOT_CHUNK_ENCODING_JSON_ROW_FRAME_V1 },
    },
    {
      id: 'task-frame-2',
      title: 'Frame two',
      server_version: 52,
      metadata: null,
    },
  ];
  const encoded = encodeSnapshotRows(rows);
  return {
    name: 'json-row-frame-v1-tasks',
    generatedBy: 'packages/core/src/snapshot-chunks.ts encodeSnapshotRows',
    encoding: SYNC_SNAPSHOT_CHUNK_ENCODING_JSON_ROW_FRAME_V1,
    wireVersion: 1,
    encodedHex: Buffer.from(encoded).toString('hex'),
    decodedRows: decodeSnapshotRows(encoded),
  };
}
