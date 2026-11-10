/**
 * Canonical BlobRef documents (SPEC.md §5.9.1) — the value carried by a
 * `blob_ref` column (§2.4 tag 7).
 *
 * A `blob_ref` value is a `str` holding the canonical serialization of a
 * pinned shape: `blobId` (content address), `byteLength`, then the optional
 * `mediaType` and `name`. On the wire and in the codec it is byte-for-byte a
 * `str`; decode accepts exactly the canonical text, so the raw string a
 * decoder preserves for re-encoding is the canonical one.
 */
import { DecodeError } from './errors';
import { parseJsonDocument } from './json-document';

/** The content-address prefix, identical in form to `segmentId` (§5.1). */
const BLOB_ID_RE = /^sha256:[0-9a-f]{64}$/;

export interface BlobRef {
  /** `"sha256:" + lowercase-hex SHA-256` of the blob bytes (§5.9.1). */
  readonly blobId: string;
  /** Non-negative uncompressed size within the i64 safe-integer contract. */
  readonly byteLength: number;
  /** Advisory MIME type; never parsed or trusted by the server. */
  readonly mediaType?: string;
  /** Advisory display filename. */
  readonly name?: string;
}

/**
 * Parse and validate a raw `blob_ref` string (§5.9.1): a valid JSON document
 * (Conventions JSON validity rule), the pinned shape, and text byte-identical
 * to `serializeBlobRef` of the parsed fields. A failure is a row-codec decode
 * error (`sync.invalid_request`) on every decode path.
 */
export function parseBlobRef(raw: string): BlobRef {
  const parsed = parseJsonDocument(raw, 'blob_ref value');
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new DecodeError(
      'sync.invalid_request',
      'blob_ref value must be a JSON object (§5.9.1)',
    );
  }
  const obj = parsed as Record<string, unknown>;
  const keys = ['blobId', 'byteLength', 'mediaType', 'name'];
  if (Object.keys(obj).some((key) => !keys.includes(key))) {
    throw new DecodeError(
      'sync.invalid_request',
      'blob_ref has an unknown key (§5.9.1)',
    );
  }
  const { blobId, byteLength, mediaType, name } = obj;
  if (typeof blobId !== 'string' || !BLOB_ID_RE.test(blobId)) {
    throw new DecodeError(
      'sync.invalid_request',
      'blob_ref.blobId must be "sha256:<64 hex>" (§5.9.1)',
    );
  }
  if (
    typeof byteLength !== 'number' ||
    !Number.isSafeInteger(byteLength) ||
    byteLength < 0
  ) {
    throw new DecodeError(
      'sync.invalid_request',
      'blob_ref.byteLength must be a non-negative safe integer (§5.9.1)',
    );
  }
  if (mediaType !== undefined && typeof mediaType !== 'string') {
    throw new DecodeError(
      'sync.invalid_request',
      'blob_ref.mediaType must be a string when present (§5.9.1)',
    );
  }
  if (name !== undefined && typeof name !== 'string') {
    throw new DecodeError(
      'sync.invalid_request',
      'blob_ref.name must be a string when present (§5.9.1)',
    );
  }
  const ref: BlobRef = {
    blobId,
    byteLength,
    ...(mediaType !== undefined ? { mediaType } : {}),
    ...(name !== undefined ? { name } : {}),
  };
  // Reordered or duplicate keys, whitespace, and a byteLength written as
  // `1e2`, `3.0` or `-0` all differ from the canonical text.
  if (serializeBlobRef(ref) !== raw) {
    throw new DecodeError(
      'sync.invalid_request',
      'blob_ref is not in canonical form (§5.9.1)',
    );
  }
  return ref;
}

/** Serialize a BlobRef to its canonical string form (§5.9.1 key order). */
export function serializeBlobRef(ref: BlobRef): string {
  const obj: Record<string, unknown> = {
    blobId: ref.blobId,
    byteLength: ref.byteLength,
  };
  if (ref.mediaType !== undefined) obj.mediaType = ref.mediaType;
  if (ref.name !== undefined) obj.name = ref.name;
  return JSON.stringify(obj);
}

/** True iff `raw` is a valid canonical BlobRef document (no throw). */
export function isBlobRef(raw: string): boolean {
  try {
    parseBlobRef(raw);
    return true;
  } catch {
    return false;
  }
}
