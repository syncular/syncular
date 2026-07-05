import { describe, expect, test } from 'bun:test';
import { generateKeyPair, UnwrapError, unwrapKey, wrapKey } from './index';

describe('§5.11 X25519 key wrap', () => {
  test('wrap → unwrap round-trips the key', async () => {
    const recipient = await generateKeyPair();
    const key = new Uint8Array(32).fill(42);
    const env = await wrapKey(key, recipient.publicKey);
    expect(env[0]).toBe(0x01);
    const back = await unwrapKey(env, recipient.privateKey);
    expect([...back]).toEqual([...key]);
  });

  test('the wrong recipient cannot unwrap', async () => {
    const a = await generateKeyPair();
    const b = await generateKeyPair();
    const env = await wrapKey(new Uint8Array(32).fill(1), a.publicKey);
    await expect(unwrapKey(env, b.privateKey)).rejects.toThrow(UnwrapError);
  });
});
