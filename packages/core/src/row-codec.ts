/**
 * Schema-IR row codec (SPEC.md §2.4).
 *
 * A row is a null bitmap of ceil(columnCount / 8) bytes (bit i set =
 * column i is NULL; LSB-first within each byte, byte i/8), followed by the
 * non-null values encoded positionally in schema-IR declaration order.
 * Used for `COMMIT` change payloads, rows-segment row data, and conflict
 * `serverRow` values; push operation payloads use the sparse row codec
 * (`encodeSparseRow` / `decodeSparseRow`) instead.
 *
 * A sparse row (RFC §6.1) is the column subset a push operation writes: a
 * presence bitmap over all columns, a null bitmap over the present columns,
 * then the non-null present values. Absent columns keep their stored value.
 */
import { parseBlobRef } from './blob-ref';
import { ByteReader, ByteWriter } from './bytes';
import { DecodeError } from './errors';

export type ColumnType =
  | 'string'
  | 'integer'
  | 'float'
  | 'boolean'
  | 'json'
  | 'bytes'
  | 'blob_ref'
  | 'crdt';

export interface RowColumn {
  readonly name: string;
  readonly type: ColumnType;
  readonly nullable: boolean;
  /**
   * For a `crdt` column (§2.4 tag 8, §5.10.1): the named merger the server
   * selects (this rung defines exactly `'yjs-doc'`). Schema-IR metadata
   * ONLY — never on the wire (the SSG2 column table carries name/type/
   * nullable, and `crdt` shares the `bytes` tag). Ignored for other types.
   */
  readonly crdtType?: string;
  /**
   * §5.11: this column is encrypted end-to-end. When set, `type` is `bytes`
   * (the wire/stored type — the ciphertext envelope rides the bytes machinery)
   * and `declaredType` is the pre-flip app type. Both are schema-IR metadata,
   * never on the wire (like `crdtType`). The row codec ignores these — it
   * only ever sees a `bytes` value; encryption/decryption is the client
   * encode/apply seam (§5.11).
   */
  readonly encrypted?: boolean;
  /** §5.11: the app-side type of an encrypted column (its type before the
   * wire flip to `bytes`). Present iff `encrypted` is set. */
  readonly declaredType?: ColumnType;
}

/**
 * `integer` is `i64` within the ±(2^53−1) contract; `json` is the raw JSON
 * document string, preserved byte-for-byte on round-trip.
 */
export type RowValue = string | number | boolean | Uint8Array | null;

/** Wire tags, unchanged from v1's binary-table-v1 assignment (SPEC.md §2.4). */
const TYPE_TO_TAG: Readonly<Record<ColumnType, number>> = {
  string: 1,
  integer: 2,
  float: 3,
  boolean: 4,
  json: 5,
  bytes: 6,
  blob_ref: 7,
  crdt: 8,
};

const TAG_TO_TYPE = new Map<number, ColumnType>(
  Object.entries(TYPE_TO_TAG).map(([type, tag]) => [tag, type as ColumnType]),
);

export function columnTypeTag(type: ColumnType): number {
  return TYPE_TO_TAG[type];
}

export function columnTypeFromTag(tag: number): ColumnType {
  const type = TAG_TO_TYPE.get(tag);
  if (type === undefined) {
    throw new DecodeError(
      'sync.invalid_request',
      `unknown column type tag ${tag}`,
    );
  }
  return type;
}

function writeValue(
  writer: ByteWriter,
  column: RowColumn,
  value: Exclude<RowValue, null>,
): void {
  switch (column.type) {
    case 'string':
    case 'json':
    case 'blob_ref':
      if (typeof value !== 'string') {
        throw new Error(
          `column ${column.name} (${column.type}) requires a string value`,
        );
      }
      writer.str(value);
      return;
    case 'integer':
      if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
        throw new Error(
          `column ${column.name} (integer) requires a safe integer value`,
        );
      }
      writer.i64(value);
      return;
    case 'float':
      if (typeof value !== 'number') {
        throw new Error(
          `column ${column.name} (float) requires a number value`,
        );
      }
      writer.f64(value);
      return;
    case 'boolean':
      if (typeof value !== 'boolean') {
        throw new Error(
          `column ${column.name} (boolean) requires a boolean value`,
        );
      }
      writer.bool(value);
      return;
    case 'bytes':
    case 'crdt':
      // §2.4 tag 8: a `crdt` value is byte-for-byte a `bytes` value —
      // opaque CRDT bytes (§5.10), no structural validation. `crdtType`
      // selects the server merger and never touches the codec.
      if (!(value instanceof Uint8Array)) {
        throw new Error(
          `column ${column.name} (${column.type}) requires a Uint8Array value`,
        );
      }
      writer.bytes(value);
      return;
  }
}

