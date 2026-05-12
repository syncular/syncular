import type { SyncOperation } from '../../../../packages/core/src/index';
import {
  createSyncularRustOwnedSqlite,
  type SyncularRustOwnedSqlite,
} from '../../../../rust/bindings/browser/src/index';

type WorkerRequest =
  | {
      id: number;
      type: 'open';
      fileName: string;
      storage: 'memory' | 'indexedDb' | 'opfsSahPool';
      clearOnInit?: boolean;
    }
  | {
      id: number;
      type: 'applyBatch';
      operations: Array<{
        operation: SyncOperation;
        localRow?: unknown | null;
      }>;
    }
  | {
      id: number;
      type: 'countRows';
      table: string;
    }
  | {
      id: number;
      type: 'close';
    };

type WorkerResponse =
  | { id: number; ok: true; value?: unknown }
  | { id: number; ok: false; error: string };

let db: SyncularRustOwnedSqlite | undefined;

self.onmessage = (event: MessageEvent<WorkerRequest>) => {
  void handleRequest(event.data);
};

async function handleRequest(request: WorkerRequest): Promise<void> {
  try {
    const value = await dispatch(request);
    post({ id: request.id, ok: true, value });
  } catch (err) {
    post({
      id: request.id,
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

async function dispatch(request: WorkerRequest): Promise<unknown> {
  switch (request.type) {
    case 'open': {
      db?.close();
      db = await createSyncularRustOwnedSqlite({
        config: {
          fileName: request.fileName,
          storage: request.storage,
          clearOnInit: request.clearOnInit ?? false,
        },
      });
      return true;
    }
    case 'applyBatch':
      return requireDb().applyLocalOperationsBatch(request.operations);
    case 'countRows':
      return requireDb().countRows(request.table);
    case 'close':
      db?.close();
      db = undefined;
      return true;
  }
}

function requireDb(): SyncularRustOwnedSqlite {
  if (!db) throw new Error('Rust-owned SQLite worker database is not open');
  return db;
}

function post(response: WorkerResponse): void {
  self.postMessage(response);
}
