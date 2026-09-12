/**
 * The REAL worker entry, run inside a bun `Worker` by the RPC tests —
 * same bootstrap, same protocol as the browser, with the database
 * factory indirection swapped to bun:sqlite (OPFS is browser-only; the
 * opfs-bootstrap.browser.test.ts covers the sahpool path in Chromium).
 */
import { BunClientDatabase } from '../src/bun-database';
import { ClientSyncError, STORAGE_BUSY_CODE } from '../src/errors';
import { startSyncWorker } from '../src/worker-entry';

let opens = 0;
startSyncWorker({
  waitForStorageRetry: async (delayMs) => {
    postMessage({ t: 'storage-retry', delayMs });
  },
  openDatabase: (config) => {
    opens++;
    postMessage({ t: 'storage-open', attempt: opens });
    if (config.database.mode === 'persistent') {
      const name = config.database.name;
      if (name === 'storage-failed') throw new Error('storage failed');
      if (
        name === 'storage-busy' ||
        (name === 'storage-busy-final' && opens < 7) ||
        (name === 'storage-busy-once' && opens < 2) ||
        name === 'storage-busy-permanent'
      ) {
        throw new ClientSyncError(
          STORAGE_BUSY_CODE,
          'simulated persistent storage owner',
          name !== 'storage-busy-permanent',
        );
      }
    }
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
