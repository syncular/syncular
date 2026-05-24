import type {
  ResolvedSyncularClientConfig,
  SyncularClientConfig,
  SyncularStorage,
} from './types';

export const SYNCULAR_DEFAULT_STORAGE = 'opfsSahPool' satisfies SyncularStorage;
export const SYNCULAR_LOCAL_DISABLED_BASE_URL = 'syncular-local://disabled';

export function resolveSyncularClientConfig(
  config: SyncularClientConfig
): ResolvedSyncularClientConfig {
  const mode = config.mode ?? 'remote';
  if (mode === 'remote' && !config.baseUrl) {
    throw new Error('Syncular remote clients require config.baseUrl');
  }
  return {
    ...config,
    mode,
    baseUrl: config.baseUrl ?? SYNCULAR_LOCAL_DISABLED_BASE_URL,
    storage: config.storage ?? SYNCULAR_DEFAULT_STORAGE,
  };
}

export function isSyncularRemoteMode(
  config: Pick<ResolvedSyncularClientConfig, 'mode'>
): boolean {
  return config.mode === 'remote';
}
