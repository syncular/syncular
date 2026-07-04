/**
 * MessageStreamScanner (§1.4, §8.7): chunked reassembly of the
 * self-delimiting envelope grammar — arbitrary chunk boundaries, exact
 * END detection, excess-byte reporting, header validation.
 */
import { describe, expect, test } from 'bun:test';
import { DecodeError } from './errors';
import { encodeMessage } from './message';
import { MessageStreamScanner } from './stream';

const REQUEST = encodeMessage({
  wireVersion: 1,
  msgKind: 'request',
  frames: [
    { type: 'REQ_HEADER', clientId: 'c1', schemaVersion: 1 },
    {
      type: 'PULL_HEADER',
      limitCommits: 0,
      limitSnapshotRows: 0,
      maxSnapshotPages: 0,
      accept: 0b0011,
    },
  ],
});

describe('MessageStreamScanner', () => {
  test('whole message in one chunk completes with zero excess', () => {
    const scanner = new MessageStreamScanner();
    const result = scanner.push(REQUEST);
    expect(result).toBeDefined();
    expect(result?.excess).toBe(0);
    expect([...(result?.message ?? [])]).toEqual([...REQUEST]);
  });

  test('every possible split point reassembles byte-exactly', () => {
    for (let split = 1; split < REQUEST.length; split++) {
      const scanner = new MessageStreamScanner();
      expect(scanner.push(REQUEST.subarray(0, split))).toBeUndefined();
      const result = scanner.push(REQUEST.subarray(split));
      expect(result?.excess).toBe(0);
      expect([...(result?.message ?? [])]).toEqual([...REQUEST]);
    }
  });

  test('one-byte-at-a-time trickle completes', () => {
    const scanner = new MessageStreamScanner();
    let result: ReturnType<typeof scanner.push>;
    for (const byte of REQUEST) {
      result = scanner.push(new Uint8Array([byte]));
    }
    expect(result?.excess).toBe(0);
    expect([...(result?.message ?? [])]).toEqual([...REQUEST]);
  });

  test('bytes past END are reported as excess (§8.7 violation)', () => {
    const scanner = new MessageStreamScanner();
    const withExcess = new Uint8Array(REQUEST.length + 3);
    withExcess.set(REQUEST, 0);
    const result = scanner.push(withExcess);
    expect(result?.excess).toBe(3);
    expect([...(result?.message ?? [])]).toEqual([...REQUEST]);
  });

  test('bad magic is a DecodeError once 8 header bytes arrived', () => {
    const scanner = new MessageStreamScanner();
    const bad = REQUEST.slice();
    bad[0] = 0x58;
    expect(scanner.push(bad.subarray(0, 4))).toBeUndefined();
    expect(() => scanner.push(bad.subarray(4))).toThrow(DecodeError);
  });

  test('non-zero flags and unknown msgKind are DecodeErrors', () => {
    for (const [index, value] of [
      [6, 0x03],
      [7, 0x01],
    ] as const) {
      const scanner = new MessageStreamScanner();
      const bad = REQUEST.slice();
      bad[index] = value;
      expect(() => scanner.push(bad)).toThrow(DecodeError);
    }
  });

  test('push after completion throws', () => {
    const scanner = new MessageStreamScanner();
    scanner.push(REQUEST);
    expect(() => scanner.push(new Uint8Array([0]))).toThrow('already complete');
  });
});
