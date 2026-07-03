/**
 * SigV4 derivation pinned by the published AWS examples ("Authenticating
 * Requests: Using Query Parameters / the Authorization Header", the
 * `examplebucket` vectors) — these fail if the hand-rolled canonical
 * request, string-to-sign, or key derivation drifts from the real
 * algorithm, independent of the in-tree stub (which shares the
 * derivation helpers by design).
 */
import { describe, expect, test } from 'bun:test';
import {
  amzTimestamps,
  EMPTY_PAYLOAD_SHA256,
  presignUrl,
  signRequest,
  uriEncode,
} from '../src/sigv4';

const AWS_EXAMPLE_CREDENTIALS = {
  accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
  secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
};
const AWS_EXAMPLE_NOW_MS = Date.UTC(2013, 4, 24, 0, 0, 0);

describe('SigV4 primitives', () => {
  test('uriEncode is the AWS variant (stricter than encodeURIComponent)', () => {
    expect(uriEncode("a b/c*!'()", true)).toBe('a%20b%2Fc%2A%21%27%28%29');
    expect(uriEncode('a/b', false)).toBe('a/b');
    expect(uriEncode('sha256:abc', true)).toBe('sha256%3Aabc');
  });

  test('amzTimestamps formats ISO-8601 basic', () => {
    expect(amzTimestamps(AWS_EXAMPLE_NOW_MS)).toEqual({
      amzDate: '20130524T000000Z',
      dateStamp: '20130524',
    });
  });
});

describe('SigV4 golden vectors (AWS docs, examplebucket)', () => {
  test('header-authenticated GET signs to the published signature', () => {
    const headers = signRequest({
      method: 'GET',
      url: new URL('https://examplebucket.s3.amazonaws.com/test.txt'),
      region: 'us-east-1',
      credentials: AWS_EXAMPLE_CREDENTIALS,
      nowMs: AWS_EXAMPLE_NOW_MS,
      payloadHash: EMPTY_PAYLOAD_SHA256,
      headers: { range: 'bytes=0-9' },
    });
    expect(headers.authorization).toBe(
      'AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request,' +
        'SignedHeaders=host;range;x-amz-content-sha256;x-amz-date,' +
        'Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41',
    );
    expect(headers['x-amz-date']).toBe('20130524T000000Z');
    expect(headers['x-amz-content-sha256']).toBe(EMPTY_PAYLOAD_SHA256);
  });

  test('presigned GET signs to the published signature', () => {
    const url = presignUrl({
      url: new URL('https://examplebucket.s3.amazonaws.com/test.txt'),
      region: 'us-east-1',
      credentials: AWS_EXAMPLE_CREDENTIALS,
      nowMs: AWS_EXAMPLE_NOW_MS,
      expiresSeconds: 86400,
    });
    expect(url.searchParams.get('X-Amz-Signature')).toBe(
      'aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404',
    );
    expect(url.searchParams.get('X-Amz-SignedHeaders')).toBe('host');
    expect(url.searchParams.get('X-Amz-Credential')).toBe(
      'AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request',
    );
  });
});
