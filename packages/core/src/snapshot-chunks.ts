/**
 * @syncular/core - Snapshot chunk encoding helpers
 */

export const SYNC_SNAPSHOT_CHUNK_ENCODING_JSON_ROW_FRAME_V1 =
  'json-row-frame-v1';
export const SYNC_SNAPSHOT_CHUNK_ENCODING_BINARY_TABLE_V1 = 'binary-table-v1';
export const SYNC_SNAPSHOT_CHUNK_ENCODINGS = [
  SYNC_SNAPSHOT_CHUNK_ENCODING_JSON_ROW_FRAME_V1,
  SYNC_SNAPSHOT_CHUNK_ENCODING_BINARY_TABLE_V1,
] as const;
export const SYNC_SNAPSHOT_CHUNK_ENCODING =
  SYNC_SNAPSHOT_CHUNK_ENCODING_JSON_ROW_FRAME_V1;
export type SyncSnapshotChunkEncoding =
  (typeof SYNC_SNAPSHOT_CHUNK_ENCODINGS)[number];

export function isSyncSnapshotChunkEncoding(
  value: unknown
): value is SyncSnapshotChunkEncoding {
  return (
    typeof value === 'string' &&
    (SYNC_SNAPSHOT_CHUNK_ENCODINGS as readonly string[]).includes(value)
  );
}

export const SYNC_SNAPSHOT_CHUNK_COMPRESSION = 'gzip';
export type SyncSnapshotChunkCompression =
  typeof SYNC_SNAPSHOT_CHUNK_COMPRESSION;

const SNAPSHOT_ROW_FRAME_MAGIC = new Uint8Array([0x53, 0x52, 0x46, 0x31]); // "SRF1"
const SNAPSHOT_BINARY_TABLE_MAGIC = new Uint8Array([0x53, 0x42, 0x54, 0x31]); // "SBT1"
const FRAME_LENGTH_BYTES = 4;
const BINARY_TABLE_VERSION = 1;
const BINARY_TABLE_FLAG_NONE = 0;
const BINARY_COLUMN_FLAG_NULLABLE = 1;
const MAX_FRAME_BYTE_LENGTH = 0xffff_ffff;
const snapshotRowFrameEncoder = new TextEncoder();
const snapshotRowFrameDecoder = new TextDecoder();

export type BinarySnapshotColumnType =
  | 'string'
  | 'integer'
  | 'float'
  | 'boolean'
  | 'json'
  | 'bytes';

export interface BinarySnapshotColumn {
  name: string;
  type: BinarySnapshotColumnType;
  nullable?: boolean;
}

export interface BinarySnapshotTable {
  table: string;
  columns: readonly BinarySnapshotColumn[];
  rows: readonly Record<string, unknown>[];
}

export type BinarySnapshotRowsEncoder<Row = unknown> = (
  rows: readonly Row[]
) => Uint8Array;

export interface DecodedBinarySnapshotTable {
  table: string;
  columns: BinarySnapshotColumn[];
  rows: Record<string, unknown>[];
}

const BINARY_TYPE_TAGS = {
  string: 1,
  integer: 2,
  float: 3,
  boolean: 4,
  json: 5,
  bytes: 6,
} as const satisfies Record<BinarySnapshotColumnType, number>;

const BINARY_COLUMN_TYPES_BY_TAG = new Map<number, BinarySnapshotColumnType>(
  Object.entries(BINARY_TYPE_TAGS).map(([type, tag]) => [
    tag,
    type as BinarySnapshotColumnType,
  ])
);

function normalizeRowJson(row: unknown): string {
  const serialized = JSON.stringify(row);
  return serialized === undefined ? 'null' : serialized;
}

/**
 * Encode rows as framed JSON bytes without the format header.
 */
