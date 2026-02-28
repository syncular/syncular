import { afterEach, describe, expect, test } from 'bun:test';
import {
  base64ToBytes,
  base64UrlToBytes,
  bytesToBase64Url,
  hexToBytes,
  randomBytes,
} from './crypto-utils';

let originalBuffer: typeof Buffer | undefined;
let bufferOverridden = false;

function disableBufferRuntime(): void {
  originalBuffer = globalThis.Buffer;
  Object.defineProperty(globalThis, 'Buffer', {
    value: undefined,
    writable: true,
    configurable: true,
  });
  bufferOverridden = true;
}

function restoreBufferRuntime(): void {
  if (!bufferOverridden) return;
  Object.defineProperty(globalThis, 'Buffer', {
    value: originalBuffer,
    writable: true,
    configurable: true,
  });
  bufferOverridden = false;
}

afterEach(() => {
  restoreBufferRuntime();
});

describe('crypto-utils', () => {
  test('encodes and decodes base64 payloads', () => {
    const bytes = new Uint8Array([0, 1, 2, 253, 254, 255]);
    const encoded = 'AAEC/f7/';
    const decoded = base64ToBytes(encoded);
    expect(decoded).toEqual(bytes);
  });

  test('encodes and decodes base64url payloads', () => {
    const bytes = new Uint8Array([0, 1, 2, 253, 254, 255]);
    const encoded = bytesToBase64Url(bytes);
    const decoded = base64UrlToBytes(encoded);
    expect(decoded).toEqual(bytes);
  });

  test('rejects malformed base64 inputs', () => {
    expect(() => base64ToBytes('@@@@')).toThrow('Invalid base64 string');
    expect(() => base64UrlToBytes('@@@@')).toThrow('Invalid base64url string');
  });

  test('works when Buffer is unavailable', () => {
    disableBufferRuntime();

    const bytes = new Uint8Array([0, 1, 2, 253, 254, 255]);
    const encoded = 'AAEC/f7/';
    const decoded = base64ToBytes(encoded);
    expect(decoded).toEqual(bytes);

    const encodedUrl = bytesToBase64Url(bytes);
    const decodedUrl = base64UrlToBytes(encodedUrl);
    expect(decodedUrl).toEqual(bytes);
  });

  test('parses hex strings', () => {
    expect(hexToBytes('00a1ff')).toEqual(new Uint8Array([0, 161, 255]));
    expect(() => hexToBytes('0')).toThrow(
      'Invalid hex string (length must be even)'
    );
    expect(() => hexToBytes('zz')).toThrow('Invalid hex string');
  });

  test('creates random byte arrays', () => {
    const bytes = randomBytes(32);
    expect(bytes).toBeInstanceOf(Uint8Array);
    expect(bytes.length).toBe(32);
  });
});
