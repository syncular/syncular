import { concatByteChunks } from './bytes';
import { getBunRuntime, usesNodeRuntimeModules } from './internal-runtime';

const textEncoder = new TextEncoder();
type NodeCryptoModule = typeof import('node:crypto');

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

function toDigestBufferSource(payload: Uint8Array): Uint8Array<ArrayBuffer> {
  if (payload.buffer instanceof ArrayBuffer) {
    return new Uint8Array(
      payload.buffer,
      payload.byteOffset,
      payload.byteLength
    );
  }

  const owned = new Uint8Array(payload.byteLength);
  owned.set(payload);
  return owned;
}

let nodeCryptoModulePromise: Promise<NodeCryptoModule | null> | null = null;

function importNodeModule(specifier: string): Promise<unknown> {
  return new Function('specifier', 'return import(specifier);')(
    specifier
  ) as Promise<unknown>;
}

function tryImportNodeModule(specifier: string): Promise<unknown> {
  try {
    return importNodeModule(specifier);
  } catch {
    return Promise.resolve(null);
  }
}

async function getNodeCryptoModule(): Promise<NodeCryptoModule | null> {
  if (!usesNodeRuntimeModules()) {
    return null;
  }
  if (!nodeCryptoModulePromise) {
    nodeCryptoModulePromise = tryImportNodeModule('node:crypto')
      .then((module) => module as NodeCryptoModule)
      .catch(() => null);
  }
  return nodeCryptoModulePromise;
}

export interface IncrementalSha256 {
  update(chunk: Uint8Array): void;
  digestHex(): Promise<string>;
}

export async function createIncrementalSha256(): Promise<IncrementalSha256> {
  const bun = getBunRuntime();
  if (bun?.CryptoHasher) {
    const hasher = new bun.CryptoHasher('sha256');
    return {
      update(chunk) {
        hasher.update(chunk);
      },
      async digestHex() {
        return hasher.digest('hex');
      },
    };
  }

  const nodeCrypto = await getNodeCryptoModule();
  if (nodeCrypto?.createHash) {
    const hasher = nodeCrypto.createHash('sha256');
    return {
      update(chunk) {
        hasher.update(chunk);
      },
      async digestHex() {
        return hasher.digest('hex');
      },
    };
  }

  const chunks: Uint8Array[] = [];
  return {
    update(chunk) {
      if (chunk.length === 0) return;
      chunks.push(chunk.slice());
    },
    async digestHex() {
      return sha256Hex(concatByteChunks(chunks));
    },
  };
}

/**
 * Cross-runtime SHA-256 digest helper.
 *
 * Uses native Bun/Node implementations on server runtimes, with Web Crypto
 * fallback for browser and worker environments.
 */
export async function sha256Hex(input: string | Uint8Array): Promise<string> {
  const payload = typeof input === 'string' ? textEncoder.encode(input) : input;

  const bun = getBunRuntime();
  if (bun?.CryptoHasher) {
    const hasher = new bun.CryptoHasher('sha256');
    hasher.update(payload);
    return hasher.digest('hex');
  }

  const nodeCrypto = await getNodeCryptoModule();
  if (nodeCrypto?.createHash) {
    return nodeCrypto.createHash('sha256').update(payload).digest('hex');
  }

  if (typeof crypto !== 'undefined' && crypto.subtle) {
    const digestBuffer = await crypto.subtle.digest(
      'SHA-256',
      toDigestBufferSource(payload)
    );
    return toHex(new Uint8Array(digestBuffer));
  }

  throw new Error(
    'Failed to create SHA-256 hash, no crypto implementation available'
  );
}
