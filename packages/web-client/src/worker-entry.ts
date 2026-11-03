import { startSyncWorkerCore, type SyncWorkerOverrides } from './worker-core';
import { createWorkerLocalAuthority } from './worker-local-authority';

export type { SyncWorkerOverrides, WorkerLocalAuthority } from './worker-core';

/** Start a worker that supports the optional local authority (§12). */
export function startSyncWorker(overrides: SyncWorkerOverrides = {}): void {
  startSyncWorkerCore(overrides, createWorkerLocalAuthority);
}
