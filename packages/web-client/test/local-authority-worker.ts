/**
 * The real worker entry with a §12 local authority, run inside a bun `Worker`.
 * The authority opens the replica's sibling file; bun:sqlite stands in for
 * the browser's sqlite-wasm (local-authority.test.ts covers that adapter).
 */
import { BunSqliteDatabase, openLocalAuthority } from '@syncular/server';
import { BunClientDatabase } from '../src/bun-database';
import { startSyncWorker } from '../src/worker-entry';

startSyncWorker({
  openDatabase: () => new BunClientDatabase(),
  openLocalAuthority: (database, schema) => {
    if (!(database instanceof BunClientDatabase)) {
      throw new Error('the test worker opens bun:sqlite siblings');
    }
    return openLocalAuthority({
      database: new BunSqliteDatabase(database.db),
      schema,
    });
  },
});