export function encodeSnapshotRowFrames(rows: readonly unknown[]): Uint8Array {
  const payloads: Uint8Array[] = [];
  let totalByteLength = 0;

  for (const row of rows) {
    const payload = snapshotRowFrameEncoder.encode(normalizeRowJson(row));
    if (payload.length > MAX_FRAME_BYTE_LENGTH) {
      throw new Error(
        `Snapshot row payload exceeds ${MAX_FRAME_BYTE_LENGTH} bytes`
      );
    }
    payloads.push(payload);
    totalByteLength += FRAME_LENGTH_BYTES + payload.length;
  }

  const encoded = new Uint8Array(totalByteLength);
  const view = new DataView(encoded.buffer, encoded.byteOffset, encoded.length);
  let offset = 0;
  for (const payload of payloads) {
    view.setUint32(offset, payload.length, false);
    offset += FRAME_LENGTH_BYTES;
    encoded.set(payload, offset);
    offset += payload.length;
  }

  return encoded;
}

/**
 * Encode rows as framed JSON bytes with a format header.
 *
 * Format:
 * - 4-byte magic header ("SRF1")
 * - repeated frames of:
 *   - 4-byte big-endian payload byte length
 *   - UTF-8 JSON payload
 */
export function encodeSnapshotRows(rows: readonly unknown[]): Uint8Array {
  const framedRows = encodeSnapshotRowFrames(rows);
  const totalByteLength = SNAPSHOT_ROW_FRAME_MAGIC.length + framedRows.length;

  const encoded = new Uint8Array(totalByteLength);
  encoded.set(SNAPSHOT_ROW_FRAME_MAGIC, 0);
  encoded.set(framedRows, SNAPSHOT_ROW_FRAME_MAGIC.length);

  return encoded;
}

/**
 * Decode framed JSON bytes into rows.
 */
export function decodeSnapshotRows(bytes: Uint8Array): unknown[] {
  if (bytes.length < SNAPSHOT_ROW_FRAME_MAGIC.length) {
    throw new Error('Snapshot chunk payload is too small');
  }

  for (let index = 0; index < SNAPSHOT_ROW_FRAME_MAGIC.length; index += 1) {
    const expected = SNAPSHOT_ROW_FRAME_MAGIC[index];
    const actual = bytes[index];
    if (actual !== expected) {
      throw new Error('Unexpected snapshot chunk format');
    }
  }

  const rows: unknown[] = [];
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.length);
  let offset = SNAPSHOT_ROW_FRAME_MAGIC.length;

  while (offset < bytes.length) {
    if (offset + FRAME_LENGTH_BYTES > bytes.length) {
      throw new Error('Snapshot chunk payload ended mid-frame header');
    }

    const payloadLength = view.getUint32(offset, false);
    offset += FRAME_LENGTH_BYTES;

    if (offset + payloadLength > bytes.length) {
      throw new Error('Snapshot chunk payload ended mid-frame body');
    }

    const payload = bytes.subarray(offset, offset + payloadLength);
    offset += payloadLength;
    rows.push(JSON.parse(snapshotRowFrameDecoder.decode(payload)));
  }

  return rows;
}

export function encodeBinarySnapshotTable(
  table: BinarySnapshotTable
): Uint8Array {
  const writer = new BinarySnapshotWriter(estimateBinarySnapshotTableSize(table));
  writeBinarySnapshotTableHeader(
    writer,
    table.table,
    table.columns,
    table.rows.length
  );

  const nullBitmapBytes = Math.ceil(table.columns.length / 8);
  for (const row of table.rows) {
    const nullBitmapOffset = writer.writeZeroes(nullBitmapBytes);
    for (let index = 0; index < table.columns.length; index += 1) {
      const column = table.columns[index]!;
      const value = row[column.name];
      if (value == null) {
        if (!column.nullable) {
          throw new Error(
            `Binary snapshot column ${column.name} is not nullable`
          );
        }
        const bitmapIndex = nullBitmapOffset + Math.floor(index / 8);
        writer.patchUint8(
          bitmapIndex,
          writer.readUint8(bitmapIndex) | (1 << (index % 8))
        );
        continue;
      }
      writeBinarySnapshotValue(writer, column, value);
    }
  }

  return writer.toUint8Array();
}

