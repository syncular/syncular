import { describe, expect, it } from 'bun:test';
import {
  isSupportedProtocolWireVersion,
  MINIMUM_PROTOCOL_WIRE_VERSION,
  PROTOCOL_WIRE_VERSION,
  SUPPORTED_PROTOCOL_WIRE_VERSIONS,
  SYNC_PACK_MAGIC,
} from './index';

describe('protocol constants', () => {
  it('declares a positive integer wire version', () => {
    expect(Number.isInteger(PROTOCOL_WIRE_VERSION)).toBe(true);
    expect(PROTOCOL_WIRE_VERSION).toBeGreaterThan(0);
  });

  it('publishes the complete contiguous reference-codec window', () => {
    expect(SUPPORTED_PROTOCOL_WIRE_VERSIONS).toEqual([1, 2]);
    expect(SUPPORTED_PROTOCOL_WIRE_VERSIONS[0]).toBe(
      MINIMUM_PROTOCOL_WIRE_VERSION,
    );
    expect(SUPPORTED_PROTOCOL_WIRE_VERSIONS.at(-1)).toBe(PROTOCOL_WIRE_VERSION);
    expect(isSupportedProtocolWireVersion(1)).toBe(true);
    expect(isSupportedProtocolWireVersion(2)).toBe(true);
    expect(isSupportedProtocolWireVersion(1.5)).toBe(false);
    expect(isSupportedProtocolWireVersion(3)).toBe(false);
  });

  it('uses a 4-byte ASCII magic that cannot collide with SSP1 bodies', () => {
    expect(SYNC_PACK_MAGIC).toHaveLength(4);
    expect(SYNC_PACK_MAGIC).not.toBe('SSP1');
  });
});
