import type { SyncularV2ClientConfig, SyncularV2Storage } from './types';

export const SYNCULAR_V2_DEFAULT_STORAGE =
  'opfsSahPool' satisfies SyncularV2Storage;

export function resolveSyncularV2ClientConfig(
  config: SyncularV2ClientConfig
): SyncularV2ClientConfig {
  return {
    ...config,
    storage: config.storage ?? SYNCULAR_V2_DEFAULT_STORAGE,
  };
}
