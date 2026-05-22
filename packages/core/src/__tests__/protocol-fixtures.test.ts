import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import {
  BlobRefSchema,
  BlobUploadCompleteResponseSchema,
  BlobUploadInitRequestSchema,
  BlobUploadInitResponseSchema,
} from '../schemas/blobs';
import {
  SyncAuthLeaseIssueRequestSchema,
  SyncAuthLeaseIssueResponseSchema,
  SyncAuthLeaseProvenanceSchema,
  type SyncCombinedRequest,
  SyncCombinedRequestSchema,
  type SyncCombinedResponse,
  SyncCombinedResponseSchema,
  SyncSnapshotArtifactRefSchema,
  SyncSnapshotChunkRefSchema,
} from '../schemas/sync';
import {
  type BinarySnapshotTable,
  type DecodedBinarySnapshotTable,
  decodeBinarySnapshotTable,
  encodeBinarySnapshotTable,
} from '../snapshot-chunks';
import { decodeBinarySyncPack, encodeBinarySyncPack } from '../sync-packs';

interface BinarySyncPackFixture {
  name: string;
  generatedBy: string;
  contentType: string;
  wireVersion: number;
  encodedHex: string;
  decodedResponse: SyncCombinedResponse;
}

interface BinarySnapshotTableFixture {
  name: string;
  generatedBy: string;
  encoding: string;
  wireVersion: number;
  encodedHex: string;
  decodedTable: DecodedBinarySnapshotTable;
}

interface JsonCombinedSyncFixture {
  name: string;
  request: SyncCombinedRequest;
  response: SyncCombinedResponse;
}

interface RelayProtocolBoundaryFixture {
  name: string;
  generatedBy: string;
  combined: {
    request: SyncCombinedRequest;
    response: SyncCombinedResponse;
  };
  snapshotChunk: {
    ref: unknown;
    encodedHex: string;
  };
  scopedSnapshotArtifact: {
    ref: unknown;
    encodedHex: string;
  };
  blob: {
    ref: unknown;
    bytesHex: string;
    uploadInitRequest: unknown;
    uploadInitResponse: unknown;
    uploadCompleteResponse: unknown;
  };
  authLease: {
    provenance: unknown;
    issueRequest: unknown;
    issueResponse: unknown;
  };
  binarySyncPack: BinarySyncPackFixture;
  realtime: {
    pushRequest: unknown;
    presenceRequest: unknown;
    serverSyncMessage: unknown;
    serverPresenceMessage: unknown;
    serverPushResponseMessage: unknown;
    binarySyncPackHex: string;
  };
}

interface RustRelayProtocolCanonicalFixture {
  name: string;
  generatedBy: string;
  combinedRequest: SyncCombinedRequest;
  realtimePushRequest: unknown;
  realtimePresenceRequest: unknown;
  blobRef: unknown;
}

