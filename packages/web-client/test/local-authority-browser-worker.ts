/**
 * The guide's browser worker entry for a §12 local authority, run in a real
 * Web Worker over OPFS. Two test probes ride beside it: the authority's own
 * database connection, captured as the worker opens it, and the replica's SAH
 * pool util, recorded by the `local-authority-sqlite.js` shim the test serves
 * in place of `@sqlite.org/sqlite-wasm`.
 */
import type { SAHPoolUtil } from '@sqlite.org/sqlite-wasm';
import type { ClientDatabase } from '@syncular/client';
import { startSyncWorker } from '@syncular/client/worker';
import { clientSqliteDatabase, openLocalAuthority } from '@syncular/server';
import {
  LOCAL_AUTHORITY_DATABASE,
  type LocalAuthorityProbe,
} from './local-authority-browser-fixture';

const scope = globalThis as typeof globalThis & {
  __sahPools?: Map<string, SAHPoolUtil>;
  postMessage(message: unknown): void;
};
let authorityDatabase: ClientDatabase | undefined;

scope.addEventListener('message', (event: MessageEvent) => {
  if ((event.data as { t?: string } | null)?.t !== 'probe') return;
  try {
    const pool = scope.__sahPools?.get(`.syncular/${LOCAL_AUTHORITY_DATABASE}`);
    if (pool === undefined || authorityDatabase === undefined)
      throw new Error('the worker opened no OPFS replica with an authority');
    const probe: LocalAuthorityProbe = {
      files: pool.getFileNames().sort(),
      authorityTables: authorityDatabase
        .query(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
        )
        .map((row) => String(row.name)),
    };
    scope.postMessage({ t: 'probe-result', probe });
  } catch (error) {
    scope.postMessage({ t: 'probe-error', message: String(error) });
  }
});

startSyncWorker({
  openLocalAuthority: (database, schema) => {
    authorityDatabase = database;
    return openLocalAuthority({
      database: clientSqliteDatabase(database),
      schema,
    });
  },
});
