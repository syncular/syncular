/**
 * @syncular/demo - wa-sqlite client factory
 *
 * Uses wa-sqlite with OPFS persistence for browser SQLite.
 */

import { createWaSqliteDb } from '@syncular/dialect-wa-sqlite';
import type { Kysely } from 'kysely';
import type { ClientDb } from './types.generated';

class WaSqliteRuntimeSupportError extends Error {
  readonly issues: readonly string[];

  constructor(issues: readonly string[]) {
    super(
      `[wa-sqlite] Browser runtime requirements not met: ${issues.join('; ')}`
    );
    this.name = 'WaSqliteRuntimeSupportError';
    this.issues = issues;
  }
}

function supportsModuleWorkers(): boolean {
  if (typeof Worker === 'undefined') return false;

  let supports = false;
  try {
    // Feature-detect `type: "module"` support.
    const options = {
      get type() {
        supports = true;
        return 'module';
      },
    };
    new Worker('data:,', options as WorkerOptions).terminate();
  } catch {
    return false;
  }
  return supports;
}

function collectRuntimeIssues(): string[] {
  const issues: string[] = [];

  if (typeof window === 'undefined') {
    issues.push('window is unavailable');
    return issues;
  }

  if (!window.isSecureContext) {
    issues.push('secure context required (HTTPS or localhost)');
  }

  if (typeof Worker === 'undefined') {
    issues.push('Web Worker API unavailable');
  } else if (!supportsModuleWorkers()) {
    issues.push('module workers are unsupported');
  }

  if (typeof indexedDB === 'undefined') {
    issues.push('IndexedDB unavailable');
  }

  if (typeof navigator === 'undefined' || !('locks' in navigator)) {
    issues.push('Web Locks API unavailable');
  }

  return issues;
}

function assertWaSqliteRuntimeSupport(): void {
  const issues = collectRuntimeIssues();
  if (issues.length > 0) {
    throw new WaSqliteRuntimeSupportError(issues);
  }
}

/**
 * Create a wa-sqlite client database
 */
export function createSqliteClient(fileName: string): Kysely<ClientDb> {
  assertWaSqliteRuntimeSupport();
  return createWaSqliteDb<ClientDb>({
    fileName,
    preferOPFS: true,
    url: (useAsyncWasm) =>
      `${window.location.origin}/__demo/wasqlite/${useAsyncWasm ? 'wa-sqlite-async.wasm' : 'wa-sqlite.wasm'}`,
    worker: () =>
      new Worker(`${window.location.origin}/__demo/wasqlite/worker.js`, {
        type: 'module',
        credentials: 'same-origin',
      }),
  });
}
