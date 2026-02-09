/**
 * @syncular/core - Snapshot chunk encoding helpers
 */

export const SYNC_SNAPSHOT_CHUNK_ENCODING = 'json-row-frame-v1';
export type SyncSnapshotChunkEncoding = typeof SYNC_SNAPSHOT_CHUNK_ENCODING;

export const SYNC_SNAPSHOT_CHUNK_COMPRESSION = 'gzip';
export type SyncSnapshotChunkCompression =
  typeof SYNC_SNAPSHOT_CHUNK_COMPRESSION;

const SNAPSHOT_ROW_FRAME_MAGIC = new Uint8Array([0x53, 0x52, 0x46, 0x31]); // "SRF1"
const FRAME_LENGTH_BYTES = 4;
const MAX_FRAME_BYTE_LENGTH = 0xffff_ffff;

function normalizeRowJson(row: unknown): string {
  const serialized = JSON.stringify(row);
  return serialized === undefined ? 'null' : serialized;
}

/**
 * Encode rows as framed JSON bytes without the format header.
 */
export function encodeSnapshotRowFrames(rows: readonly unknown[]): Uint8Array {
  const encoder = new TextEncoder();
  const payloads: Uint8Array[] = [];
  let totalByteLength = 0;

  for (const row of rows) {
    const payload = encoder.encode(normalizeRowJson(row));
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
  const decoder = new TextDecoder();
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
    rows.push(JSON.parse(decoder.decode(payload)));
  }

  return rows;
}
