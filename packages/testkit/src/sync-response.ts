import {
  isRecord,
  type SyncChange,
  type SyncCombinedResponse,
  type SyncOperationResult,
  type SyncPullResponse,
  type SyncPullSubscriptionResponse,
  type SyncPushBatchCommitResponse,
  type SyncPushBatchResponse,
} from '@syncular/core';

export type SyncPushErrorResult = SyncOperationResult & {
  status: 'error';
};

export type SyncRevokedSubscription = SyncPullSubscriptionResponse & {
  status: 'revoked';
};

export type SyncSubscriptionRecord = Pick<
  SyncPullResponse['subscriptions'][number],
  'id' | 'commits'
>;

export interface SyncPushResultSelector {
  clientCommitId: string;
  opIndex?: number;
}

export function findPushCommit(
  push: SyncCombinedResponse['push'] | SyncPushBatchResponse | undefined,
  clientCommitId: string
): SyncPushBatchCommitResponse | undefined {
  return push?.commits.find(
    (commit) => commit.clientCommitId === clientCommitId
  );
}

export function requirePushCommit(
  push: SyncCombinedResponse['push'] | SyncPushBatchResponse | undefined,
  clientCommitId: string
): SyncPushBatchCommitResponse {
  const commit = findPushCommit(push, clientCommitId);
  if (commit) return commit;
  const observed =
    push?.commits.map((item) => item.clientCommitId).join(', ') ?? '';
  throw new Error(
    `Expected Syncular push commit "${clientCommitId}" but observed: ${observed || 'none'}`
  );
}

export function findPushOperationResult(
  push: SyncCombinedResponse['push'] | SyncPushBatchResponse | undefined,
  selector: SyncPushResultSelector
): SyncOperationResult | undefined {
  const commit = findPushCommit(push, selector.clientCommitId);
  const opIndex = selector.opIndex ?? 0;
  return commit?.results.find((result) => result.opIndex === opIndex);
}

export function requirePushOperationResult(
  push: SyncCombinedResponse['push'] | SyncPushBatchResponse | undefined,
  selector: SyncPushResultSelector
): SyncOperationResult {
  const result = findPushOperationResult(push, selector);
  if (result) return result;
  const commit = findPushCommit(push, selector.clientCommitId);
  const observed =
    commit?.results
      .map((item) => `${item.opIndex}:${item.status}`)
      .join(', ') ?? '';
  throw new Error(
    `Expected Syncular push result "${selector.clientCommitId}" op ${selector.opIndex ?? 0} but observed: ${observed || 'none'}`
  );
}

export function requirePushErrorCode(
  push: SyncCombinedResponse['push'] | SyncPushBatchResponse | undefined,
  selector: SyncPushResultSelector & { code: string }
): SyncPushErrorResult {
  const result = requirePushOperationResult(push, selector);
  if (result.status === 'error' && result.code === selector.code) {
    return result as SyncPushErrorResult;
  }
  const code =
    result.status === 'error' || result.status === 'conflict'
      ? (result.code ?? 'uncoded')
      : 'applied';
  throw new Error(
    `Expected Syncular push result "${selector.clientCommitId}" op ${selector.opIndex ?? 0} to be error code "${selector.code}" but observed ${result.status}:${code}`
  );
}

export function findPullSubscription(
  subscriptions: SyncPullResponse['subscriptions'] | undefined,
  subscriptionId: string
): SyncPullSubscriptionResponse | undefined {
  return subscriptions?.find((item) => item.id === subscriptionId);
}

export function requirePullSubscription(
  subscriptions: SyncPullResponse['subscriptions'] | undefined,
  subscriptionId: string
): SyncPullSubscriptionResponse {
  const subscription = findPullSubscription(subscriptions, subscriptionId);
  if (subscription) return subscription;
  const observed = subscriptions?.map((item) => item.id).join(', ') ?? '';
  throw new Error(
    `Expected Syncular pull subscription "${subscriptionId}" but observed: ${observed || 'none'}`
  );
}

export function requireRevokedSubscription(
  subscriptions: SyncPullResponse['subscriptions'] | undefined,
  subscriptionId: string
): SyncRevokedSubscription {
  const subscription = requirePullSubscription(subscriptions, subscriptionId);
  if (subscription.status === 'revoked') {
    return subscription as SyncRevokedSubscription;
  }
  throw new Error(
    `Expected Syncular pull subscription "${subscriptionId}" to be revoked but observed ${subscription.status}`
  );
}

export function subscriptionChanges(
  subscriptions: SyncSubscriptionRecord[] | undefined,
  subscriptionId: string
): SyncChange[] {
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
): SyncChange | undefined {
  const changes = subscriptionChanges(subscriptions, subscriptionId);
  return changes.find((change) => change.row_id === rowId);
}

export function subscriptionChangeRow(
  change: SyncChange | undefined
): Record<string, unknown> | undefined {
  if (!change) {
    return undefined;
  }

  return isRecord(change.row_json) ? change.row_json : undefined;
}
