import { describe, expect, it } from 'bun:test';
import {
  ByteWriter,
  DecodeError,
  decodeRow,
  encodeRow,
  type RowColumn,
  type RowValue,
} from './index';

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
