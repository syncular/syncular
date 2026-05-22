import type { SyncularClientConfig, SyncularStorage } from './types';

export const SYNCULAR_DEFAULT_STORAGE = 'opfsSahPool' satisfies SyncularStorage;

export function resolveSyncularClientConfig(
  config: SyncularClientConfig
): SyncularClientConfig {
  return {
    ...config,
    storage: config.storage ?? SYNCULAR_DEFAULT_STORAGE,
  };
}
