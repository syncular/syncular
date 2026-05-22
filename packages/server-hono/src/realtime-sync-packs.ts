import {
  type BinarySnapshotRowsEncoder,
  encodeBinarySyncPack,
  type SyncChange,
  type SyncCommit,
  type SyncPullSubscriptionResponse,
} from '@syncular/core';
import { createWireSubscriptionIntegrity } from '@syncular/server';
import type {
  WebSocketConnectionManager,
  WebSocketRealtimeSubscription,
} from './ws';

export type RealtimeSyncPackUnavailableReason =
  | 'no_subscriptions'
  | 'no_emitted_commits'
  | 'no_matching_subscription_commits';

export interface RealtimeSyncPackUnavailableEvent {
  ownerKey: string;
  reason: RealtimeSyncPackUnavailableReason;
  subscriptionCount?: number;
  emittedCommitCount?: number;
}

export interface RealtimeSyncPackEncodeFailureEvent {
  ownerKey: string;
  error: unknown;
}

export interface NotifyWebSocketConnectionsWithSyncPacksOptions {
  manager: WebSocketConnectionManager;
  partitionId?: string;
  scopeKeys: string[];
  cursor: number;
  commits: readonly SyncCommit[];
  changeRowEncoders?: Partial<Record<string, BinarySnapshotRowsEncoder>>;
  excludeClientIds?: string[];
  onPackUnavailable?: (event: RealtimeSyncPackUnavailableEvent) => void;
  onPackEncodeFailed?: (event: RealtimeSyncPackEncodeFailureEvent) => void;
}

export interface NotifyWebSocketConnectionsWithSyncPacksResult {
  scopeKeyCount: number;
  connectionCount: number;
  ownerCount: number;
  binaryPackOwnerCount: number;
  unavailableOwnerCount: number;
  encodeFailureCount: number;
  totalPayloadBytes: number;
  maxPayloadBytes: number;
  unavailableReasons: Record<RealtimeSyncPackUnavailableReason, number>;
}

interface OwnerPackBuildResult {
  bytes?: Uint8Array;
  unavailableReason?: RealtimeSyncPackUnavailableReason;
  encodeFailed?: boolean;
}

export async function notifyWebSocketConnectionsWithSyncPacks(
  args: NotifyWebSocketConnectionsWithSyncPacksOptions
): Promise<NotifyWebSocketConnectionsWithSyncPacksResult> {
  const partitionId = args.partitionId ?? 'default';
  const connections = args.manager.getConnectionsForScopeKeys(args.scopeKeys, {
    excludeClientIds: args.excludeClientIds,
  });
  const ownerKeys = new Set(
    connections.map((connection) => connection.ownerKey)
  );
  const syncPacksByOwnerKey = new Map<string, Uint8Array | undefined>();
  const result: NotifyWebSocketConnectionsWithSyncPacksResult = {
    scopeKeyCount: args.scopeKeys.length,
    connectionCount: connections.length,
    ownerCount: ownerKeys.size,
    binaryPackOwnerCount: 0,
    unavailableOwnerCount: 0,
    encodeFailureCount: 0,
    totalPayloadBytes: 0,
    maxPayloadBytes: 0,
    unavailableReasons: {
      no_subscriptions: 0,
      no_emitted_commits: 0,
      no_matching_subscription_commits: 0,
    },
  };

  await Promise.all(
    Array.from(ownerKeys).map(async (ownerKey) => {
      const built = await buildRealtimeSyncPackForOwner({
        manager: args.manager,
        partitionId,
        ownerKey,
        cursor: args.cursor,
        commits: args.commits,
        changeRowEncoders: args.changeRowEncoders,
        onPackUnavailable: args.onPackUnavailable,
        onPackEncodeFailed: args.onPackEncodeFailed,
      });

      syncPacksByOwnerKey.set(ownerKey, built.bytes);
      if (built.bytes) {
        result.binaryPackOwnerCount += 1;
        result.totalPayloadBytes += built.bytes.byteLength;
        result.maxPayloadBytes = Math.max(
          result.maxPayloadBytes,
          built.bytes.byteLength
        );
        return;
      }

      if (built.encodeFailed) {
        result.encodeFailureCount += 1;
      }
      if (built.unavailableReason) {
        result.unavailableOwnerCount += 1;
        result.unavailableReasons[built.unavailableReason] += 1;
      }
    })
  );

  args.manager.notifyScopeKeys(args.scopeKeys, args.cursor, {
    excludeClientIds: args.excludeClientIds,
    syncPackForConnection: (connection) =>
      syncPacksByOwnerKey.get(connection.ownerKey),
  });

  return result;
}

export function realtimeScopeKeysForChanges(args: {
  partitionId?: string;
  changes: readonly Pick<SyncChange, 'scopes'>[];
}): string[] {
  const partitionId = args.partitionId ?? 'default';
  return applyPartitionToRealtimeScopeKeys(
    partitionId,
    args.changes.flatMap((change) =>
      scopeValuesToRealtimeScopeKeys(change.scopes)
    )
  );
}

