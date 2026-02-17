import {
  isRecord,
  type SyncChange,
  type SyncPullResponse,
} from '@syncular/core';

export type SyncChangeRecord = SyncChange;

export type SyncSubscriptionRecord = Pick<
  SyncPullResponse['subscriptions'][number],
  'id' | 'commits'
>;

export function subscriptionChanges(
  subscriptions: SyncSubscriptionRecord[] | undefined,
  subscriptionId: string
): SyncChangeRecord[] {
  const subscription = subscriptions?.find(
    (item) => item.id === subscriptionId
  );
  if (!subscription) {
    return [];
  }

  return subscription.commits?.flatMap((commit) => commit.changes) ?? [];
}

export function findSubscriptionChange(
  subscriptions: SyncSubscriptionRecord[] | undefined,
  subscriptionId: string,
  rowId: string
): SyncChangeRecord | undefined {
  const changes = subscriptionChanges(subscriptions, subscriptionId);
  return changes.find((change) => change.row_id === rowId);
}

export function subscriptionChangeRow(
  change: SyncChangeRecord | undefined
): Record<string, unknown> | undefined {
  if (!change) {
    return undefined;
  }

  return isRecord(change.row_json) ? change.row_json : undefined;
}