export class BinarySnapshotTableWriter {
  private readonly writer: BinarySnapshotWriter;
  private readonly nullBitmapBytes: number;
  private readonly expectedRows: number;
  private rowsWritten = 0;
  private nullBitmapOffset: number | null = null;

  constructor(
    table: string,
    private readonly columns: readonly BinarySnapshotColumn[],
    rowCount: number,
    initialCapacity?: number
  ) {
    this.expectedRows = rowCount;
    this.nullBitmapBytes = Math.ceil(columns.length / 8);
    this.writer = new BinarySnapshotWriter(
      initialCapacity ??
        estimateBinarySnapshotStaticSize(table, columns, rowCount)
    );
    writeBinarySnapshotTableHeader(this.writer, table, columns, rowCount);
  }

  beginRow(): void {
    if (this.rowsWritten >= this.expectedRows) {
      throw new Error('Binary snapshot writer received too many rows');
    }
    this.nullBitmapOffset = this.writer.writeZeroes(this.nullBitmapBytes);
    this.rowsWritten += 1;
  }

  writeNull(columnIndex: number): void {
    const column = this.column(columnIndex);
    if (!column.nullable) {
      throw new Error(`Binary snapshot column ${column.name} is not nullable`);
    }
    const nullBitmapOffset = this.currentNullBitmapOffset();
    const bitmapIndex = nullBitmapOffset + Math.floor(columnIndex / 8);
    this.writer.patchUint8(
      bitmapIndex,
      this.writer.readUint8(bitmapIndex) | (1 << (columnIndex % 8))
    );
  }

  writeString(value: string, label: string): void {
    this.currentNullBitmapOffset();
    if (typeof value !== 'string') {
      throw new Error(`${label} expected string`);
    }
    this.writer.writeString32(value, label);
  }

  writeInteger(value: number | bigint, label: string): void {
    this.currentNullBitmapOffset();
    this.writer.writeInt64(value, label);
  }

  writeFloat(value: number, label: string): void {
    this.currentNullBitmapOffset();
    if (typeof value !== 'number') {
      throw new Error(`${label} expected number`);
    }
    this.writer.writeFloat64(value);
  }

  writeBoolean(value: boolean, label: string): void {
    this.currentNullBitmapOffset();
    if (typeof value !== 'boolean') {
      throw new Error(`${label} expected boolean`);
    }
    this.writer.writeUint8(value ? 1 : 0);
  }

  writeJson(value: unknown, label: string): void {
    this.currentNullBitmapOffset();
    this.writer.writeString32(normalizeRowJson(value), label);
  }

  writeBytes(value: Uint8Array | ArrayBuffer, columnName: string): void {
    this.currentNullBitmapOffset();
    const bytes = coerceBinaryBytes(value, columnName);
    this.writer.writeUint32(bytes.length);
    this.writer.writeBytes(bytes);
  }

  writeValue(columnIndex: number, value: unknown): void {
    const column = this.column(columnIndex);
    if (value == null) {
      this.writeNull(columnIndex);
      return;
    }
    this.currentNullBitmapOffset();
    writeBinarySnapshotValue(this.writer, column, value);
  }

  finish(): Uint8Array {
    if (this.rowsWritten !== this.expectedRows) {
      throw new Error(
        `Binary snapshot writer expected ${this.expectedRows} rows, received ${this.rowsWritten}`
      );
    }
    return this.writer.toUint8Array();
  }

  private column(columnIndex: number): BinarySnapshotColumn {
    const column = this.columns[columnIndex];
    if (!column) {
      throw new Error(`Binary snapshot column index ${columnIndex} is invalid`);
    }
    return column;
  }

  private currentNullBitmapOffset(): number {
    if (this.nullBitmapOffset == null) {
      throw new Error('Binary snapshot writer has no active row');
    }
    return this.nullBitmapOffset;
  }
}

