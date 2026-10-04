import { startSyncWorker } from '../src/worker-entry';

startSyncWorker({
  openDatabase: () => {
    throw new Error('authority opt-in refusal must precede opening storage');
  },
});
