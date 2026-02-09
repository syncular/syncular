import { describe, expect, test } from 'bun:test';
import { createHmacTokenSigner } from './database';

describe('createHmacTokenSigner', () => {
  test('verifies valid signed tokens', async () => {
    const signer = createHmacTokenSigner('test-secret');
    const payload = {
      hash: 'sha256:abc',
      action: 'upload' as const,
      expiresAt: Date.now() + 60_000,
    };

    const token = await signer.sign(payload, 60);
    const decoded = await signer.verify(token);

    expect(decoded).toEqual(payload);
  });

  test('rejects tampered signatures', async () => {
    const signer = createHmacTokenSigner('test-secret');
    const payload = {
      hash: 'sha256:def',
      action: 'download' as const,
      expiresAt: Date.now() + 60_000,
    };

    const token = await signer.sign(payload, 60);
    const [data, sig] = token.split('.');
    if (!data || !sig) {
      throw new Error('Expected signed token with payload and signature');
    }
    const replacement = sig.endsWith('0') ? '1' : '0';
    const tamperedSig = `${sig.slice(0, -1)}${replacement}`;
    const tamperedToken = `${data}.${tamperedSig}`;

    expect(await signer.verify(tamperedToken)).toBeNull();
  });

  test('rejects malformed hex signatures', async () => {
    const signer = createHmacTokenSigner('test-secret');
    const payload = {
      hash: 'sha256:ghi',
      action: 'upload' as const,
      expiresAt: Date.now() + 60_000,
    };

    const token = await signer.sign(payload, 60);
    const [data] = token.split('.');
    if (!data) {
      throw new Error('Expected signed token payload segment');
    }

    expect(await signer.verify(`${data}.not-hex-signature`)).toBeNull();
  });

  test('rejects expired tokens', async () => {
    const signer = createHmacTokenSigner('test-secret');
    const payload = {
      hash: 'sha256:jkl',
      action: 'upload' as const,
      expiresAt: Date.now() - 1,
    };

    const token = await signer.sign(payload, 60);
    expect(await signer.verify(token)).toBeNull();
  });
});
