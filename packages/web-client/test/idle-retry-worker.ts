/**
 * The real worker entry whose first drive ends on the §7.7 deadline, with
 * the host loop's background deadline crossing to the test process. The test
 * observes the retry the loop schedules and fires it without a timer.
 */
import { BunClientDatabase } from '../src/bun-database';
import { SyncClient } from '../src/client';
import { ClientSyncError } from '../src/errors';
import { startSyncWorker } from '../src/worker-entry';

const drive = SyncClient.prototype.syncUntilIdle;
let expire = true;
SyncClient.prototype.syncUntilIdle = function (this: SyncClient, options) {
  if (!expire) return drive.call(this, options);
  expire = false;
  return Promise.reject(
    new ClientSyncError(
      'sync.idle_timeout',
      'syncUntilIdle exceeded its deadline',
      true,
      { timeoutMs: 60_000, rounds: 1 },
    ),
  );
};

const deadlines: Array<() => void> = [];
addEventListener('message', (event) => {
  if ((event.data as { readonly t?: string }).t === 'fire-background')
    deadlines.shift()?.();
});

startSyncWorker({
  openDatabase: () => new BunClientDatabase(),
  scheduleBackground: (callback, delayMs) => {
    deadlines.push(callback);
    postMessage({ t: 'background', delayMs });
    return () => {
      const index = deadlines.indexOf(callback);
      if (index >= 0) deadlines.splice(index, 1);
    };
  },
});
