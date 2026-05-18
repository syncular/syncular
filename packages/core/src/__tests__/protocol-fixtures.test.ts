import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import type { SyncCombinedResponse } from '../schemas/sync';
import { decodeBinarySyncPack, encodeBinarySyncPack } from '../sync-packs';

interface BinarySyncPackFixture {
  name: string;
  generatedBy: string;
  contentType: string;
  wireVersion: number;
  encodedHex: string;
  decodedResponse: SyncCombinedResponse;
}

describe('cross-language protocol fixtures', () => {
  it('keeps the binary sync-pack fixture aligned with the TypeScript codec', () => {
    const fixture = readBinarySyncPackFixture();
    const encoded = encodeBinarySyncPack(fixture.decodedResponse);

    expect(fixture.wireVersion).toBe(9);
    expect(Buffer.from(encoded).toString('hex')).toBe(fixture.encodedHex);
    expect(decodeBinarySyncPack(encoded)).toEqual(fixture.decodedResponse);
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