export function scopeValuesToRealtimeScopeKeys(scopes: unknown): string[] {
  if (!scopes || typeof scopes !== 'object') return [];
  const scopeKeys = new Set<string>();

  for (const [key, value] of Object.entries(scopes)) {
    if (!value) continue;
    const prefix = key.replace(/_id$/, '');

    if (Array.isArray(value)) {
      for (const v of value) {
        if (typeof v !== 'string') continue;
        if (!v) continue;
        scopeKeys.add(`${prefix}:${v}`);
      }
      continue;
    }

    if (typeof value === 'string') {
      if (!value) continue;
      scopeKeys.add(`${prefix}:${value}`);
      continue;
    }

    if (typeof value === 'number' || typeof value === 'bigint') {
      scopeKeys.add(`${prefix}:${String(value)}`);
    }
  }

  return Array.from(scopeKeys);
}

export function applyPartitionToRealtimeScopeKeys(
  partitionId: string,
  scopeKeys: readonly string[]
): string[] {
  const prefixed = new Set<string>();
  for (const scopeKey of scopeKeys) {
    if (!scopeKey) continue;
    if (scopeKey.startsWith(`${partitionId}::`)) {
      prefixed.add(scopeKey);
      continue;
    }
    prefixed.add(`${partitionId}::${scopeKey}`);
  }
  return Array.from(prefixed);
}

async function buildRealtimeSyncPackForOwner(args: {
  manager: WebSocketConnectionManager;
  partitionId: string;
  ownerKey: string;
  cursor: number;
  commits: readonly SyncCommit[];
  changeRowEncoders?: Partial<Record<string, BinarySnapshotRowsEncoder>>;
  onPackUnavailable?: (event: RealtimeSyncPackUnavailableEvent) => void;
  onPackEncodeFailed?: (event: RealtimeSyncPackEncodeFailureEvent) => void;
}): Promise<OwnerPackBuildResult> {
  const subscriptions = args.manager.getConnectionSubscriptions(args.ownerKey);
  if (subscriptions.length === 0) {
    args.onPackUnavailable?.({
      ownerKey: args.ownerKey,
      reason: 'no_subscriptions',
    });
    return { unavailableReason: 'no_subscriptions' };
  }
  if (args.commits.length === 0) {
    args.onPackUnavailable?.({
      ownerKey: args.ownerKey,
      reason: 'no_emitted_commits',
    });
    return { unavailableReason: 'no_emitted_commits' };
  }

  const responses: SyncPullSubscriptionResponse[] = [];
  const rootUpdates: Array<{
    subscriptionId: string;
    cursor: number;
    verifiedRoot: string;
  }> = [];
  for (const subscription of subscriptions) {
    const commits = selectRealtimeCommitsForSubscription(
      args.partitionId,
      args.commits,
      subscription
    );
    if (commits.length === 0) continue;

    const integrity = await createWireSubscriptionIntegrity({
      partitionId: args.partitionId,
      subscriptionId: subscription.id,
      previousRoot: subscription.verifiedRoot,
      commits,
    });
    const nextCursor = Math.max(args.cursor, subscription.cursor);
    if (integrity) {
      rootUpdates.push({
        subscriptionId: subscription.id,
        cursor: nextCursor,
        verifiedRoot: integrity.commitChainRoot,
      });
    }

    responses.push({
      id: subscription.id,
      status: 'active',
      scopes: subscription.scopes,
      bootstrap: false,
      bootstrapState: null,
      nextCursor,
      ...(integrity ? { integrity } : {}),
      commits,
    });
  }

  if (responses.length === 0) {
    args.onPackUnavailable?.({
      ownerKey: args.ownerKey,
      reason: 'no_matching_subscription_commits',
      subscriptionCount: subscriptions.length,
      emittedCommitCount: args.commits.length,
    });
    return { unavailableReason: 'no_matching_subscription_commits' };
  }

  try {
    const bytes = encodeBinarySyncPack(
      {
        ok: true as const,
        pull: {
          ok: true as const,
          subscriptions: responses,
        },
      },
      {
        changeRowEncoders: args.changeRowEncoders,
      }
    );
    args.manager.updateConnectionSubscriptionRoots(args.ownerKey, rootUpdates);
    return { bytes };
  } catch (error) {
    args.onPackEncodeFailed?.({ ownerKey: args.ownerKey, error });
    return { encodeFailed: true };
  }
}

function selectRealtimeCommitsForSubscription(
  partitionId: string,
  commits: readonly SyncCommit[],
  subscription: WebSocketRealtimeSubscription
): SyncCommit[] {
  const scopeKeys = new Set(subscription.scopeKeys);
  if (scopeKeys.size === 0) return [];

  const selected: SyncCommit[] = [];
  for (const commit of commits) {
    const changes = commit.changes.filter((change) =>
      changeMatchesRealtimeSubscription(partitionId, change, scopeKeys)
    );
    if (changes.length === 0) continue;
    selected.push({ ...commit, changes });
  }
  return selected;
}

function changeMatchesRealtimeSubscription(
  partitionId: string,
  change: SyncChange,
  scopeKeys: Set<string>
): boolean {
  for (const scopeKey of applyPartitionToRealtimeScopeKeys(
    partitionId,
    scopeValuesToRealtimeScopeKeys(change.scopes)
  )) {
    if (scopeKeys.has(scopeKey)) return true;
  }
  return false;
}
