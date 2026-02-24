/**
 * @syncular/demo - PGlite client factory
 *
 * Uses PGlite with IndexedDB persistence for browser Postgres.
 */

import { createPgliteDialectWithLive } from '@syncular/dialect-pglite';
import type { Kysely } from 'kysely';
import type { ClientDb } from './types.generated';

const DEFAULT_PGLITE_DATA_DIR = 'idb://sync-demo-pglite';
const ACTIVE_DATA_DIR_KEY_PREFIX = 'sync-demo:pglite:active-data-dir:';

let assetsPromise: Promise<{
  fsBundle: Blob;
  wasmModule: WebAssembly.Module;
}> | null = null;

const inMemoryActiveDataDir = new Map<string, string>();

function getStorage(): Storage | null {
  if (typeof window === 'undefined') return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function activeDataDirStorageKey(baseDataDir: string): string {
  return `${ACTIVE_DATA_DIR_KEY_PREFIX}${encodeURIComponent(baseDataDir)}`;
}

function readStoredActiveDataDir(baseDataDir: string): string | null {
  const storage = getStorage();
  if (!storage) return null;
  try {
    return storage.getItem(activeDataDirStorageKey(baseDataDir));
  } catch {
    return null;
  }
}

function writeStoredActiveDataDir(
  baseDataDir: string,
  activeDataDir: string
): void {
  const storage = getStorage();
  if (!storage) return;
  try {
    storage.setItem(activeDataDirStorageKey(baseDataDir), activeDataDir);
  } catch {
    // Best-effort only; in-memory fallback still works for this tab.
  }
}

function normalizeBaseDataDir(dataDir?: string): string {
  return dataDir ?? DEFAULT_PGLITE_DATA_DIR;
}

interface PgliteDataDirState {
  baseDataDir: string;
  activeDataDir: string;
  usesRecoveryDataDir: boolean;
}

export function getPgliteDataDirState(dataDir?: string): PgliteDataDirState {
  const baseDataDir = normalizeBaseDataDir(dataDir);
  const activeDataDir =
    inMemoryActiveDataDir.get(baseDataDir) ??
    readStoredActiveDataDir(baseDataDir) ??
    baseDataDir;
  return {
    baseDataDir,
    activeDataDir,
    usesRecoveryDataDir: activeDataDir !== baseDataDir,
  };
}

export function rotatePgliteDataDir(dataDir?: string): PgliteDataDirState {
  const { baseDataDir } = getPgliteDataDirState(dataDir);
  const rotatedDataDir = `${baseDataDir}::recovery-${Date.now()}`;
  inMemoryActiveDataDir.set(baseDataDir, rotatedDataDir);
  writeStoredActiveDataDir(baseDataDir, rotatedDataDir);
  return {
    baseDataDir,
    activeDataDir: rotatedDataDir,
    usesRecoveryDataDir: true,
  };
}

export class PgliteClientInitializationError extends Error {
  readonly baseDataDir: string;
  readonly activeDataDir: string;
  readonly causeError: unknown;

  constructor(args: {
    baseDataDir: string;
    activeDataDir: string;
    causeError: unknown;
  }) {
    const detail =
      args.causeError instanceof Error
        ? args.causeError.message
        : String(args.causeError);
    super(detail);
    this.name = 'PgliteClientInitializationError';
    this.baseDataDir = args.baseDataDir;
    this.activeDataDir = args.activeDataDir;
    this.causeError = args.causeError;
  }
}

async function loadPgliteAssets(): Promise<{
  fsBundle: Blob;
  wasmModule: WebAssembly.Module;
}> {
  if (assetsPromise) return assetsPromise;

  assetsPromise = (async () => {
    const dataUrl = `${window.location.origin}/__demo/pglite/pglite.data`;
    const wasmUrl = `${window.location.origin}/__demo/pglite/pglite.wasm`;

    const [fsBundleBuffer, wasmBuffer] = await Promise.all([
      fetch(dataUrl).then(async (r) => {
        if (!r.ok) {
          throw new Error(
            `Failed to fetch pglite.data: ${r.status} ${r.statusText}`
          );
        }
        return await r.arrayBuffer();
      }),
      fetch(wasmUrl).then(async (r) => {
        if (!r.ok) {
          throw new Error(
            `Failed to fetch pglite.wasm: ${r.status} ${r.statusText}`
          );
        }
        return await r.arrayBuffer();
      }),
    ]);

    const fsBundle = new Blob([fsBundleBuffer]);
    const wasmModule = await WebAssembly.compile(wasmBuffer);

    return { fsBundle, wasmModule };
  })();

  return assetsPromise;
}

/**
 * Create a PGlite client database (async to wait for database ready).
 */
export async function createPgliteClient(
  dataDir?: string
): Promise<Kysely<ClientDb>> {
  const { baseDataDir, activeDataDir } = getPgliteDataDirState(dataDir);
  const { fsBundle, wasmModule } = await loadPgliteAssets();
  try {
    const db = await createPgliteDialectWithLive<ClientDb>({
      dataDir: activeDataDir,
      fsBundle,
      wasmModule,
    });
    return db;
  } catch (causeError) {
    throw new PgliteClientInitializationError({
      baseDataDir,
      activeDataDir,
      causeError,
    });
  }
}