function readValue(reader: ByteReader, column: RowColumn): RowValue {
  switch (column.type) {
    case 'string':
      return reader.str();
    case 'json': {
      // Conventions `json` MUST, applied at row-codec decode (SPEC.md §2.4
      // tag 5): the value must parse as a JSON document; the raw string is
      // preserved verbatim for round-trip fidelity.
      const raw = reader.str();
      try {
        JSON.parse(raw);
      } catch {
        throw new DecodeError(
          'sync.invalid_request',
          `json column ${column.name} does not parse as a JSON document`,
        );
      }
      return raw;
    }
    case 'blob_ref': {
      // §2.4 tag 7: the value is a canonical BlobRef JSON document
      // (§5.9.1). Validated at decode, same class as tag-5 json; the raw
      // string is preserved verbatim for re-encoding.
      const raw = reader.str();
      parseBlobRef(raw);
      return raw;
    }
    case 'integer':
      return reader.i64();
    case 'float':
      return reader.f64();
    case 'boolean':
      return reader.bool();
    case 'bytes':
    case 'crdt':
      // §2.4 tag 8: opaque bytes, decoded exactly like tag 6 (no parse).
      return reader.bytes();
  }
}

/** One bit of a bitmap: LSB-first within byte `index / 8`. */
function bitmapBit(bitmap: Uint8Array, index: number): boolean {
  return (((bitmap[index >> 3] ?? 0) >> (index & 7)) & 1) !== 0;
}

/**
 * A sparse-row slot (RFC §6.1): `undefined` when the column is absent from
 * the payload (an apply leaves the stored value untouched), `null` when the
 * column is present and NULL.
 */
export type SparseRowValue = RowValue | undefined;

/**
 * Encode one standalone sparse row (RFC §6.1, SPEC.md §2.4).
 *
 * `primaryKeyIndex` is the row's primary-key column; a payload without it is
 * encoder misuse and throws, like a NULL in a non-nullable column.
 */
export function encodeSparseRow(
  columns: readonly RowColumn[],
  primaryKeyIndex: number,
  values: readonly SparseRowValue[],
): Uint8Array {
  if (values.length !== columns.length) {
    throw new Error(
      `row value count ${values.length} does not match column count ${columns.length}`,
    );
  }
  const presence = new Uint8Array(Math.ceil(columns.length / 8));
  let presentCount = 0;
  for (let i = 0; i < columns.length; i++) {
    if (values[i] === undefined) continue;
    presence[i >> 3] = (presence[i >> 3] ?? 0) | (1 << (i & 7));
    presentCount++;
  }
  const primaryKey = columns[primaryKeyIndex];
  if (primaryKey === undefined) {
    throw new Error(
      `primary-key column index ${primaryKeyIndex} is outside the column table`,
    );
  }
  if (!bitmapBit(presence, primaryKeyIndex)) {
    throw new Error(
      `sparse row is missing the primary-key column ${primaryKey.name}`,
    );
  }
  const nulls = new Uint8Array(Math.ceil(presentCount / 8));
  let present = 0;
  for (let i = 0; i < columns.length; i++) {
    const column = columns[i];
    const value = values[i];
    if (column === undefined || value === undefined) continue;
    if (value === null) {
      if (!column.nullable) {
        throw new Error(`column ${column.name} is not nullable`);
      }
      nulls[present >> 3] = (nulls[present >> 3] ?? 0) | (1 << (present & 7));
    }
    present++;
  }
  const writer = new ByteWriter();
  writer.raw(presence);
  writer.raw(nulls);
  for (let i = 0; i < columns.length; i++) {
    const column = columns[i];
    const value = values[i];
    if (column === undefined || value === undefined || value === null) {
      continue;
    }
    writeValue(writer, column, value);
  }
  return writer.finish();
}

/**
 * Decode one standalone sparse row; the bytes must contain exactly one row.
 *
 * Decode checks, in order (each a decode error, RFC §6.1): a set presence
 * padding bit, an absent primary-key column, a set null-bitmap padding bit
 * (a null for an absent column), a null bit for a non-nullable column.
 */
