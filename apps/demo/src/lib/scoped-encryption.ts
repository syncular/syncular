/**
 * @syncular/demo - Scoped encryption utilities
 *
 * Provides passphrase-based key derivation and per-scope key management
 * for symmetric E2E encryption.
 */

import type { FieldEncryptionKeys } from '@syncular/client-plugin-encryption';

/**
 * Derive a 32-byte encryption key from a passphrase and scope using PBKDF2.
 *
 * The same passphrase + scope always produces the same key (deterministic).
 */
async function deriveKey(
  passphrase: string,
  scope: string
): Promise<Uint8Array> {
  const encoder = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    encoder.encode(passphrase),
    'PBKDF2',
    false,
    ['deriveBits']
  );

  const derivedBits = await crypto.subtle.deriveBits(
    {
      name: 'PBKDF2',
      salt: encoder.encode(`sync-e2ee:${scope}`),
      iterations: 100000,
      hash: 'SHA-256',
    },
    keyMaterial,
    256 // 32 bytes
  );

  return new Uint8Array(derivedBits);
}

interface ScopedPassphrases {
  get(scope: string): string | undefined;
  set(scope: string, passphrase: string): void;
  delete(scope: string): void;
  has(scope: string): boolean;
}

/**
 * Create a reactive passphrase store for managing per-scope passphrases.
 */
export function createPassphraseStore(): ScopedPassphrases & {
  getAll(): Map<string, string>;
  onChange(listener: () => void): () => void;
} {
  const store = new Map<string, string>();
  const listeners = new Set<() => void>();

  const notify = () => {
    for (const listener of listeners) {
      listener();
    }
  };

  return {
    get(scope: string) {
      return store.get(scope);
    },
    set(scope: string, passphrase: string) {
      store.set(scope, passphrase);
      notify();
    },
    delete(scope: string) {
      store.delete(scope);
      notify();
    },
    has(scope: string) {
      return store.has(scope);
    },
    getAll() {
      return new Map(store);
    },
    onChange(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

/**
 * Create a dynamic key provider for per-scope encryption.
 *
 * Key IDs (kid) use format: "scope:{scopeKey}" e.g., "scope:patient:max"
 */
export function createScopedKeyProvider(
  passphrases: ScopedPassphrases,
  defaultScope?: string
): FieldEncryptionKeys {
  const keyCache = new Map<string, Uint8Array>();

  return {
    async getKey(kid: string): Promise<Uint8Array> {
      // Check cache first
      const cached = keyCache.get(kid);
      if (cached) return cached;

      // Extract scope from kid (format: "scope:{scopeKey}")
      const scope = kid.replace(/^scope:/, '');
      const passphrase = passphrases.get(scope);

      if (!passphrase) {
        throw new Error(`No passphrase for scope: ${scope}`);
      }

      const key = await deriveKey(passphrase, scope);
      keyCache.set(kid, key);
      return key;
    },

    getEncryptionKid() {
      // Default scope for new encryptions
      if (defaultScope) {
        return `scope:${defaultScope}`;
      }
      throw new Error('No default scope configured for encryption');
    },
  };
}
