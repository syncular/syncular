import { afterEach, describe, expect, test } from 'bun:test';
import { createStaticFieldEncryptionKeys } from '../index';

const VALID_ZERO_KEY_BASE64URL = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

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

describe('createStaticFieldEncryptionKeys', () => {
  test('rejects malformed base64url key material in non-Buffer runtimes', async () => {
    disableBufferRuntime();

    const keys = createStaticFieldEncryptionKeys({
      keys: { default: '@@@@' },
    });

    await expect(keys.getKey('default')).rejects.toThrow(
      'Invalid base64url string'
    );
  });

  test('rejects wrong-length decoded key material in non-Buffer runtimes', async () => {
    disableBufferRuntime();

    const keys = createStaticFieldEncryptionKeys({
      keys: { default: 'QQ' },
    });

    await expect(keys.getKey('default')).rejects.toThrow(
      'Encryption key for kid "default" must be 32 bytes (got 1)'
    );
  });

  test('accepts valid 32-byte base64url keys in non-Buffer runtimes', async () => {
    disableBufferRuntime();

    const keys = createStaticFieldEncryptionKeys({
      keys: { default: VALID_ZERO_KEY_BASE64URL },
    });

    const decoded = await keys.getKey('default');
    expect(decoded.length).toBe(32);
  });
});
