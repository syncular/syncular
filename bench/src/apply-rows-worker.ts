/** Browser half of the apply-rows lane: the OPFS SAH-pool replica in a worker. */
import { openPersistentWasmDatabase } from '../../packages/web-client/src/wasm-database';
import {
  runApplyRows,
  runClientApply,
  runPlan,
  type SahStats,
} from './apply-rows-fixture';

const scope = globalThis as typeof globalThis & {
  postMessage(message: unknown): void;
};

const calls = ['read', 'write', 'flush', 'getSize', 'truncate'] as const;
const stats = Object.fromEntries(
  calls.map((call) => [call, { calls: 0, ms: 0 }]),
) as SahStats;
// Patched before the database opens so the pool's handles count every call.
const prototype = FileSystemSyncAccessHandle.prototype;
for (const call of calls) {
  const original = prototype[call] as (...args: unknown[]) => unknown;
  Object.defineProperty(prototype, call, {
    value(this: FileSystemSyncAccessHandle, ...args: unknown[]) {
      const started = performance.now();
      try {
        return original.apply(this, args);
      } finally {
        stats[call].calls++;
        stats[call].ms += performance.now() - started;
      }
    },
  });
}
const sah = {
  reset() {
    for (const call of calls) stats[call] = { calls: 0, ms: 0 };
  },
  read(): SahStats {
    return Object.fromEntries(
      calls.map((call) => [
        call,
        { calls: stats[call].calls, ms: Math.round(stats[call].ms * 10) / 10 },
      ]),
    ) as SahStats;
  },
};

scope.onmessage = async (event: MessageEvent) => {
  try {
    const database = await openPersistentWasmDatabase(event.data.name);
    const input = event.data;
    const result = input.plan
      ? await runPlan(database, sah)
      : input.client === undefined
        ? await runApplyRows(database, input.rows, input.retained)
        : await runClientApply(
            database,
            input.client.columns,
            input.client.indexes,
            input.rows,
            input.client.segments,
            input.client.encrypted,
            input.client.key,
          );
    database.close();
    scope.postMessage({ t: 'done', value: result });
  } catch (error) {
    scope.postMessage({
      t: 'error',
      message:
        error instanceof Error ? (error.stack ?? error.message) : String(error),
    });
  }
};
