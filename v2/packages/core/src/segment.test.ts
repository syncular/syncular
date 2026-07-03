import { describe, expect, it } from 'bun:test';
import {
  DecodeError,
  decodeRowsSegment,
  encodeRowsSegment,
  type RowColumn,
  type RowsSegment,
} from './index';

const COLUMNS: readonly RowColumn[] = [
  { name: 'id', type: 'string', nullable: false },
  { name: 'count', type: 'integer', nullable: true },
  { name: 'blob', type: 'bytes', nullable: true },
];

const SEGMENT: RowsSegment = {
  table: 'notes',
  schemaVersion: 1,
  columns: COLUMNS,
  blocks: [
    [
      { serverVersion: 3, values: ['a', 1, new Uint8Array([1, 2])] },
      { serverVersion: 1, values: ['b', null, null] },
    ],
    [{ serverVersion: 9007199254740991, values: ['c', -5, new Uint8Array(0)] }],
  ],
};

function expectDecodeError(fn: () => unknown): void {
  let thrown: unknown;
  try {
    fn();
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(DecodeError);
  expect((thrown as DecodeError).code).toBe('sync.invalid_request');
}

describe('SSG2 rows segments (SPEC.md §5.2)', () => {
  it('round-trips a two-block segment byte-exactly', () => {
    const encoded = encodeRowsSegment(SEGMENT);
    const decoded = decodeRowsSegment(encoded);
    expect(decoded).toEqual(SEGMENT);
    expect(encodeRowsSegment(decoded)).toEqual(encoded);
  });

  it('round-trips an empty segment (header + end marker only)', () => {
    const empty: RowsSegment = {
      table: 'notes',
      schemaVersion: 1,
      columns: COLUMNS,
      blocks: [],
    };
    const encoded = encodeRowsSegment(empty);
    expect(decodeRowsSegment(encoded)).toEqual(empty);
  });

  it('rejects a segment without the end marker', () => {
    const encoded = encodeRowsSegment(SEGMENT);
    expectDecodeError(() => decodeRowsSegment(encoded.slice(0, -4)));
  });

  it('rejects trailing bytes after the end marker', () => {
    const encoded = encodeRowsSegment(SEGMENT);
    const padded = new Uint8Array(encoded.length + 1);
    padded.set(encoded);
    expectDecodeError(() => decodeRowsSegment(padded));
  });

  it('rejects an unsupported format version', () => {
    const encoded = encodeRowsSegment(SEGMENT);
    const mutated = encoded.slice();
    new DataView(mutated.buffer).setUint16(4, 2, true);
    expectDecodeError(() => decodeRowsSegment(mutated));
  });

  it('rejects non-zero segment flags', () => {
    const encoded = encodeRowsSegment(SEGMENT);
    const mutated = encoded.slice();
    mutated[6] = 1;
    expectDecodeError(() => decodeRowsSegment(mutated));
  });

  it('rejects reserved column flag bits', () => {
    const encoded = encodeRowsSegment(SEGMENT);
    // Header layout: magic(4) version(2) flags(2) table(4+5) schema(4)
    // colCount(2) then col 0: name(4+2) type(1) flags(1).
    const columnFlagsOffset = 4 + 2 + 2 + 4 + 5 + 4 + 2 + 4 + 2 + 1;
    const mutated = encoded.slice();
    mutated[columnFlagsOffset] = 0b10;
    expectDecodeError(() => decodeRowsSegment(mutated));
  });

  it('rejects a block whose rows do not consume its byteLength', () => {
    const encoded = encodeRowsSegment(SEGMENT);
    // First block starts right after the header/columns; grow its
    // byteLength by 1 so the block reader sees a trailing byte.
    const headerLength =
      4 + 2 + 2 + (4 + 5) + 4 + 2 + (4 + 2 + 2) + (4 + 5 + 2) + (4 + 4 + 2);
    const mutated = encoded.slice();
    const view = new DataView(mutated.buffer);
    const blockByteLength = view.getUint32(headerLength + 4, true);
    // Shrinking by one makes the last row read past the block boundary.
    view.setUint32(headerLength + 4, blockByteLength - 1, true);
    expectDecodeError(() => decodeRowsSegment(mutated));
  });

  it('refuses to encode an empty row block', () => {
    const bad: RowsSegment = {
      table: 'notes',
      schemaVersion: 1,
      columns: COLUMNS,
      blocks: [[]],
    };
    expect(() => encodeRowsSegment(bad)).toThrow('at least one row');
  });

  it('refuses to encode a row serverVersion < 1', () => {
    const bad: RowsSegment = {
      table: 'notes',
      schemaVersion: 1,
      columns: COLUMNS,
      blocks: [[{ serverVersion: 0, values: ['a', null, null] }]],
    };
    expect(() => encodeRowsSegment(bad)).toThrow('serverVersion');
  });

  it('rejects a decoded row serverVersion < 1', () => {
    const encoded = encodeRowsSegment(SEGMENT);
    // The second block is rowCount(4) + byteLength(4) + one row record:
    // serverVersion i64 (8) + bitmap(1) + 'c'(4+1) + i64(8) + bytes(4+0);
    // the end marker (4) follows it.
    const secondBlockStart = encoded.length - 4 - (4 + 4 + 8 + 1 + 5 + 8 + 4);
    const mutated = encoded.slice();
    new DataView(mutated.buffer).setBigInt64(secondBlockStart + 8, 0n, true);
    expectDecodeError(() => decodeRowsSegment(mutated));
  });
});
