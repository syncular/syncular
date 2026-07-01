/**
 * Console API types derived from generated OpenAPI operations.
 */

import type { operations } from '@syncular/core/http';

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

export type ConsoleRowHistoryResponse =
  JsonSuccessResponse<'getConsoleRowHistoryByTableByRowId'>;

export type ConsoleRowInvestigationResponse =
  JsonSuccessResponse<'getConsoleRowInvestigationByTableByRowId'>;

export type ConsoleClientDiagnosticLevel = 'debug' | 'info' | 'warn' | 'error';
export type ConsoleClientDiagnosticFreshnessState = 'active' | 'idle' | 'stale';

export type ConsoleClient = PaginatedItem<'getConsoleClients'> &
  GatewayClientFields & {
    diagnosticFreshnessState: ConsoleClientDiagnosticFreshnessState | null;
    diagnosticHealthMaxSeverity: ConsoleClientDiagnosticLevel | null;
    diagnosticReceivedAt: string | null;
  };

export interface ConsoleClientDiagnosticRuntime {
  packageName?: string;
  packageVersion?: string;
  workerProtocolVersion?: number;
  storage?: string;
  storageFallback?: {
    from?: string;
    to?: string;
    reason?: string;
  };
  workerUrl?: string;
  wasmGlueUrl?: string;
  wasmUrl?: string;
  rust?: {
    crateName?: string;
    crateVersion?: string;
    schemaVersion?: number;
    features?: string[];
  };
}

export interface ConsoleClientDiagnosticEvent {
  at: number;
  level: ConsoleClientDiagnosticLevel;
  source: string;
  code: string;
  message: string;
  syncAttemptId?: string;
  traceId?: string;
  spanId?: string;
  clientId?: string;
  subscriptionId?: string;
  table?: string;
  rowId?: string;
  cursor?: number | string | null;
  details?: Record<string, unknown>;
}

export interface ConsoleClientDiagnosticSubscription {
  id: string;
  table: string;
  scopeKeys: string[];
  scopeValueCount: number;
  paramsKeys: string[];
  paramsValueCount: number;
  status: string | null;
  ready: boolean;
  phase?: string;
  progressPercent: number;
  cursor: number | string | null;
  bootstrapPhase: number;
  bootstrapState: unknown | null;
}

export interface ConsoleClientDiagnosticRecord {
  clientId: string;
  actorId: string | null;
  partitionId: string;
  reportedAt: string;
  receivedAt: string;
  freshnessState: ConsoleClientDiagnosticFreshnessState;
  healthMaxSeverity: ConsoleClientDiagnosticLevel | null;
  diagnosticCodesSummary: Array<{
    code: string;
    count: number;
    maxLevel: ConsoleClientDiagnosticLevel;
  }>;
  queueSummary: Record<string, unknown> | null;
  timingSummary: Record<string, unknown> | null;
  redactionSummary: Record<string, unknown>;
  runtime: ConsoleClientDiagnosticRuntime | null;
  connection: Record<string, unknown> | null;
  lifecycle: Record<string, unknown> | null;
  bootstrap: Record<string, unknown> | null;
  transportStats: Record<string, unknown> | null;
  outboxStats: Record<string, unknown> | null;
  conflictStats: Record<string, unknown> | null;
  blobUploadStats: Record<string, unknown> | null;
  subscriptions: ConsoleClientDiagnosticSubscription[];
  recentDiagnostics: ConsoleClientDiagnosticEvent[];
  recentSyncTimings: Array<Record<string, unknown>>;
}

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

export type ConsoleOpsReadinessResponse =
  JsonSuccessResponse<'getConsoleOpsReadiness'>;

export type ConsoleOpsReadinessReport = NonNullable<
  ConsoleOpsReadinessResponse['report']
>;

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
