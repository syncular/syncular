/**
 * Canonical BlobRef documents (SPEC.md §5.9.1) — the value carried by a
 * `blob_ref` column (§2.4 tag 7).
 *
 * A `blob_ref` value is a `str` holding a JSON document with a pinned shape
 * and pinned key order: `blobId` (content address), `byteLength`, then the
 * optional `mediaType` and `name`. On the wire and in the codec it is
 * byte-for-byte a `str`, validated at decode exactly like `json` (tag 5)
 * plus the shape check below; the raw string is preserved verbatim for
 * re-encoding. Nothing here re-serializes a decoded value — round-trip
 * fidelity is the same rule the `json` tag obeys.
 */
import { DecodeError } from './errors';

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

/** Canonical key order (§5.9.1): blobId, byteLength, mediaType, name. */
const CANONICAL_KEYS: readonly string[] = [
  'blobId',
  'byteLength',
  'mediaType',
  'name',
];

/**
 * Parse and validate a raw `blob_ref` string against the §5.9.1 shape. A
 * failure is a row-codec decode error (`sync.invalid_request`), the same
 * class as the tag-5 json parse failure — so codec and §11 rendering can
 * never disagree.
 */
export function parseBlobRef(raw: string): BlobRef {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new DecodeError(
      'sync.invalid_request',
      'blob_ref value does not parse as a JSON document (§5.9.1)',
    );
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new DecodeError(
      'sync.invalid_request',
      'blob_ref value must be a JSON object (§5.9.1)',
    );
  }
  const obj = parsed as Record<string, unknown>;
  for (const key of Object.keys(obj)) {
    if (!CANONICAL_KEYS.includes(key)) {
      throw new DecodeError(
        'sync.invalid_request',
        `blob_ref has unknown key ${JSON.stringify(key)} (§5.9.1)`,
      );
    }
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
  // Canonical key order: the raw string's keys, in appearance order, must be
  // a prefix-consistent subsequence of CANONICAL_KEYS (present keys in the
  // pinned order, absent keys omitted).
  const presentInOrder = Object.keys(obj);
  const expectedOrder = CANONICAL_KEYS.filter((k) => Object.hasOwn(obj, k));
  if (presentInOrder.join(',') !== expectedOrder.join(',')) {
    throw new DecodeError(
      'sync.invalid_request',
      'blob_ref keys are not in canonical order (§5.9.1)',
    );
  }
  return {
    blobId,
    byteLength,
    ...(mediaType !== undefined ? { mediaType } : {}),
    ...(name !== undefined ? { name } : {}),
  };
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