export function decodeBinarySnapshotTable(
  bytes: Uint8Array
): DecodedBinarySnapshotTable {
  const reader = new BinarySnapshotReader(bytes);
  reader.expectMagic(SNAPSHOT_BINARY_TABLE_MAGIC, 'binary snapshot table');
  const version = reader.readUint16('binary snapshot version');
  if (version !== BINARY_TABLE_VERSION) {
    throw new Error(`Unsupported binary snapshot version: ${version}`);
  }
  const flags = reader.readUint16('binary snapshot flags');
  if (flags !== BINARY_TABLE_FLAG_NONE) {
    throw new Error(`Unsupported binary snapshot flags: ${flags}`);
  }

  const table = reader.readString16('binary snapshot table name');
  const columnCount = reader.readUint16('binary snapshot column count');
  const columns: BinarySnapshotColumn[] = [];
  for (let index = 0; index < columnCount; index += 1) {
    const name = reader.readString16('binary snapshot column name');
    const typeTag = reader.readUint8('binary snapshot column type');
    const type = BINARY_COLUMN_TYPES_BY_TAG.get(typeTag);
    if (!type)
      throw new Error(`Unsupported binary snapshot type tag: ${typeTag}`);
    const columnFlags = reader.readUint8('binary snapshot column flags');
    if (columnFlags & ~BINARY_COLUMN_FLAG_NULLABLE) {
      throw new Error(
        `Unsupported binary snapshot column flags: ${columnFlags}`
      );
    }
    columns.push({
      name,
      type,
      ...(columnFlags & BINARY_COLUMN_FLAG_NULLABLE ? { nullable: true } : {}),
    });
  }

  const rowCount = reader.readUint32('binary snapshot row count');
  const rows: Record<string, unknown>[] = [];
  const nullBitmapBytes = Math.ceil(columns.length / 8);
  for (let rowIndex = 0; rowIndex < rowCount; rowIndex += 1) {
    const nullBitmap = reader.readBytes(
      nullBitmapBytes,
      'binary snapshot row null bitmap'
    );
    const row: Record<string, unknown> = {};
    for (let columnIndex = 0; columnIndex < columns.length; columnIndex += 1) {
      const column = columns[columnIndex]!;
      const isNull =
        (nullBitmap[Math.floor(columnIndex / 8)]! &
          (1 << (columnIndex % 8))) !==
        0;
      if (isNull && !column.nullable) {
        throw new Error(
          `Binary snapshot column ${column.name} is not nullable`
        );
      }
      row[column.name] = isNull
        ? null
        : reader.readValue(column.type, `binary snapshot ${column.name}`);
    }
    rows.push(row);
  }
  reader.assertDone();

  return { table, columns, rows };
}

function writeBinarySnapshotValue(
  writer: BinarySnapshotWriter,
  column: BinarySnapshotColumn,
  value: unknown
): void {
  switch (column.type) {
    case 'string': {
      if (typeof value !== 'string') {
        throw new Error(
          `Binary snapshot column ${column.name} expected string`
        );
      }
      writer.writeString32(value, `binary snapshot ${column.name}`);
      return;
    }
    case 'integer':
      writer.writeInt64(value, `binary snapshot ${column.name}`);
      return;
    case 'float': {
      if (typeof value !== 'number') {
        throw new Error(
          `Binary snapshot column ${column.name} expected number`
        );
      }
      writer.writeFloat64(value);
      return;
    }
    case 'boolean': {
      if (typeof value !== 'boolean') {
        throw new Error(
          `Binary snapshot column ${column.name} expected boolean`
        );
      }
      writer.writeUint8(value ? 1 : 0);
      return;
    }
    case 'json':
      writer.writeString32(
        normalizeRowJson(value),
        `binary snapshot ${column.name}`
      );
      return;
    case 'bytes': {
      const bytes = coerceBinaryBytes(value, column.name);
      writer.writeUint32(bytes.length);
      writer.writeBytes(bytes);
      return;
    }
  }
}

function binarySnapshotInt64(value: unknown, label: string): bigint {
  let bigint: bigint;
  if (typeof value === 'bigint') {
    bigint = value;
  } else if (typeof value === 'number' && Number.isSafeInteger(value)) {
    bigint = BigInt(value);
  } else {
    throw new Error(`${label} expected a safe integer or bigint`);
  }
  return bigint;
}

