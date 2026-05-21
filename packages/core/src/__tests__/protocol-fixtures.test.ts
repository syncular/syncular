import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import {
  type SyncCombinedRequest,
  SyncCombinedRequestSchema,
  type SyncCombinedResponse,
  SyncCombinedResponseSchema,
} from '../schemas/sync';
import {
  type BinarySnapshotTable,
  type DecodedBinarySnapshotTable,
  decodeBinarySnapshotTable,
  decodeSnapshotRows,
  encodeBinarySnapshotTable,
  encodeSnapshotRows,
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

interface JsonRowFrameFixture {
  name: string;
  generatedBy: string;
  encoding: string;
  wireVersion: number;
  encodedHex: string;
  decodedRows: unknown[];
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

  it('keeps the JSON row-frame fixture aligned with the TypeScript codec', () => {
    const fixture = readJsonRowFrameFixture();
    const encoded = encodeSnapshotRows(fixture.decodedRows);

    expect(fixture.encoding).toBe('json-row-frame-v1');
    expect(fixture.wireVersion).toBe(1);
    expect(Buffer.from(encoded).toString('hex')).toBe(fixture.encodedHex);
    expect(decodeSnapshotRows(encoded)).toEqual(fixture.decodedRows);
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

function readJsonRowFrameFixture(): JsonRowFrameFixture {
  return JSON.parse(
    readFileSync(
      new URL(
        '../../../../rust/crates/runtime/tests/fixtures/json-row-frame-v1-tasks.json',
        import.meta.url
      ),
      'utf8'
    )
  ) as JsonRowFrameFixture;
}

function readU16Le(bytes: Uint8Array, offset: number): number {
  return bytes[offset] | (bytes[offset + 1] << 8);
}
