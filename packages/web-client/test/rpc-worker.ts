import { definePreviousVersionContext } from '../src/previous-version-context';
/**
 * The REAL worker entry, run inside a bun `Worker` by the RPC tests —
 * same bootstrap, same protocol as the browser, with the database
 * factory indirection swapped to bun:sqlite (OPFS is browser-only; the
 * opfs-bootstrap.browser.test.ts covers the sahpool path in Chromium).
 */
import { BunClientDatabase } from '../src/bun-database';
import { ClientSyncError, STORAGE_BUSY_CODE } from '../src/errors';
import { defineAuthorityReads } from '../src/authority';
import { defineOutboxControl } from '../src/outbox-control';
import { startSyncWorker } from '../src/worker-remote';

let opens = 0;
startSyncWorker({
  createAuthorityReads: defineAuthorityReads,
  createOutboxControl: defineOutboxControl,
  createPreviousVersionContext: definePreviousVersionContext,
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
    const options =
      config.database.mode === 'custom' ? config.database.options : undefined;
    // A test that counts SQLite commits gets one 'commit' message per
    // outermost transaction that committed; after a 'fail-commit' message the
    // next outermost transaction rolls back with storage.full.
    if (
      typeof options === 'object' &&
      options !== null &&
      'countCommits' in options
    )
      return new (class extends BunClientDatabase {
        #depth = 0;
        #failNext = false;
        constructor() {
          super();
          addEventListener('message', (event) => {
            if ((event as MessageEvent).data.t === 'fail-commit')
              this.#failNext = true;
          });
        }
        override transaction<T>(fn: () => T): T {
          this.#depth += 1;
          try {
            const result = super.transaction(() => {
              const value = fn();
              if (this.#depth === 1 && this.#failNext) {
                this.#failNext = false;
                throw new ClientSyncError(
                  'storage.full',
                  'simulated full disk',
                );
              }
              return value;
            });
            if (this.#depth === 1) postMessage({ t: 'commit' });
            return result;
          } finally {
            this.#depth -= 1;
          }
        }
      })();
    // A test that needs a replica on disk passes its path.
    return new BunClientDatabase(
      typeof options === 'object' && options !== null && 'path' in options
        ? String(options.path)
        : undefined,
    );
  },
});
