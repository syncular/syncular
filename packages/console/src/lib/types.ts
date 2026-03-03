/**
 * Console API types derived from generated OpenAPI operations.
 */

import type { operations } from '@syncular/transport-http';

type OperationName = keyof operations;

type JsonResponse<
  TOperation extends OperationName,
  TStatus extends keyof operations[TOperation]['responses'],
> = operations[TOperation]['responses'][TStatus] extends {
  content: { 'application/json': infer TJson };
}
  ? TJson
  : never;

type OperationWithResponse<TStatus extends PropertyKey> = {
  [TName in OperationName]: TStatus extends keyof operations[TName]['responses']
    ? TName
    : never;
}[OperationName];

type JsonSuccessResponse<TOperation extends OperationWithResponse<200>> =
  JsonResponse<TOperation, 200>;

type JsonRequestBody<TOperation extends OperationName> =
  NonNullable<operations[TOperation]['requestBody']> extends {
    content: { 'application/json': infer TJson };
  }
    ? TJson
    : never;

type PaginatedItem<TOperation extends OperationWithResponse<200>> =
  JsonSuccessResponse<TOperation> extends { items: Array<infer TItem> }
    ? TItem
    : never;

interface GatewayFailure {
  instanceId: string;
  reason: string;
  status?: number;
}

interface GatewayAggregateMetadata {
  partial?: boolean;
  failedInstances?: GatewayFailure[];
}

interface GatewayCommitFields {
  instanceId?: string;
  federatedCommitId?: string;
  localCommitSeq?: number;
}

interface GatewayClientFields {
  instanceId?: string;
  federatedClientId?: string;
}

interface GatewayEventFields {
  instanceId?: string;
  federatedEventId?: string;
  localEventId?: number;
}

interface GatewayTimelineFields {
  instanceId?: string;
  federatedTimelineId?: string;
  localCommitSeq?: number | null;
  localEventId?: number | null;
}

interface GatewayOperationFields {
  instanceId?: string;
  federatedOperationId?: string;
  localOperationId?: number;
}

export type ApiKeyType = JsonRequestBody<'postConsoleApiKeys'>['keyType'];

export type ConsoleApiKey = JsonSuccessResponse<'getConsoleApiKeysById'>;

export type ConsoleApiKeyBulkRevokeResponse =
  JsonSuccessResponse<'postConsoleApiKeysBulkRevoke'>;

export type ConsoleCommitListItem = PaginatedItem<'getConsoleCommits'> &
  GatewayCommitFields;

export type ConsoleCommitDetail =
  JsonSuccessResponse<'getConsoleCommitsBySeq'> & GatewayCommitFields;

export type ConsoleClient = PaginatedItem<'getConsoleClients'> &
  GatewayClientFields;

export type ConsoleHandler =
  JsonSuccessResponse<'getConsoleHandlers'>['items'][number];

export type ConsoleRequestEvent = PaginatedItem<'getConsoleEvents'> &
  GatewayEventFields;

export type ConsoleRequestPayload =
  JsonSuccessResponse<'getConsoleEventsByIdPayload'> & GatewayEventFields;

type BaseConsoleTimelineItem = PaginatedItem<'getConsoleTimeline'>;

export type ConsoleTimelineItem = Omit<
  BaseConsoleTimelineItem,
  'commit' | 'event'
> &
  GatewayTimelineFields & {
    commit: ConsoleCommitListItem | null;
    event: ConsoleRequestEvent | null;
  };

export type ConsoleOperationType =
  PaginatedItem<'getConsoleOperations'>['operationType'];

export type ConsoleOperationEvent = PaginatedItem<'getConsoleOperations'> &
  GatewayOperationFields;

export type ConsoleNotifyDataChangeResponse =
  JsonSuccessResponse<'postConsoleNotifyDataChange'>;

export type SyncStats = JsonSuccessResponse<'getConsoleStats'> &
  GatewayAggregateMetadata & {
    minCommitSeqByInstance?: Record<string, number>;
    maxCommitSeqByInstance?: Record<string, number>;
  };

export interface PaginatedResponse<T> {
  items: T[];
  total: number;
  offset: number;
  limit: number;
}

export type TimeseriesInterval =
  JsonSuccessResponse<'getConsoleStatsTimeseries'>['interval'];

export type TimeseriesRange =
  JsonSuccessResponse<'getConsoleStatsTimeseries'>['range'];

export type TimeseriesStatsResponse =
  JsonSuccessResponse<'getConsoleStatsTimeseries'> & GatewayAggregateMetadata;

export type LatencyStatsResponse =
  JsonSuccessResponse<'getConsoleStatsLatency'> & GatewayAggregateMetadata;

export interface LiveEvent {
  type:
    | 'push'
    | 'pull'
    | 'commit'
    | 'client_update'
    | 'instance_error'
    | 'error';
  timestamp: string;
  data: Record<string, unknown>;
}

export type ConsoleBlobListResponse = JsonSuccessResponse<'getConsoleStorage'>;