function coerceBinaryBytes(value: unknown, columnName: string): Uint8Array {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  throw new Error(`Binary snapshot column ${columnName} expected bytes`);
}

function assertUint16(value: number, label: string): void {
  if (!Number.isInteger(value) || value < 0 || value > 0xffff) {
    throw new Error(`${label} exceeds uint16 bounds`);
  }
}

function assertUint32(value: number, label: string): void {
  if (!Number.isInteger(value) || value < 0 || value > MAX_FRAME_BYTE_LENGTH) {
    throw new Error(`${label} exceeds uint32 bounds`);
  }
}

function concatUint8Arrays(chunks: readonly Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

function estimateBinarySnapshotTableSize(table: BinarySnapshotTable): number {
  return estimateBinarySnapshotStaticSize(
    table.table,
    table.columns,
    table.rows.length
  );
}

function estimateBinarySnapshotStaticSize(
  table: string,
  columns: readonly BinarySnapshotColumn[],
  rowCount: number
): number {
  const columnHeaderBytes = columns.reduce(
    (sum, column) => sum + 4 + column.name.length * 4,
    0
  );
  const rowOverhead = rowCount * Math.max(1, Math.ceil(columns.length / 8));
  const scalarBytes = rowCount * columns.length * 16;
  return (
    SNAPSHOT_BINARY_TABLE_MAGIC.length +
    10 +
    table.length * 4 +
    columnHeaderBytes +
    rowOverhead +
    scalarBytes
  );
}

function writeBinarySnapshotTableHeader(
  writer: BinarySnapshotWriter,
  table: string,
  columns: readonly BinarySnapshotColumn[],
  rowCount: number
): void {
  assertUint16(columns.length, 'binary snapshot column count');
  assertUint32(rowCount, 'binary snapshot row count');

  writer.writeBytes(SNAPSHOT_BINARY_TABLE_MAGIC);
  writer.writeUint16(BINARY_TABLE_VERSION);
  writer.writeUint16(BINARY_TABLE_FLAG_NONE);
  writer.writeString16(table, 'binary snapshot table name');
  writer.writeUint16(columns.length);

  for (const column of columns) {
    writer.writeString16(column.name, 'binary snapshot column name');
    writer.writeUint8(BINARY_TYPE_TAGS[column.type]);
    writer.writeUint8(column.nullable ? BINARY_COLUMN_FLAG_NULLABLE : 0);
  }

  writer.writeUint32(rowCount);
}

class BinarySnapshotWriter {
  private bytes: Uint8Array;
  private view: DataView;
  private offset = 0;

  constructor(initialCapacity: number) {
    this.bytes = new Uint8Array(Math.max(64, initialCapacity));
    this.view = new DataView(
      this.bytes.buffer,
      this.bytes.byteOffset,
      this.bytes.length
    );
  }

  writeUint8(value: number): void {
    this.ensure(1);
    this.view.setUint8(this.offset, value);
    this.offset += 1;
  }

  writeUint16(value: number): void {
    assertUint16(value, 'binary snapshot uint16');
    this.ensure(2);
    this.view.setUint16(this.offset, value, true);
    this.offset += 2;
  }

  writeUint32(value: number): void {
    assertUint32(value, 'binary snapshot uint32');
    this.ensure(4);
    this.view.setUint32(this.offset, value, true);
    this.offset += 4;
  }

  writeInt64(value: unknown, label: string): void {
    this.ensure(8);
    this.view.setBigInt64(
      this.offset,
      binarySnapshotInt64(value, label),
      true
    );
    this.offset += 8;
  }

  writeFloat64(value: number): void {
    this.ensure(8);
    this.view.setFloat64(this.offset, value, true);
    this.offset += 8;
  }

  writeString16(value: string, label: string): void {
    const bytes = snapshotRowFrameEncoder.encode(value);
    assertUint16(bytes.length, label);
    this.writeUint16(bytes.length);
    this.writeBytes(bytes);
  }

  writeString32(value: string, label: string): void {
    const bytes = snapshotRowFrameEncoder.encode(value);
    assertUint32(bytes.length, label);
    this.writeUint32(bytes.length);
    this.writeBytes(bytes);
  }

  writeBytes(bytes: Uint8Array): void {
    this.ensure(bytes.length);
    this.bytes.set(bytes, this.offset);
    this.offset += bytes.length;
  }

  writeZeroes(length: number): number {
    this.ensure(length);
    const start = this.offset;
    this.bytes.fill(0, start, start + length);
    this.offset += length;
    return start;
  }

  readUint8(offset: number): number {
    return this.view.getUint8(offset);
  }

  patchUint8(offset: number, value: number): void {
    this.view.setUint8(offset, value);
  }

  toUint8Array(): Uint8Array {
    return this.bytes.subarray(0, this.offset);
  }

  private ensure(length: number): void {
    const required = this.offset + length;
    if (required <= this.bytes.length) return;
    let nextLength = this.bytes.length;
    while (nextLength < required) {
      nextLength *= 2;
    }
    const next = new Uint8Array(nextLength);
    next.set(this.bytes, 0);
    this.bytes = next;
    this.view = new DataView(
      this.bytes.buffer,
      this.bytes.byteOffset,
      this.bytes.length
    );
  }
}

class BinarySnapshotReader {
  private readonly view: DataView;
  private offset = 0;

  constructor(private readonly bytes: Uint8Array) {
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.length);
  }

  expectMagic(magic: Uint8Array, label: string): void {
    const actual = this.readBytes(magic.length, `${label} magic`);
    for (let index = 0; index < magic.length; index += 1) {
      if (actual[index] !== magic[index])
        throw new Error(`Unexpected ${label} magic`);
    }
  }

  readUint8(label: string): number {
    this.require(1, label);
    const value = this.view.getUint8(this.offset);
    this.offset += 1;
    return value;
  }

  readUint16(label: string): number {
    this.require(2, label);
    const value = this.view.getUint16(this.offset, true);
    this.offset += 2;
    return value;
  }

  readUint32(label: string): number {
    this.require(4, label);
    const value = this.view.getUint32(this.offset, true);
    this.offset += 4;
    return value;
  }

  readString16(label: string): string {
    const length = this.readUint16(`${label} length`);
    return snapshotRowFrameDecoder.decode(this.readBytes(length, label));
  }

  readString32(label: string): string {
    const length = this.readUint32(`${label} length`);
    return snapshotRowFrameDecoder.decode(this.readBytes(length, label));
  }

  readBytes(length: number, label: string): Uint8Array {
    this.require(length, label);
    const value = this.bytes.subarray(this.offset, this.offset + length);
    this.offset += length;
    return value;
  }

  readValue(type: BinarySnapshotColumnType, label: string): unknown {
    switch (type) {
      case 'string':
        return this.readString32(label);
      case 'integer': {
        this.require(8, label);
        const value = this.view.getBigInt64(this.offset, true);
        this.offset += 8;
        const numberValue = Number(value);
        return Number.isSafeInteger(numberValue) &&
          BigInt(numberValue) === value
          ? numberValue
          : value;
      }
      case 'float': {
        this.require(8, label);
        const value = this.view.getFloat64(this.offset, true);
        this.offset += 8;
        return value;
      }
      case 'boolean': {
        const value = this.readUint8(label);
        if (value !== 0 && value !== 1)
          throw new Error(`${label} expected boolean byte`);
        return value === 1;
      }
      case 'json':
        return JSON.parse(this.readString32(label));
      case 'bytes': {
        const length = this.readUint32(`${label} length`);
        return this.readBytes(length, label);
      }
    }
  }

  assertDone(): void {
    if (this.offset !== this.bytes.length) {
      throw new Error('Binary snapshot payload has trailing bytes');
    }
  }

  private require(length: number, label: string): void {
    if (this.offset + length > this.bytes.length) {
      throw new Error(`${label} exceeds binary snapshot payload bounds`);
    }
  }
}
