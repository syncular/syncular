import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import type { SyncCombinedResponse } from '../schemas/sync';
import {
  decodeBinarySnapshotTable,
  encodeBinarySnapshotTable,
  type BinarySnapshotTable,
  type DecodedBinarySnapshotTable,
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

describe('cross-language protocol fixtures', () => {
  it('keeps the binary sync-pack fixture aligned with the TypeScript codec', () => {
    const fixture = readBinarySyncPackFixture();
    const encoded = encodeBinarySyncPack(fixture.decodedResponse);

    expect(fixture.wireVersion).toBe(9);
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
});

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
