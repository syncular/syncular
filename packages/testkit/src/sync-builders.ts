import type {
  SyncCombinedRequest,
  SyncOperation,
  SyncPullRequest,
  SyncPushRequest,
  SyncSubscriptionRequest,
} from '@syncular/core';

export interface CreateSyncUpsertOperationOptions {
  table: string;
  rowId: string;
  payload: Record<string, unknown>;
  baseVersion?: number | null;
}

export function createSyncUpsertOperation(
  options: CreateSyncUpsertOperationOptions
): SyncOperation {
  return {
    table: options.table,
    row_id: options.rowId,
    op: 'upsert',
    payload: options.payload,
    base_version: options.baseVersion ?? null,
  };
}

export interface CreateSyncDeleteOperationOptions {
  table: string;
  rowId: string;
  baseVersion?: number | null;
}

export function createSyncDeleteOperation(
  options: CreateSyncDeleteOperationOptions
): SyncOperation {
  return {
    table: options.table,
    row_id: options.rowId,
    op: 'delete',
    payload: null,
    base_version: options.baseVersion ?? null,
  };
}

export interface CreateSyncSubscriptionOptions {
  id: string;
  table: string;
  scopes: SyncSubscriptionRequest['scopes'];
  params?: SyncSubscriptionRequest['params'];
  cursor?: number;
  bootstrapState?: SyncSubscriptionRequest['bootstrapState'];
}

export function createSyncSubscription(
  options: CreateSyncSubscriptionOptions
): SyncSubscriptionRequest {
  return {
    id: options.id,
    table: options.table,
    scopes: options.scopes,
    ...(options.params ? { params: options.params } : {}),
    cursor: options.cursor ?? 0,
    bootstrapState: options.bootstrapState ?? null,
  };
}

export interface CreateSyncPushRequestOptions {
  clientId: string;
  clientCommitId: string;
  operations: SyncOperation[];
  schemaVersion?: number;
}

export function createSyncPushRequest(
  options: CreateSyncPushRequestOptions
): SyncPushRequest {
  return {
    clientId: options.clientId,
    clientCommitId: options.clientCommitId,
    operations: options.operations,
    schemaVersion: options.schemaVersion ?? 1,
  };
}

export interface CreateSyncPullRequestOptions {
  clientId: string;
  subscriptions: SyncSubscriptionRequest[];
  limitCommits?: number;
  limitSnapshotRows?: number;
  maxSnapshotPages?: number;
  dedupeRows?: boolean;
}

export function createSyncPullRequest(
  options: CreateSyncPullRequestOptions
): SyncPullRequest {
  return {
    clientId: options.clientId,
    subscriptions: options.subscriptions,
    limitCommits: options.limitCommits ?? 50,
    ...(options.limitSnapshotRows !== undefined
      ? { limitSnapshotRows: options.limitSnapshotRows }
      : {}),
    ...(options.maxSnapshotPages !== undefined
      ? { maxSnapshotPages: options.maxSnapshotPages }
      : {}),
    ...(options.dedupeRows !== undefined
      ? { dedupeRows: options.dedupeRows }
      : {}),
  };
}

export interface CreateSyncCombinedRequestOptions {
  clientId: string;
  push?: Omit<SyncPushRequest, 'clientId'>;
  pull?: Omit<SyncPullRequest, 'clientId'>;
}

export function createSyncCombinedRequest(
  options: CreateSyncCombinedRequestOptions
): SyncCombinedRequest {
  return {
    clientId: options.clientId,
    ...(options.push ? { push: options.push } : {}),
    ...(options.pull ? { pull: options.pull } : {}),
  };
}
