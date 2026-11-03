import { startSyncWorkerCore, type SyncWorkerOverrides } from './worker-core';

/** Worker overrides for a host that uses only a remote sync authority. */
export type RemoteSyncWorkerOverrides = Omit<
  SyncWorkerOverrides,
  'openLocalAuthority'
>;

/** Start a worker without the optional local-authority lifecycle (§12). */
export function startSyncWorker(
  overrides: RemoteSyncWorkerOverrides = {},
): void {
  startSyncWorkerCore(overrides);
}
