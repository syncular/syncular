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
        | 'leader-unreachable'
        | 'leader-incompatible';
      readonly currentSchemaVersion: number;
      /** `leader-incompatible`: whether the tab holding the database runs an
       * older or a newer build than this one. */
      readonly leader?: 'older' | 'newer';
      readonly requiredSchemaVersion?: number;
      readonly latestServerSchemaVersion?: number;
      readonly retryable: boolean;
    };

/** The availability of a tab whose leader link is blocked. */
export function blockedLeadershipAvailability(
  leadership: Extract<LeadershipState, { state: 'blocked' }>,
  currentSchemaVersion: number,
): SyncAvailability {
  return leadership.reason === 'leader-incompatible'
    ? {
        state: 'blocked',
        reason: 'leader-incompatible',
        currentSchemaVersion,
        leader: leadership.leader,
        retryable: true,
      }
    : {
        state: 'blocked',
        reason: 'leader-unreachable',
        currentSchemaVersion,
        retryable: true,
      };
}

/** Classify schema and browser-ownership state without parsing diagnostics. */
export function classifySyncAvailability(
  status: SyncStatusSnapshot,
  leadership?: LeadershipState,
): SyncAvailability {
  const currentSchemaVersion = status.currentSchemaVersion;
  if (leadership?.state === 'blocked') {
    return blockedLeadershipAvailability(leadership, currentSchemaVersion);
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
