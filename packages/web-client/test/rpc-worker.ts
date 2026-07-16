/**
 * The REAL worker entry, run inside a bun `Worker` by the RPC tests —
 * same bootstrap, same protocol as the browser, with the database
 * factory indirection swapped to bun:sqlite (OPFS is browser-only; the
 * demo covers the sahpool path in a real browser).
 */
import { BunClientDatabase } from '../src/bun-database';
import { ClientSyncError, STORAGE_BUSY_CODE } from '../src/errors';
import { startSyncWorker } from '../src/worker-entry';

startSyncWorker({
  openDatabase: (config) => {
    if (
      config.database.mode === 'custom' &&
      config.database.options === 'fail'
    ) {
      throw new Error('simulated database open failure');
    }
    if (
      config.database.mode === 'custom' &&
      config.database.options === 'storage-busy'
    ) {
      throw new ClientSyncError(
        STORAGE_BUSY_CODE,
        'simulated persistent storage owner',
        true,
      );
    }
    return new BunClientDatabase();
  },
});
