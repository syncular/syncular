/**
 * The REAL worker entry, run inside a bun `Worker` by the RPC tests —
 * same bootstrap, same protocol as the browser, with the database
 * factory indirection swapped to bun:sqlite (OPFS is browser-only; the
 * demo covers the sahpool path in a real browser).
 */
import { BunClientDatabase } from '../src/bun-database';
import { startSyncWorker } from '../src/worker-entry';

startSyncWorker({
  openDatabase: (config) => {
    if (
      config.database.mode === 'custom' &&
      config.database.options === 'fail'
    ) {
      throw new Error('simulated database open failure');
    }
    return new BunClientDatabase();
  },
});
