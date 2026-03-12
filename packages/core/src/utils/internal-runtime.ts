interface BunCryptoHasher {
  update(data: string | Uint8Array): void;
  digest(encoding: 'hex'): string;
}

interface BunRuntime {
  CryptoHasher?: new (algorithm: string) => BunCryptoHasher;
  gzipSync?: (data: Uint8Array) => Uint8Array;
  gunzipSync?: (data: Uint8Array) => Uint8Array;
  readableStreamToBytes?: (
    stream: ReadableStream<Uint8Array>
  ) => Promise<Uint8Array | ArrayBuffer>;
}

type RuntimeGlobals = typeof globalThis & {
  Bun?: BunRuntime;
  Deno?: object;
  process?: {
    versions?: {
      node?: string;
    };
  };
};

function getRuntimeGlobals(): RuntimeGlobals {
  return globalThis as RuntimeGlobals;
}

export function getBunRuntime(): BunRuntime | null {
  return getRuntimeGlobals().Bun ?? null;
}

export function usesNodeRuntimeModules(): boolean {
  const globals = getRuntimeGlobals();
  if (globals.Deno !== undefined) {
    return true;
  }
  return typeof globals.process?.versions?.node === 'string';
}
