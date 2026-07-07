import { describe, expect, it } from 'bun:test';
import { PROTOCOL_WIRE_VERSION, SYNC_PACK_MAGIC } from './index';

describe('protocol constants', () => {
  it('declares a positive integer wire version', () => {
    expect(Number.isInteger(PROTOCOL_WIRE_VERSION)).toBe(true);
    expect(PROTOCOL_WIRE_VERSION).toBeGreaterThan(0);
  });

  it('uses a 4-byte ASCII magic that cannot collide with SSP1 bodies', () => {
    expect(SYNC_PACK_MAGIC).toHaveLength(4);
    expect(SYNC_PACK_MAGIC).not.toBe('SSP1');
  });
});
