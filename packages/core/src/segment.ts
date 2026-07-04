/**
 * SSG2 rows segments (SPEC.md §5.2) — the mandatory bootstrap format.
 *
 * A standalone binary container: magic, format version, flags, a column
 * descriptor header (validation checksum, never inference), then
 * self-delimiting row blocks terminated by a mandatory `rowCount = 0` end
 * marker. Each row record carries the row's current `server_version`
 * (`serverVersion`, ≥ 1) ahead of the row-codec bytes, so segment-applied
 * rows participate in §6.2 conflict detection (§5.6).
 */
import { ByteReader, ByteWriter, utf8Encode } from './bytes';
import { DecodeError } from './errors';
import {
  columnTypeFromTag,
  columnTypeTag,
  type RowColumn,
  type RowValue,
  readRow,
  writeRow,
} from './row-codec';

export const ROWS_SEGMENT_MAGIC = 'SSG2';
export const ROWS_SEGMENT_FORMAT_VERSION = 1;

const MAGIC_BYTES = utf8Encode(ROWS_SEGMENT_MAGIC);

/** One §5.2 row record: the row's `server_version` plus its values. */
export interface SegmentRow {
  /** The row's `server_version` at `asOfCommitSeq` (§2.2); always ≥ 1. */
  readonly serverVersion: number;
  readonly values: readonly RowValue[];
}

export interface RowsSegment {
  readonly table: string;
  readonly schemaVersion: number;
  readonly columns: readonly RowColumn[];
  /** Row blocks in wire order; each block is applied in one transaction. */
  readonly blocks: readonly (readonly SegmentRow[])[];
}

export function encodeRowsSegment(segment: RowsSegment): Uint8Array {
  const writer = new ByteWriter();
  writer.raw(MAGIC_BYTES);
  writer.u16(ROWS_SEGMENT_FORMAT_VERSION);
  writer.u16(0);
  writer.str(segment.table);
  writer.i32(segment.schemaVersion);
  writer.u16(segment.columns.length);
  for (const column of segment.columns) {
    writer.str(column.name);
    writer.u8(columnTypeTag(column.type));
    writer.u8(column.nullable ? 1 : 0);
  }
  for (const block of segment.blocks) {
    if (block.length === 0) {
      throw new Error('a rows-segment block must contain at least one row');
    }
    const rowsWriter = new ByteWriter();
    for (const row of block) {
      if (row.serverVersion < 1) {
        throw new Error(
          `a rows-segment row serverVersion must be >= 1, got ${row.serverVersion}`,
        );
      }
      rowsWriter.i64(row.serverVersion);
      writeRow(rowsWriter, segment.columns, row.values);
    }
    const rows = rowsWriter.finish();
    writer.u32(block.length);
    writer.u32(rows.length);
    writer.raw(rows);
  }
  writer.u32(0);
  return writer.finish();
}

export function decodeRowsSegment(bytes: Uint8Array): RowsSegment {
  const reader = new ByteReader(bytes);
  const magic = reader.raw(4);
  if (
    magic[0] !== MAGIC_BYTES[0] ||
    magic[1] !== MAGIC_BYTES[1] ||
    magic[2] !== MAGIC_BYTES[2] ||
    magic[3] !== MAGIC_BYTES[3]
  ) {
    throw new DecodeError('sync.invalid_request', 'bad rows segment magic');
  }
  const formatVersion = reader.u16();
  if (formatVersion !== ROWS_SEGMENT_FORMAT_VERSION) {
    throw new DecodeError(
      'sync.invalid_request',
      `unsupported rows segment format version ${formatVersion}`,
    );
  }
  const flags = reader.u16();
  if (flags !== 0) {
    throw new DecodeError(
      'sync.invalid_request',
      `non-zero rows segment flags 0x${flags.toString(16)}`,
    );
  }
  const table = reader.str();
  const schemaVersion = reader.i32();
  const columnCount = reader.u16();
  const columns: RowColumn[] = [];
  for (let i = 0; i < columnCount; i++) {
    const name = reader.str();
    const type = columnTypeFromTag(reader.u8());
    const columnFlags = reader.u8();
    if ((columnFlags & 0xfe) !== 0) {
      throw new DecodeError(
        'sync.invalid_request',
        `reserved column flag bits set for column ${name}`,
      );
    }
    columns.push({ name, type, nullable: columnFlags === 1 });
  }
  const blocks: SegmentRow[][] = [];
  for (;;) {
    if (reader.remaining < 4) {
      throw new DecodeError(
        'sync.invalid_request',
        'rows segment truncated: missing end marker',
      );
    }
    const rowCount = reader.u32();
    if (rowCount === 0) {
      reader.expectFullyConsumed('rows segment end marker');
      break;
    }
    const byteLength = reader.u32();
    const rowBytes = reader.raw(byteLength);
    const blockReader = new ByteReader(rowBytes);
    const block: SegmentRow[] = [];
    for (let i = 0; i < rowCount; i++) {
      const serverVersion = blockReader.i64();
      if (serverVersion < 1) {
        throw new DecodeError(
          'sync.invalid_request',
          `rows segment row serverVersion must be >= 1, got ${serverVersion}`,
        );
      }
      block.push({ serverVersion, values: readRow(blockReader, columns) });
    }
    blockReader.expectFullyConsumed('rows block');
    blocks.push(block);
  }
  return { table, schemaVersion, columns, blocks };
}
