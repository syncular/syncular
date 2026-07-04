/**
 * The sync worker: the whole client core runs here (Direction decision 2);
 * the React page talks RPC through the `SyncClientHandle`. Built as its own
 * bundle because module workers do not inherit the page's import map.
 */
import { startSyncWorker } from '@syncular-v2/web-client/worker';

startSyncWorker();
