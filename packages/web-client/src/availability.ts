import type { SyncStatusSnapshot } from './invalidation';
import type { LeadershipState } from './multi-tab';

export type SyncAvailability =
  | { readonly state: 'ready' }
  | { readonly state: 'migrating'; readonly currentSchemaVersion: number }
  | {
      readonly state: 'blocked';
      readonly reason:
        | 'client-upgrade-required'
        | 'server-behind'
        | 'incompatible-schema'
        | 'leader-unreachable';
      readonly currentSchemaVersion: number;
      readonly requiredSchemaVersion?: number;
      readonly latestServerSchemaVersion?: number;
      readonly retryable: boolean;
    };

/** Classify schema and browser-ownership state without parsing diagnostics. */
export function classifySyncAvailability(
  status: SyncStatusSnapshot,
  leadership?: LeadershipState,
): SyncAvailability {
  const currentSchemaVersion = status.currentSchemaVersion;
  if (leadership?.state === 'blocked') {
    return {
      state: 'blocked',
      reason: 'leader-unreachable',
      currentSchemaVersion,
      retryable: true,
    };
  }
  const required = status.schemaFloor?.requiredSchemaVersion;
  const latest = status.schemaFloor?.latestSchemaVersion;
  if (required !== undefined && required > currentSchemaVersion) {
    return {
      state: 'blocked',
      reason: 'client-upgrade-required',
      currentSchemaVersion,
      requiredSchemaVersion: required,
      ...(latest !== undefined ? { latestServerSchemaVersion: latest } : {}),
      retryable: false,
    };
  }
  if (latest !== undefined && latest < currentSchemaVersion) {
    return {
      state: 'blocked',
      reason: 'server-behind',
      currentSchemaVersion,
      ...(required !== undefined ? { requiredSchemaVersion: required } : {}),
      latestServerSchemaVersion: latest,
      retryable: false,
    };
  }
  if (status.schemaFloor !== undefined) {
    return {
      state: 'blocked',
      reason: 'incompatible-schema',
      currentSchemaVersion,
      ...(required !== undefined ? { requiredSchemaVersion: required } : {}),
      ...(latest !== undefined ? { latestServerSchemaVersion: latest } : {}),
      retryable: false,
    };
  }
  if (status.upgrading) {
    return { state: 'migrating', currentSchemaVersion };
  }
  return { state: 'ready' };
}
