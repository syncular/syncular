import { describe, expect, it } from 'bun:test';
import {
  ByteWriter,
  DecodeError,
  decodeRow,
  decodeSparseRow,
  encodeRow,
  encodeSparseRow,
  type RowColumn,
  type RowValue,
  type SparseRowValue,
} from './index';

/** RFC §6.1 fixture: every §2.4 column type across 9 columns, so both
 * bitmaps carry padding bits. */
const SPARSE_COLUMNS: readonly RowColumn[] = [
  { name: 'id', type: 'string', nullable: false },
  { name: 'title', type: 'string', nullable: true },
  { name: 'body', type: 'string', nullable: false },
  { name: 'count', type: 'integer', nullable: true },
  { name: 'score', type: 'float', nullable: false },
  { name: 'done', type: 'boolean', nullable: false },
  { name: 'meta', type: 'json', nullable: true },
  { name: 'blob', type: 'bytes', nullable: true },
  { name: 'doc', type: 'crdt', nullable: true, crdtType: 'yjs-doc' },
];

const SPARSE_PARTIAL: SparseRowValue[] = [
  'n-1',
  null,
  undefined,
  undefined,
  undefined,
  undefined,
  '{"tags": ["a"]}',
  undefined,
  undefined,
];

const SPARSE_FULL: SparseRowValue[] = [
  'n-2',
  null,
  'body',
  -7,
  0.125,
  false,
  '{"k":true}',
  new Uint8Array([0, 1, 254, 255]),
  new Uint8Array([0x01, 0x02, 0xfe]),
];

const COLUMNS: readonly RowColumn[] = [
  { name: 'id', type: 'string', nullable: false },
  { name: 'title', type: 'string', nullable: true },
  { name: 'count', type: 'integer', nullable: true },
  { name: 'score', type: 'float', nullable: false },
  { name: 'done', type: 'boolean', nullable: false },
  { name: 'meta', type: 'json', nullable: true },
  { name: 'blob', type: 'bytes', nullable: true },
];

function roundTrip(values: readonly RowValue[]): RowValue[] {
  return decodeRow(COLUMNS, encodeRow(COLUMNS, values));
}