describe('cross-language protocol fixtures', () => {
  it('keeps the JSON combined sync fixture aligned with the TypeScript schemas', () => {
    const fixture = readJsonCombinedSyncFixture();

    expect(fixture.name).toBe('json-combined-sync-v1');
    expect(SyncCombinedRequestSchema.parse(fixture.request)).toEqual(
      fixture.request
    );
    expect(SyncCombinedResponseSchema.parse(fixture.response)).toEqual(
      fixture.response
    );
  });

  it('keeps the binary sync-pack fixture aligned with the TypeScript codec', () => {
    const fixture = readBinarySyncPackFixture();
    const encoded = encodeBinarySyncPack(fixture.decodedResponse);

    expect(fixture.wireVersion).toBe(readU16Le(encoded, 4));
    expect(Buffer.from(encoded).toString('hex')).toBe(fixture.encodedHex);
    expect(decodeBinarySyncPack(encoded)).toEqual(fixture.decodedResponse);
  });

  it('keeps the binary snapshot table fixture aligned with the TypeScript codec', () => {
    const fixture = readBinarySnapshotTableFixture();
    const encoded = encodeBinarySnapshotTable(
      fixture.decodedTable as BinarySnapshotTable
    );

    expect(fixture.encoding).toBe('binary-table-v1');
    expect(fixture.wireVersion).toBe(1);
    expect(Buffer.from(encoded).toString('hex')).toBe(fixture.encodedHex);
    expect(decodeBinarySnapshotTable(encoded)).toEqual(fixture.decodedTable);
  });

  it('keeps the relay protocol boundary fixture aligned with TypeScript schemas', () => {
    const fixture = readRelayProtocolBoundaryFixture();

    expect(fixture.name).toBe('relay-protocol-boundary-v1');
    expect(SyncCombinedRequestSchema.parse(fixture.combined.request)).toEqual(
      fixture.combined.request
    );
    expect(SyncCombinedResponseSchema.parse(fixture.combined.response)).toEqual(
      fixture.combined.response
    );
    expect(SyncSnapshotChunkRefSchema.parse(fixture.snapshotChunk.ref)).toEqual(
      fixture.snapshotChunk.ref
    );
    expect(
      SyncSnapshotArtifactRefSchema.parse(fixture.scopedSnapshotArtifact.ref)
    ).toEqual(fixture.scopedSnapshotArtifact.ref);
    expect(BlobRefSchema.parse(fixture.blob.ref)).toEqual(fixture.blob.ref);
    expect(
      BlobUploadInitRequestSchema.parse(fixture.blob.uploadInitRequest)
    ).toEqual(fixture.blob.uploadInitRequest);
    expect(
      BlobUploadInitResponseSchema.parse(fixture.blob.uploadInitResponse)
    ).toEqual(fixture.blob.uploadInitResponse);
    expect(
      BlobUploadCompleteResponseSchema.parse(
        fixture.blob.uploadCompleteResponse
      )
    ).toEqual(fixture.blob.uploadCompleteResponse);
    expect(
      SyncAuthLeaseProvenanceSchema.parse(fixture.authLease.provenance)
    ).toEqual(fixture.authLease.provenance);
    expect(
      SyncAuthLeaseIssueRequestSchema.parse(fixture.authLease.issueRequest)
    ).toEqual(fixture.authLease.issueRequest);
    expect(
      SyncAuthLeaseIssueResponseSchema.parse(fixture.authLease.issueResponse)
    ).toEqual(fixture.authLease.issueResponse);

    const encoded = encodeBinarySyncPack(
      fixture.binarySyncPack.decodedResponse
    );
    expect(fixture.binarySyncPack.wireVersion).toBe(readU16Le(encoded, 4));
    expect(Buffer.from(encoded).toString('hex')).toBe(
      fixture.binarySyncPack.encodedHex
    );
    expect(decodeBinarySyncPack(encoded)).toEqual(
      fixture.binarySyncPack.decodedResponse
    );
    expect(fixture.realtime.binarySyncPackHex).toBe(
      fixture.binarySyncPack.encodedHex
    );
  });

  it('keeps the Rust relay canonical fixture aligned with TypeScript schemas', () => {
    const fixture = readRustRelayProtocolCanonicalFixture();

    expect(fixture.name).toBe('rust-relay-protocol-canonical-v1');
    expect(SyncCombinedRequestSchema.parse(fixture.combinedRequest)).toEqual(
      fixture.combinedRequest
    );
    expect(BlobRefSchema.parse(fixture.blobRef)).toEqual(fixture.blobRef);
  });
});

function readJsonCombinedSyncFixture(): JsonCombinedSyncFixture {
  return JSON.parse(
    readFileSync(
      new URL(
        '../../../../rust/crates/runtime/tests/fixtures/json-combined-sync-v1.json',
        import.meta.url
      ),
      'utf8'
    )
  ) as JsonCombinedSyncFixture;
}

function readBinarySyncPackFixture(): BinarySyncPackFixture {
  return JSON.parse(
    readFileSync(
      new URL(
        '../../../../rust/crates/runtime/tests/fixtures/binary-sync-pack-v1-combined-response.json',
        import.meta.url
      ),
      'utf8'
    )
  ) as BinarySyncPackFixture;
}

function readBinarySnapshotTableFixture(): BinarySnapshotTableFixture {
  return JSON.parse(
    readFileSync(
      new URL(
        '../../../../rust/crates/runtime/tests/fixtures/binary-snapshot-table-v1-tasks.json',
        import.meta.url
      ),
      'utf8'
    )
  ) as BinarySnapshotTableFixture;
}

function readRelayProtocolBoundaryFixture(): RelayProtocolBoundaryFixture {
  return JSON.parse(
    readFileSync(
      new URL(
        '../../../../rust/crates/runtime/tests/fixtures/relay-protocol-boundary-v1.json',
        import.meta.url
      ),
      'utf8'
    )
  ) as RelayProtocolBoundaryFixture;
}

function readRustRelayProtocolCanonicalFixture(): RustRelayProtocolCanonicalFixture {
  return JSON.parse(
    readFileSync(
      new URL(
        '../../../../rust/crates/runtime/tests/fixtures/rust-relay-protocol-canonical-v1.json',
        import.meta.url
      ),
      'utf8'
    )
  ) as RustRelayProtocolCanonicalFixture;
}

function readU16Le(bytes: Uint8Array, offset: number): number {
  return bytes[offset] | (bytes[offset + 1] << 8);
}
