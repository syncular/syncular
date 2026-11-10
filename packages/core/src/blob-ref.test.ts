/**
 * Canonical BlobRef (SPEC.md §5.9.1): a value is valid iff it is a valid
 * JSON document, has the pinned shape, and equals the canonical
 * serialization of its fields. The Rust core runs the same probes
 * (`ssp2::blob_ref` tests).
 */
import { describe, expect, it } from 'bun:test';
import { DecodeError, parseBlobRef, serializeBlobRef } from './index';

const BLOB_ID = `sha256:${'ab'.repeat(32)}`;

const REJECTED: ReadonlyArray<readonly [string, string]> = [
  ['reordered keys', `{"byteLength":1,"blobId":"${BLOB_ID}"}`],
  [
    'mediaType after name',
    `{"blobId":"${BLOB_ID}","byteLength":1,"name":"a","mediaType":"b"}`,
  ],
  ['byteLength 1e2', `{"blobId":"${BLOB_ID}","byteLength":1e2}`],
  ['byteLength 3.0', `{"blobId":"${BLOB_ID}","byteLength":3.0}`],
  ['byteLength -0', `{"blobId":"${BLOB_ID}","byteLength":-0}`],
  ['byteLength 01', `{"blobId":"${BLOB_ID}","byteLength":01}`],
  ['byteLength -1', `{"blobId":"${BLOB_ID}","byteLength":-1}`],
  ['byteLength 2^53', `{"blobId":"${BLOB_ID}","byteLength":9007199254740992}`],
  ['whitespace', `{"blobId": "${BLOB_ID}","byteLength":1}`],
  ['trailing newline', `{"blobId":"${BLOB_ID}","byteLength":1}\n`],
  ['duplicate key', `{"blobId":"${BLOB_ID}","byteLength":1,"byteLength":1}`],
  [
    'non-canonical escape',
    `{"blobId":"${BLOB_ID}","byteLength":1,"name":"\\u0061"}`,
  ],
  ['escaped slash', `{"blobId":"${BLOB_ID}","byteLength":1,"name":"a\\/b"}`],
  [
    'unpaired surrogate name',
    `{"blobId":"${BLOB_ID}","byteLength":1,"name":"\\ud800"}`,
  ],
  ['U+0000 name', `{"blobId":"${BLOB_ID}","byteLength":1,"name":"\\u0000"}`],
  ['unknown key', `{"blobId":"${BLOB_ID}","byteLength":1,"x":1}`],
  ['uppercase hex', `{"blobId":"sha256:${'AB'.repeat(32)}","byteLength":1}`],
  ['missing byteLength', `{"blobId":"${BLOB_ID}"}`],
  ['numeric name', `{"blobId":"${BLOB_ID}","byteLength":1,"name":7}`],
  ['array', '[]'],
];

describe('canonical BlobRef (SPEC.md §5.9.1)', () => {
  it('serializes in the pinned key order with JSON.stringify escapes', () => {
    expect(
      serializeBlobRef({
        blobId: BLOB_ID,
        byteLength: 1024,
        mediaType: 'text/plain',
        name: '"q" \\ \b\f\n\r\t\u0001\u001f\u007f é 😀  ',
      }),
    ).toBe(
      `{"blobId":"${BLOB_ID}","byteLength":1024,"mediaType":"text/plain","name":"\\"q\\" \\\\ \\b\\f\\n\\r\\t\\u0001\\u001f\u007f é 😀  "}`,
    );
  });

  it('accepts canonical text with and without the optional keys', () => {
    for (const ref of [
      { blobId: BLOB_ID, byteLength: 0 },
      { blobId: BLOB_ID, byteLength: 9007199254740991, name: 'a.txt' },
      { blobId: BLOB_ID, byteLength: 1, mediaType: 'image/png', name: '' },
    ]) {
      expect(parseBlobRef(serializeBlobRef(ref))).toEqual(ref);
    }
  });

  for (const [name, raw] of REJECTED) {
    it(`rejects ${name}`, () => {
      let thrown: unknown;
      try {
        parseBlobRef(raw);
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(DecodeError);
      expect(thrown).toMatchObject({ code: 'sync.invalid_request' });
    });
  }
});
