/**
 * Schema-IR row codec (SPEC.md §2.4).
 *
 * A row is a null bitmap of ceil(columnCount / 8) bytes (bit i set =
 * column i is NULL; LSB-first within each byte, byte i/8), followed by the
 * non-null values encoded positionally in schema-IR declaration order.
 * Used for `COMMIT` change payloads, rows-segment row data, push operation
 * payloads, and conflict `serverRow` values.
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
