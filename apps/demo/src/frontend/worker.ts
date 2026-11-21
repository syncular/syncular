/**
 * The demo's sync worker: the whole client core (SyncClient + transports
 * + sqlite-wasm on opfs-sahpool) runs here — the page only talks RPC
 * Built as its own bundle (`/worker.js`) because
 * module workers do not inherit the page's import map. The page names the
 * demo actor in the worker URL; the worker's header source sends it.
 */
import { startSyncWorker } from '@syncular/client/worker';

const actor = new URL(self.location.href).searchParams.get('actor');
startSyncWorker({
  headers: () => (actor === null ? {} : { 'x-syncular-demo-actor': actor }),
});
