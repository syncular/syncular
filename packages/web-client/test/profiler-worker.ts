/**
 * A development worker entry, run inside a bun `Worker`: the profiler wraps
 * the worker's database and transport and posts their numbers to the page.
 */
import { BunClientDatabase } from '../src/bun-database';
import { createSyncProfiler } from '../src/dev-profiler';
import { httpSyncTransport } from '../src/http';
import { startSyncWorker } from '../src/worker-remote';

const profiler = createSyncProfiler({
  channel: new BroadcastChannel('rpc-test-profile'),
});
startSyncWorker({
  openDatabase: () => profiler.database(new BunClientDatabase()),
  createTransport: (config, http) =>
    profiler.transport(httpSyncTransport(config.endpoints.syncUrl, http)),
});
