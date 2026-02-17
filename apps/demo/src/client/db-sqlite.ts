/**
 * @syncular/demo - wa-sqlite client factory
 *
 * Uses wa-sqlite with OPFS persistence for browser SQLite.
 */

import { createWaSqliteDb } from '@syncular/dialect-wa-sqlite';
import type { Kysely } from 'kysely';
import type { ClientDb } from './types.generated';

/**
 * Create a wa-sqlite client database
 */
export function createSqliteClient(fileName: string): Kysely<ClientDb> {
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
