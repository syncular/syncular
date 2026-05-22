import { mkdirSync, writeFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { SYNCULAR_ERROR_DEFINITIONS } from '../src/error-responses';
import {
  type BinarySnapshotTable,
  createScopedSnapshotArtifactManifest,
  createSnapshotManifest,
  decodeBinarySnapshotTable,
  decodeSnapshotRows,
  encodeBinarySnapshotTable,
  encodeSnapshotRows,
  SYNC_SCOPED_SNAPSHOT_ARTIFACT_KIND_SQLITE_V1,
  SYNC_SNAPSHOT_ARTIFACT_COMPRESSION_NONE,
  SYNC_SNAPSHOT_CHUNK_COMPRESSION,
  SYNC_SNAPSHOT_CHUNK_ENCODING_BINARY_TABLE_V1,
  SYNC_SNAPSHOT_CHUNK_ENCODING_JSON_ROW_FRAME_V1,
} from '../src/snapshot-chunks';
import {
  encodeBinarySyncPack,
  SYNC_PACK_ENCODING_BINARY_V1,
} from '../src/sync-packs';
import { sha256Hex } from '../src/utils/crypto';

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
writeFixture('error-taxonomy-v1.json', errorTaxonomyFixture());
writeFixture('json-row-frame-v1-tasks.json', jsonRowFrameFixture());
writeFixture(
  'relay-protocol-boundary-v1.json',
  await relayProtocolBoundaryFixture()
);

function writeFixture(name: string, value: unknown): void {
  writeFileSync(
    new URL(name, fixturesDir),
    `${JSON.stringify(value, null, 2)}\n`
  );
}

function errorTaxonomyFixture() {
  return {
    version: 1,
    definitions: SYNCULAR_ERROR_DEFINITIONS,
  };
}

function readU16Le(bytes: Uint8Array, offset: number): number {
  return bytes[offset] | (bytes[offset + 1] << 8);
}

function jsonCombinedSyncFixture() {
  return {
    name: 'json-combined-sync-v1',
    request: {
      clientId: 'fixture-client-1',
      syncPackEncodings: [SYNC_PACK_ENCODING_BINARY_V1],
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
        syncPackEncodings: [SYNC_PACK_ENCODING_BINARY_V1],
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
            crdtStateVectors: [
              {
                rowId: 'task-local-1',
                field: 'title',
                stateColumn: 'title_yjs_state',
                stateVectorBase64: 'AQID',
                syncMode: 'server-merge',
                updatedAt: 1770000000000,
              },
            ],
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
              code: 'sync.version_conflict',
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
          integrity: {
            partitionId: 'default',
            previousChainRoot: '0'.repeat(64),
            commitChainRoot: 'b'.repeat(64),
            commitSeq: 42,
          },
          commits: [
            {
              commitSeq: 42,
              createdAt: '2026-05-17T10:00:00.000Z',
              actorId: 'user-2',
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
    generatedBy:
      'packages/core/src/snapshot-chunks.ts encodeBinarySnapshotTable',
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

async function relayProtocolBoundaryFixture() {
  const actorId = 'relay-actor-1';
  const clientId = 'relay-client-1';
  const subscriptionId = 'relay-sub-tasks';
  const partitionId = 'relay-partition';
  const blobBytes = new TextEncoder().encode('relay blob body');
  const blobHash = `sha256:${await sha256Hex(blobBytes)}`;
  const blobRef = {
    hash: blobHash,
    size: blobBytes.byteLength,
    mimeType: 'text/plain',
    encrypted: true,
    keyId: 'relay-key-1',
  };
  const authLease = {
    leaseId: 'lease-relay-1',
    leaseExpiresAtMs: 1_779_446_400_000,
    leaseStatusAtEnqueue: 'active',
    leaseScopeSummaryJson: JSON.stringify({
      subscriptionId,
      table: 'tasks',
      project_id: 'relay-project',
    }),
    leaseToken: 'relay.lease.token',
  };
  const chunkRows = [
    {
      id: 'relay-snapshot-1',
      title: 'Relay snapshot one',
      attachment: blobRef,
      server_version: 51,
    },
  ];
  const chunkBody = gzipSync(encodeSnapshotRows(chunkRows));
  const chunk = {
    id: 'relay-chunk-1',
    byteLength: chunkBody.byteLength,
    sha256: await sha256Hex(chunkBody),
    encoding: SYNC_SNAPSHOT_CHUNK_ENCODING_JSON_ROW_FRAME_V1,
    compression: SYNC_SNAPSHOT_CHUNK_COMPRESSION,
  };
  const manifest = await createSnapshotManifest({
    version: 1,
    table: 'tasks',
    asOfCommitSeq: 52,
    scopeDigest: 'a'.repeat(64),
    rowCursor: null,
    rowLimit: 1000,
    nextRowCursor: null,
    isFirstPage: true,
    isLastPage: true,
    chunks: [chunk],
  });
  const artifactBytes = gzipSync(
    new TextEncoder().encode('relay scoped sqlite artifact bytes')
  );
  const artifactManifest = await createScopedSnapshotArtifactManifest({
    version: 1,
    artifactKind: SYNC_SCOPED_SNAPSHOT_ARTIFACT_KIND_SQLITE_V1,
    partitionId,
    subscriptionId,
    table: 'tasks',
    schemaVersion: '7',
    asOfCommitSeq: 52,
    scopeDigest: 'a'.repeat(64),
    rowCursor: null,
    rowLimit: 40000,
    rowCount: 1,
    nextRowCursor: null,
    isFirstPage: true,
    isLastPage: true,
    compression: SYNC_SNAPSHOT_ARTIFACT_COMPRESSION_NONE,
    byteLength: artifactBytes.byteLength,
    sha256: await sha256Hex(artifactBytes),
    featureSet: ['blobs', 'field-e2ee'],
  });
  const artifact = {
    id: 'relay-artifact-1',
    byteLength: artifactManifest.byteLength,
    sha256: artifactManifest.sha256,
    manifestDigest: artifactManifest.digest,
    artifactKind: artifactManifest.artifactKind,
    compression: artifactManifest.compression,
    rowCount: artifactManifest.rowCount,
    nextRowCursor: artifactManifest.nextRowCursor,
    isFirstPage: artifactManifest.isFirstPage,
    isLastPage: artifactManifest.isLastPage,
    manifest: artifactManifest,
  };
  const combined = {
    request: {
      clientId,
      syncPackEncodings: [SYNC_PACK_ENCODING_BINARY_V1],
      push: {
        commits: [
          {
            clientCommitId: 'relay-local-commit-1',
            schemaVersion: 7,
            authLease,
            operations: [
              {
                table: 'tasks',
                row_id: 'relay-task-1',
                op: 'upsert',
                payload: {
                  id: 'relay-task-1',
                  title: 'Relay local edit',
                  attachment: blobRef,
                },
                base_version: 50,
              },
            ],
          },
        ],
      },
      pull: {
        limitCommits: 100,
        limitSnapshotRows: 2000,
        maxSnapshotPages: 2,
        dedupeRows: true,
        snapshotEncodings: [
          SYNC_SNAPSHOT_CHUNK_ENCODING_BINARY_TABLE_V1,
          SYNC_SNAPSHOT_CHUNK_ENCODING_JSON_ROW_FRAME_V1,
        ],
        snapshotArtifacts: {
          schemaVersion: '7',
          artifactKinds: [SYNC_SCOPED_SNAPSHOT_ARTIFACT_KIND_SQLITE_V1],
          compressions: [
            SYNC_SNAPSHOT_ARTIFACT_COMPRESSION_NONE,
            SYNC_SNAPSHOT_CHUNK_COMPRESSION,
          ],
          featureSet: ['blobs', 'field-e2ee'],
        },
        syncPackEncodings: [SYNC_PACK_ENCODING_BINARY_V1],
        subscriptions: [
          {
            id: subscriptionId,
            table: 'tasks',
            scopes: {
              project_id: 'relay-project',
              actor_id: [actorId],
            },
            params: {
              relayId: 'relay-1',
            },
            cursor: 50,
            verifiedRoot: '0'.repeat(64),
            crdtStateVectors: [],
          },
        ],
      },
    },
    response: {
      ok: true,
      requiredSchemaVersion: 7,
      latestSchemaVersion: 7,
      push: {
        ok: true,
        commits: [
          {
            ok: true,
            clientCommitId: 'relay-local-commit-1',
            status: 'applied',
            commitSeq: 51,
            results: [{ opIndex: 0, status: 'applied' }],
          },
        ],
      },
      pull: {
        ok: true,
        subscriptions: [
          {
            id: subscriptionId,
            status: 'active',
            scopes: {
              project_id: 'relay-project',
            },
            bootstrap: true,
            bootstrapState: null,
            nextCursor: 52,
            integrity: {
              partitionId,
              previousChainRoot: '0'.repeat(64),
              commitChainRoot: 'b'.repeat(64),
              commitSeq: 52,
            },
            commits: [
              {
                commitSeq: 52,
                createdAt: '2026-05-20T10:00:00.000Z',
                actorId: 'relay-upstream-actor',
                changes: [
                  {
                    table: 'tasks',
                    row_id: 'relay-task-2',
                    op: 'upsert',
                    row_json: {
                      id: 'relay-task-2',
                      title: 'Relay upstream edit',
                      attachment: blobRef,
                      server_version: 52,
                    },
                    row_version: 52,
                    scopes: {
                      project_id: 'relay-project',
                    },
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
                  asOfCommitSeq: 52,
                  tables: ['tasks'],
                  tableIndex: 0,
                  rowCursor: null,
                },
              },
              {
                table: 'tasks',
                rows: [],
                artifacts: [artifact],
                isFirstPage: true,
                isLastPage: true,
                bootstrapStateAfter: null,
              },
            ],
          },
        ],
      },
    },
  };
  const encoded = encodeBinarySyncPack(combined.response);
  return {
    name: 'relay-protocol-boundary-v1',
    generatedBy: 'packages/core/scripts/generate-protocol-fixtures.ts',
    combined,
    snapshotChunk: {
      ref: chunk,
      encodedHex: Buffer.from(chunkBody).toString('hex'),
    },
    scopedSnapshotArtifact: {
      ref: artifact,
      encodedHex: Buffer.from(artifactBytes).toString('hex'),
    },
    blob: {
      ref: blobRef,
      bytesHex: Buffer.from(blobBytes).toString('hex'),
      uploadInitRequest: {
        hash: blobRef.hash,
        size: blobRef.size,
        mimeType: blobRef.mimeType,
      },
      uploadInitResponse: {
        exists: false,
        uploadId: 'relay-upload-1',
        uploadUrl: 'https://relay.example.invalid/blob/relay-upload-1',
        uploadMethod: 'PUT',
        uploadHeaders: {
          'content-type': blobRef.mimeType,
        },
      },
      uploadCompleteResponse: {
        ok: true,
      },
    },
    authLease: {
      provenance: authLease,
      issueRequest: {
        schemaVersion: 7,
        ttlMs: 300000,
        scopes: [
          {
            subscriptionId,
            table: 'tasks',
            values: {
              project_id: 'relay-project',
            },
            operations: ['upsert', 'delete'],
          },
        ],
      },
      issueResponse: {
        ok: true,
        token: 'relay.lease.token',
        protectedHeader: {
          alg: 'ES256',
          kid: 'relay-key-1',
          typ: 'syncular-auth-lease+jws',
        },
        payload: {
          version: 1,
          leaseId: authLease.leaseId,
          issuer: 'syncular-relay-fixture',
          audience: 'syncular-main',
          actorId,
          subject: {
            relayId: 'relay-1',
          },
          schemaVersion: 7,
          protocolVersion: 1,
          issuedAtMs: 1_779_446_100_000,
          notBeforeMs: 1_779_446_100_000,
          expiresAtMs: authLease.leaseExpiresAtMs,
          maxClockSkewMs: 30000,
          scopes: [
            {
              subscriptionId,
              table: 'tasks',
              values: {
                project_id: 'relay-project',
              },
              operations: ['upsert', 'delete'],
            },
          ],
          capabilities: {
            allowBlobs: true,
            allowCrdt: false,
            allowEncryptedFields: true,
          },
        },
      },
    },
    binarySyncPack: {
      contentType: 'application/vnd.syncular.sync-pack.v1',
      wireVersion: readU16Le(encoded, 4),
      encodedHex: Buffer.from(encoded).toString('hex'),
      decodedResponse: combined.response,
    },
    realtime: {
      pushRequest: {
        type: 'push',
        requestId: 'relay-ws-request-1',
        clientCommitId: 'relay-local-commit-1',
        operations: combined.request.push.commits[0].operations,
        schemaVersion: 7,
        authLease,
      },
      presenceRequest: {
        type: 'presence',
        action: 'join',
        scopeKey: 'project:relay-project',
        metadata: {
          relayId: 'relay-1',
        },
      },
      serverSyncMessage: {
        event: 'sync',
        data: {
          cursor: 52,
          requiresPull: false,
          droppedCount: 0,
          reason: 'push',
          syncPackEncoding: SYNC_PACK_ENCODING_BINARY_V1,
          transportPath: 'relay',
        },
      },
      serverPresenceMessage: {
        event: 'presence',
        data: {
          presence: {
            action: 'snapshot',
            scopeKey: 'project:relay-project',
            entries: [
              {
                clientId,
                actorId,
                joinedAt: 1_779_446_100_000,
                metadata: {
                  relayId: 'relay-1',
                },
              },
            ],
          },
          timestamp: 1_779_446_101_000,
        },
      },
      serverPushResponseMessage: {
        event: 'push-response',
        data: {
          requestId: 'relay-ws-request-1',
          ok: true,
          status: 'applied',
          commitSeq: 51,
          results: [{ opIndex: 0, status: 'applied' }],
          timestamp: 1_779_446_102_000,
        },
      },
      binarySyncPackHex: Buffer.from(encoded).toString('hex'),
    },
  };
}
