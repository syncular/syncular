/**
 * The demo's sync worker: the whole client core (SyncClient + transports
 * + sqlite-wasm on opfs-sahpool) runs here — the page only talks RPC
 * (Direction decision 2). Built as its own bundle (`/worker.js`) because
 * module workers do not inherit the page's import map.
 */
import { startSyncWorker } from '@syncular/client/worker';

startSyncWorker();
