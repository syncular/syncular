/** Browser half of the apply-rows lane: the OPFS SAH-pool replica in a worker. */
import { openPersistentWasmDatabase } from '../../packages/web-client/src/wasm-database';
import { runApplyRows, runClientApply } from './apply-rows-fixture';

const scope = globalThis as typeof globalThis & {
  postMessage(message: unknown): void;
};

scope.onmessage = async (event: MessageEvent) => {
  try {
    const database = await openPersistentWasmDatabase(event.data.name);
    const input = event.data;
    const result =
      input.client === undefined
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
