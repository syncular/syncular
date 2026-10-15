import { describe, expect, test } from 'bun:test';
import {
  generateKeyPair,
  UnwrapError,
  unwrapKey,
  wrapKey,
  wrapKeyWith,
} from './index';

describe('§5.11 X25519 key wrap', () => {
  test('wrap → unwrap round-trips the key', async () => {
    const recipient = await generateKeyPair();
    const key = new Uint8Array(32).fill(42);
    const env = await wrapKey(key, recipient.publicKey);
    expect(env[0]).toBe(0x01);
    const back = await unwrapKey(env, recipient.privateKey);
    expect([...back]).toEqual([...key]);
  });

  test('wrapKeyWith refuses keys and nonces of the wrong length', async () => {
    const recipient = await generateKeyPair();
    const ephemeral = await generateKeyPair();
    const nonce = new Uint8Array(12);
    await expect(
      wrapKeyWith(
        new Uint8Array(16),
        recipient.publicKey,
        ephemeral.privateKey,
        nonce,
      ),
    ).rejects.toThrow('32-byte key');
    await expect(
      wrapKeyWith(
        new Uint8Array(32),
        recipient.publicKey.subarray(1),
        ephemeral.privateKey,
        nonce,
      ),
    ).rejects.toThrow('32-byte X25519 keys');
    await expect(
      wrapKeyWith(
        new Uint8Array(32),
        recipient.publicKey,
        ephemeral.privateKey,
        new Uint8Array(8),
      ),
    ).rejects.toThrow('nonce');
  });

  test('a low-order ephemeral key cannot unwrap', async () => {
    const recipient = await generateKeyPair();
    const envelope = new Uint8Array(1 + 32 + 12 + 48);
    envelope[0] = 0x01;
    await expect(unwrapKey(envelope, recipient.privateKey)).rejects.toThrow(
      UnwrapError,
    );
  });

  test('the wrong recipient cannot unwrap', async () => {
    const a = await generateKeyPair();
    const b = await generateKeyPair();
    const env = await wrapKey(new Uint8Array(32).fill(1), a.publicKey);
    await expect(unwrapKey(env, b.privateKey)).rejects.toThrow(UnwrapError);
  });
});