export function decodeSparseRow(
  columns: readonly RowColumn[],
  primaryKeyIndex: number,
  bytes: Uint8Array,
): SparseRowValue[] {
  const reader = new ByteReader(bytes);
  const presenceLength = Math.ceil(columns.length / 8);
  const presence = reader.raw(presenceLength);
  for (let bit = columns.length; bit < presenceLength * 8; bit++) {
    if (bitmapBit(presence, bit)) {
      throw new DecodeError(
        'sync.invalid_request',
        'sparse row presence bitmap has a set padding bit (non-canonical encoding)',
      );
    }
  }
  const primaryKey = columns[primaryKeyIndex];
  if (primaryKey === undefined) {
    throw new DecodeError(
      'sync.invalid_request',
      `primary-key column index ${primaryKeyIndex} is outside the column table`,
    );
  }
  if (!bitmapBit(presence, primaryKeyIndex)) {
    throw new DecodeError(
      'sync.invalid_request',
      `sparse row is missing the primary-key column ${primaryKey.name}`,
    );
  }
  let presentCount = 0;
  for (let i = 0; i < columns.length; i++) {
    if (bitmapBit(presence, i)) presentCount++;
  }
  const nullLength = Math.ceil(presentCount / 8);
  const nulls = reader.raw(nullLength);
  for (let bit = presentCount; bit < nullLength * 8; bit++) {
    if (bitmapBit(nulls, bit)) {
      throw new DecodeError(
        'sync.invalid_request',
        'sparse row null bitmap sets a null bit for an absent column',
      );
    }
  }
  const values: SparseRowValue[] = [];
  let present = 0;
  for (let i = 0; i < columns.length; i++) {
    const column = columns[i];
    if (column === undefined || !bitmapBit(presence, i)) {
      values.push(undefined);
      continue;
    }
    const isNull = bitmapBit(nulls, present);
    present++;
    if (!isNull) {
      values.push(readValue(reader, column));
      continue;
    }
    if (!column.nullable) {
      throw new DecodeError(
        'sync.invalid_request',
        `null bit set for non-nullable column ${column.name}`,
      );
    }
    values.push(null);
  }
  reader.expectFullyConsumed('sparse row payload');
  return values;
}

export function writeRow(
  writer: ByteWriter,
  columns: readonly RowColumn[],
  values: readonly RowValue[],
): void {
  if (values.length !== columns.length) {
    throw new Error(
      `row value count ${values.length} does not match column count ${columns.length}`,
    );
  }
  const bitmapLength = Math.ceil(columns.length / 8);
  const bitmap = new Uint8Array(bitmapLength);
  for (let i = 0; i < columns.length; i++) {
    const column = columns[i];
    if (column === undefined) continue;
    if (values[i] === null) {
      if (!column.nullable) {
        throw new Error(`column ${column.name} is not nullable`);
      }
      bitmap[i >> 3] = (bitmap[i >> 3] ?? 0) | (1 << (i & 7));
    }
  }
  writer.raw(bitmap);
  for (let i = 0; i < columns.length; i++) {
    const column = columns[i];
    const value = values[i];
    if (column === undefined || value === null || value === undefined) continue;
    writeValue(writer, column, value);
  }
}

export function readRow(
  reader: ByteReader,
  columns: readonly RowColumn[],
): RowValue[] {
  const bitmapLength = Math.ceil(columns.length / 8);
  const bitmap = reader.raw(bitmapLength);
  for (let i = columns.length; i < bitmapLength * 8; i++) {
    if ((((bitmap[i >> 3] ?? 0) >> (i & 7)) & 1) !== 0) {
      throw new DecodeError(
        'sync.invalid_request',
        'non-zero padding bit in row null bitmap',
      );
    }
  }
  const values: RowValue[] = [];
  for (let i = 0; i < columns.length; i++) {
    const column = columns[i];
    if (column === undefined) continue;
    const isNull = (((bitmap[i >> 3] ?? 0) >> (i & 7)) & 1) !== 0;
    if (isNull) {
      if (!column.nullable) {
        throw new DecodeError(
          'sync.invalid_request',
          `null bit set for non-nullable column ${column.name}`,
        );
      }
      values.push(null);
    } else {
      values.push(readValue(reader, column));
    }
  }
  return values;
}

/** Encode one standalone row (e.g. a push payload or conflict serverRow). */
export function encodeRow(
  columns: readonly RowColumn[],
  values: readonly RowValue[],
): Uint8Array {
  const writer = new ByteWriter();
  writeRow(writer, columns, values);
  return writer.finish();
}

/** Decode one standalone row; the bytes must contain exactly one row. */
export function decodeRow(
  columns: readonly RowColumn[],
  bytes: Uint8Array,
): RowValue[] {
  const reader = new ByteReader(bytes);
  const values = readRow(reader, columns);
  reader.expectFullyConsumed('row payload');
  return values;
}