describe('row codec (SPEC.md §2.4)', () => {
  it('round-trips a row with NULLs via the null bitmap', () => {
    const values: RowValue[] = ['r-1', null, null, 1.5, true, null, null];
    expect(roundTrip(values)).toEqual(values);
  });

  it('distinguishes empty string from NULL', () => {
    const empty: RowValue[] = ['r-1', '', 0, 0, false, '""', new Uint8Array(0)];
    const nulls: RowValue[] = ['r-1', null, null, 0, false, null, null];
    expect(roundTrip(empty)).toEqual(empty);
    expect(roundTrip(nulls)).toEqual(nulls);
    expect(encodeRow(COLUMNS, empty)).not.toEqual(encodeRow(COLUMNS, nulls));
  });

  it('round-trips non-BMP strings byte-exactly', () => {
    const values: RowValue[] = [
      '📝\u{1D11E}',
      '𝔘𝔫𝔦𝔠𝔬𝔡𝔢 déjà',
      null,
      0,
      false,
      null,
      null,
    ];
    const encoded = encodeRow(COLUMNS, values);
    expect(decodeRow(COLUMNS, encoded)).toEqual(values);
    expect(encodeRow(COLUMNS, decodeRow(COLUMNS, encoded))).toEqual(encoded);
  });

  it('preserves json-typed column raw strings verbatim (no re-canonicalization)', () => {
    const rawJson = '{"b": 1,  "a": [true, null],   "s": "x"}';
    const values: RowValue[] = ['r-1', null, null, 0, false, rawJson, null];
    const decoded = roundTrip(values);
    expect(decoded[5]).toBe(rawJson);
  });

  it('rejects a null bit on a non-nullable column with sync.invalid_request', () => {
    // Column 0 (id) is non-nullable; craft the bitmap manually.
    const w = new ByteWriter();
    w.u8(0b0110_0111); // id NULL (bit 0) + all nullable columns NULL
    w.f64(1.5);
    w.bool(true);
    const bytes = w.finish();
    let thrown: unknown;
    try {
      decodeRow(COLUMNS, bytes);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(DecodeError);
    expect((thrown as DecodeError).code).toBe('sync.invalid_request');
  });

  it('refuses to encode NULL into a non-nullable column', () => {
    const values: RowValue[] = [null, null, null, 0, false, null, null];
    expect(() => encodeRow(COLUMNS, values)).toThrow('not nullable');
  });

  it('rejects non-zero padding bits in the null bitmap', () => {
    const w = new ByteWriter();
    w.u8(0b1000_0000); // bit 7 is padding for a 7-column schema
    w.str('r-1');
    w.str('t');
    w.i64(1);
    w.f64(0);
    w.bool(false);
    w.str('{}');
    w.bytes(new Uint8Array(0));
    expect(() => decodeRow(COLUMNS, w.finish())).toThrow(DecodeError);
  });

  it('rejects trailing bytes after the row payload', () => {
    const values: RowValue[] = ['r-1', null, null, 0, false, null, null];
    const encoded = encodeRow(COLUMNS, values);
    const padded = new Uint8Array(encoded.length + 1);
    padded.set(encoded);
    expect(() => decodeRow(COLUMNS, padded)).toThrow(DecodeError);
  });

  it('rejects integer values outside the i64 safe-integer contract', () => {
    const columns: readonly RowColumn[] = [
      { name: 'n', type: 'integer', nullable: false },
    ];
    const w = new ByteWriter();
    w.u8(0);
    const big = new Uint8Array(8);
    new DataView(big.buffer).setBigInt64(0, 1n << 60n, true);
    w.raw(big);
    expect(() => decodeRow(columns, w.finish())).toThrow(DecodeError);
    expect(() => encodeRow(columns, [2 ** 60])).toThrow('safe integer');
  });

  it('uses LSB-first bit order within bitmap bytes', () => {
    // Only column 1 (title) NULL => bitmap byte must be 0b0000_0010.
    const values: RowValue[] = [
      'r',
      null,
      2,
      0,
      false,
      '{}',
      new Uint8Array(0),
    ];
    const encoded = encodeRow(COLUMNS, values);
    expect(encoded[0]).toBe(0b0000_0010);
  });

  it('round-trips i64 boundary integers', () => {
    const values: RowValue[] = [
      'r',
      null,
      9007199254740991,
      0,
      false,
      null,
      null,
    ];
    expect(roundTrip(values)).toEqual(values);
    const negative: RowValue[] = [
      'r',
      null,
      -9007199254740991,
      0,
      false,
      null,
      null,
    ];
    expect(roundTrip(negative)).toEqual(negative);
  });

  it('encodes a crdt column (tag 8) byte-identically to a bytes column', () => {
    // §2.4 tag 8, §5.10: a `crdt` value rides the `bytes` machinery. Its
    // wire bytes are identical to a `bytes` column holding the same value —
    // the tag differs only in the SSG2 column table, not the row payload.
    const crdtCols: readonly RowColumn[] = [
      { name: 'id', type: 'string', nullable: false },
      { name: 'doc', type: 'crdt', nullable: true, crdtType: 'yjs-doc' },
    ];
    const bytesCols: readonly RowColumn[] = [
      { name: 'id', type: 'string', nullable: false },
      { name: 'doc', type: 'bytes', nullable: true },
    ];
    const update = new Uint8Array([1, 2, 3, 250, 0, 255]);
    const crdtValues: RowValue[] = ['r-1', update];
    expect(encodeRow(crdtCols, crdtValues)).toEqual(
      encodeRow(bytesCols, crdtValues),
    );
    expect(decodeRow(crdtCols, encodeRow(crdtCols, crdtValues))).toEqual(
      crdtValues,
    );
    // NULL crdt and empty (non-NULL) crdt both round-trip.
    expect(decodeRow(crdtCols, encodeRow(crdtCols, ['r-1', null]))).toEqual([
      'r-1',
      null,
    ]);
    const empty: RowValue[] = ['r-1', new Uint8Array(0)];
    expect(decodeRow(crdtCols, encodeRow(crdtCols, empty))).toEqual(empty);
  });
});

describe('sparse row codec (RFC §6.1)', () => {
  it('round-trips a partial row and leaves absent columns out of the bytes', () => {
    const encoded = encodeSparseRow(SPARSE_COLUMNS, 0, SPARSE_PARTIAL);
    expect(encoded[0]).toBe(0b0100_0011); // columns 0, 1, 6 present
    expect(encoded[1]).toBe(0x00); // presence padding bits zero
    expect(encoded[2]).toBe(0b0000_0010); // present index 1 (title) is NULL
    expect(decodeSparseRow(SPARSE_COLUMNS, 0, encoded)).toEqual(SPARSE_PARTIAL);
  });

  it('encodes a full row through the presence bitmap, not the full-row codec', () => {
    const encoded = encodeSparseRow(SPARSE_COLUMNS, 0, SPARSE_FULL);
    expect(encoded.slice(0, 2)).toEqual(new Uint8Array([0xff, 0x01]));
    expect(decodeSparseRow(SPARSE_COLUMNS, 0, encoded)).toEqual(SPARSE_FULL);
    // The full-row codec has no presence bitmap: same values, other bytes.
    expect(encoded).not.toEqual(
      encodeRow(
        SPARSE_COLUMNS,
        SPARSE_FULL.map((value) => value ?? null),
      ),
    );
  });

  it('keeps bitmap padding bits zero at every column-count boundary', () => {
    for (const count of [1, 7, 8, 9]) {
      const columns: readonly RowColumn[] = Array.from(
        { length: count },
        (_, i) => ({ name: `c${i}`, type: 'string' as const, nullable: true }),
      );
      const values: SparseRowValue[] = Array.from({ length: count }, (_, i) =>
        i > 0 && i % 3 === 0 ? undefined : i === 1 ? null : `v${i}`,
      );
      const encoded = encodeSparseRow(columns, 0, values);
      const padStart = count % 8;
      if (padStart !== 0) {
        const last = encoded[Math.ceil(count / 8) - 1] ?? 0;
        for (let bit = padStart; bit < 8; bit++) {
          expect((last >> bit) & 1).toBe(0);
        }
      }
      const decoded = decodeSparseRow(columns, 0, encoded);
      expect(decoded).toEqual(values);
      expect(encodeSparseRow(columns, 0, decoded)).toEqual(encoded);
    }
  });

  it('rejects a set presence padding bit', () => {
    // Column 9 does not exist: bit 9 of the presence bitmap is padding.
    const bytes = new Uint8Array([0b0000_0001, 0b0000_0010]);
    expect(() => decodeSparseRow(SPARSE_COLUMNS, 0, bytes)).toThrow(
      'presence bitmap has a set padding bit',
    );
  });

  it('rejects a null bit for an absent column', () => {
    // Only column 0 is present, so null bitmap bit 3 is padding.
    const bytes = new Uint8Array([0b0000_0001, 0x00, 0b0000_1000]);
    expect(() => decodeSparseRow(SPARSE_COLUMNS, 0, bytes)).toThrow(
      'null bit for an absent column',
    );
  });

  it('rejects a null bit for a non-nullable column', () => {
    // Present indices 0 and 1 are id and title; bit 0 marks id NULL.
    const bytes = new Uint8Array([0b0000_0011, 0x00, 0b0000_0001]);
    let thrown: unknown;
    try {
      decodeSparseRow(SPARSE_COLUMNS, 0, bytes);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(DecodeError);
    expect((thrown as DecodeError).code).toBe('sync.invalid_request');
    expect((thrown as DecodeError).message).toContain(
      'null bit set for non-nullable column id',
    );
  });

  it('rejects an absent primary-key column', () => {
    const w = new ByteWriter();
    w.raw(new Uint8Array([0b0000_0010, 0x00])); // title only, no id
    w.u8(0x00); // null bitmap
    w.str('unnamed');
    expect(() => decodeSparseRow(SPARSE_COLUMNS, 0, w.finish())).toThrow(
      'missing the primary-key column id',
    );
  });

  it('rejects trailing bytes after the sparse payload', () => {
    const encoded = encodeSparseRow(SPARSE_COLUMNS, 0, SPARSE_PARTIAL);
    const padded = new Uint8Array(encoded.length + 1);
    padded.set(encoded);
    expect(() => decodeSparseRow(SPARSE_COLUMNS, 0, padded)).toThrow(
      DecodeError,
    );
  });

  it('refuses to encode a missing primary key or a NULL non-nullable column', () => {
    const noPrimaryKey: SparseRowValue[] = [
      undefined,
      'title',
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
    ];
    expect(() => encodeSparseRow(SPARSE_COLUMNS, 0, noPrimaryKey)).toThrow(
      'missing the primary-key column id',
    );
    const nullPrimaryKey: SparseRowValue[] = [
      null,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
    ];
    expect(() => encodeSparseRow(SPARSE_COLUMNS, 0, nullPrimaryKey)).toThrow(
      'not nullable',
    );
  });
});
