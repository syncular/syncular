/**
 * React Query hooks for Console API
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ConnectionConfig } from '../lib/api';
import type {
  ApiKeyType,
  ConsoleApiKey,
  ConsoleApiKeyBulkRevokeResponse,
  ConsoleBlobListResponse,
  ConsoleClient,
  ConsoleCommitDetail,
  ConsoleCommitListItem,
  ConsoleHandler,
  ConsoleNotifyDataChangeResponse,
  ConsoleOperationEvent,
  ConsoleOperationType,
  ConsoleRequestEvent,
  ConsoleRequestPayload,
  ConsoleTimelineItem,
  LatencyStatsResponse,
  PaginatedResponse,
  SyncStats,
  TimeseriesInterval,
  TimeseriesRange,
  TimeseriesStatsResponse,
} from '../lib/types';
import { useConnection } from './ConnectionContext';
import { useInstanceContext } from './useInstanceContext';

type StatsParams = {
  partitionId?: string;
  instanceId?: string;
};
type TimeseriesParams = {
  interval?: TimeseriesInterval;
  range?: TimeseriesRange;
  partitionId?: string;
  instanceId?: string;
};
type LatencyParams = {
  range?: TimeseriesRange;
  partitionId?: string;
  instanceId?: string;
};
type ListParams = {
  limit?: number;
  offset?: number;
  partitionId?: string;
  instanceId?: string;
};
type TimelineParams = ListParams & {
  view?: 'all' | 'commits' | 'events';
  eventType?: 'push' | 'pull';
  actorId?: string;
  clientId?: string;
  requestId?: string;
  traceId?: string;
  table?: string;
  outcome?: string;
  search?: string;
  from?: string;
  to?: string;
};
type EntityLookupOptions = {
  enabled?: boolean;
  partitionId?: string;
  instanceId?: string;
};
type RefetchableQueryOptions = {
  refetchIntervalMs?: number;
  enabled?: boolean;
};
type PrunePreviewOptions = {
  enabled?: boolean;
  instanceId?: string;
};
type OperationEventsParams = ListParams & {
  operationType?: ConsoleOperationType;
};
type ApiKeysParams = {
  limit?: number;
  offset?: number;
  type?: 'relay' | 'proxy' | 'admin';
  status?: 'active' | 'revoked' | 'expiring';
  expiresWithinDays?: number;
  instanceId?: string;
};
type BlobsOptions = {
  prefix?: string;
  cursor?: string;
  limit?: number;
  refetchIntervalMs?: number;
};

const queryKeys = {
  stats: (params?: StatsParams) => ['console', 'stats', params] as const,
  timeseries: (params?: TimeseriesParams) =>
    ['console', 'stats', 'timeseries', params] as const,
  latency: (params?: LatencyParams) =>
    ['console', 'stats', 'latency', params] as const,
  commits: (params?: ListParams) => ['console', 'commits', params] as const,
  commitDetail: (
    seq?: string | number,
    partitionId?: string,
    instanceId?: string
  ) => ['console', 'commit-detail', seq, partitionId, instanceId] as const,
  timeline: (params?: TimelineParams) =>
    ['console', 'timeline', params] as const,
  clients: (params?: ListParams) => ['console', 'clients', params] as const,
  eventDetail: (
    id?: string | number,
    partitionId?: string,
    instanceId?: string
  ) => ['console', 'event-detail', id, partitionId, instanceId] as const,
  eventPayload: (
    id?: string | number,
    partitionId?: string,
    instanceId?: string
  ) => ['console', 'event-payload', id, partitionId, instanceId] as const,
  handlers: (instanceId?: string) =>
    ['console', 'handlers', instanceId] as const,
  prunePreview: (instanceId?: string) =>
    ['console', 'prune', 'preview', instanceId] as const,
  operations: (params?: OperationEventsParams) =>
    ['console', 'operations', params] as const,
  apiKeys: (params?: ApiKeysParams) => ['console', 'api-keys', params] as const,
  storage: (params?: Record<string, unknown>) =>
    ['console', 'storage', params] as const,
};

function resolveRefetchInterval(
  refreshIntervalMs: number | undefined,
  defaultValueMs: number
): number | false {
  if (refreshIntervalMs === 0) return false;
  return refreshIntervalMs ?? defaultValueMs;
}

type ConsoleQueryValue = string | number | boolean | null | undefined;
type QueryKey = readonly unknown[];
type EvictClientRequest = {
  clientId: string;
  partitionId?: string;
  instanceId?: string;
};
type NotifyDataChangeRequest = {
  tables: string[];
  partitionId?: string;
  instanceId?: string;
};
type CreateApiKeyRequest = {
  name: string;
  keyType: ApiKeyType;
  scopeKeys?: string[];
  actorId?: string;
  expiresInDays?: number;
};
type ApiKeySecretResponse = { key: ConsoleApiKey; secretKey: string };

function buildQueryString(
  query: Record<string, ConsoleQueryValue> | undefined
): URLSearchParams {
  const params = new URLSearchParams();
  if (!query) return params;
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null) continue;
    params.set(key, String(value));
  }
  return params;
}

function buildConsoleUrl(
  serverUrl: string,
  path: string,
  query?: Record<string, ConsoleQueryValue>
): string {
  const baseUrl = serverUrl.endsWith('/') ? serverUrl.slice(0, -1) : serverUrl;
  const queryString = buildQueryString(query);
  const suffix = queryString?.toString();
  return `${baseUrl}${path}${suffix ? `?${suffix}` : ''}`;
}

function requireConnection(
  connectionConfig: ConnectionConfig | null,
  isConnected: boolean
): ConnectionConfig {
  if (!isConnected || !connectionConfig) throw new Error('Not connected');
  return connectionConfig;
}

async function fetchConsoleJson<T>(args: {
  connectionConfig: ConnectionConfig;
  path: string;
  query?: Record<string, ConsoleQueryValue>;
  method?: 'GET' | 'POST' | 'DELETE';
  body?: unknown;
  errorMessage: string;
}): Promise<T> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${args.connectionConfig.token}`,
  };
  if (args.body !== undefined) {
    headers['Content-Type'] = 'application/json';
  }
  const response = await fetch(
    buildConsoleUrl(args.connectionConfig.serverUrl, args.path, args.query),
    {
      method: args.method ?? 'GET',
      headers,
      body: args.body === undefined ? undefined : JSON.stringify(args.body),
    }
  );
  if (!response.ok) throw new Error(args.errorMessage);
  return response.json();
}

async function fetchConsoleBlob(args: {
  connectionConfig: ConnectionConfig;
  path: string;
  query?: Record<string, ConsoleQueryValue>;
  errorMessage: string;
}): Promise<Blob> {
  const response = await fetch(
    buildConsoleUrl(args.connectionConfig.serverUrl, args.path, args.query),
    {
      method: 'GET',
      headers: { Authorization: `Bearer ${args.connectionConfig.token}` },
    }
  );
  if (!response.ok) throw new Error(args.errorMessage);
  return response.blob();
}

function useConsoleJsonQuery<T>(options: {
  queryKey: QueryKey;
  path: string;
  query?: Record<string, ConsoleQueryValue>;
  method?: 'GET' | 'POST' | 'DELETE';
  errorMessage: string;
  enabled?: boolean;
  refetchInterval?: number | false;
}) {
  const { config: connectionConfig, isConnected } = useConnection();

  return useQuery<T>({
    queryKey: options.queryKey,
    queryFn: () =>
      fetchConsoleJson<T>({
        connectionConfig: requireConnection(connectionConfig, isConnected),
        path: options.path,
        query: options.query,
        method: options.method,
        errorMessage: options.errorMessage,
      }),
    enabled: (options.enabled ?? true) && isConnected && !!connectionConfig,
    refetchInterval: options.refetchInterval,
  });
}

function useConsoleEntityQuery<T>(options: {
  queryKey: QueryKey;
  id: string | number | undefined;
  requiredMessage: string;
  path: (id: string | number) => string;
  query?: Record<string, ConsoleQueryValue>;
  errorMessage: string;
  enabled?: boolean;
}) {
  const { config: connectionConfig, isConnected } = useConnection();

  return useQuery<T>({
    queryKey: options.queryKey,
    queryFn: () => {
      if (options.id === undefined) throw new Error(options.requiredMessage);
      return fetchConsoleJson<T>({
        connectionConfig: requireConnection(connectionConfig, isConnected),
        path: options.path(options.id),
        query: options.query,
        errorMessage: options.errorMessage,
      });
    },
    enabled:
      (options.enabled ?? true) &&
      options.id !== undefined &&
      isConnected &&
      !!connectionConfig,
  });
}

function invalidateConsoleQueries(
  queryClient: ReturnType<typeof useQueryClient>,
  queryKeysToInvalidate: ReadonlyArray<QueryKey>
): void {
  for (const queryKey of queryKeysToInvalidate) {
    queryClient.invalidateQueries({ queryKey });
  }
}

function useEffectiveInstanceId(instanceId?: string): string | undefined {
  const { instanceId: selectedInstanceId } = useInstanceContext();
  return instanceId ?? selectedInstanceId;
}

function useConsoleJsonMutation<TResult, TVariables>(options: {
  mutationFn: (args: {
    connectionConfig: ConnectionConfig;
    variables: TVariables;
    selectedInstanceId?: string;
  }) => Promise<TResult>;
  invalidateQueryKeys?: ReadonlyArray<QueryKey>;
}) {
  const { config: connectionConfig, isConnected } = useConnection();
  const { instanceId: selectedInstanceId } = useInstanceContext();
  const queryClient = useQueryClient();

  return useMutation<TResult, Error, TVariables>({
    mutationFn: (variables) =>
      options.mutationFn({
        connectionConfig: requireConnection(connectionConfig, isConnected),
        variables,
        selectedInstanceId,
      }),
    onSuccess: () => {
      if (!options.invalidateQueryKeys) return;
      invalidateConsoleQueries(queryClient, options.invalidateQueryKeys);
    },
  });
}

export function useStats(
  options: StatsParams & { refetchIntervalMs?: number } = {}
) {
  const instanceId = useEffectiveInstanceId(options.instanceId);
  return useConsoleJsonQuery<SyncStats>({
    queryKey: queryKeys.stats({ partitionId: options.partitionId, instanceId }),
    path: '/console/stats',
    query: {
      partitionId: options.partitionId,
      instanceId,
    },
    errorMessage: 'Failed to fetch stats',
    refetchInterval: resolveRefetchInterval(options.refetchIntervalMs, 5000),
  });
}

export function useTimeseriesStats(
  params: TimeseriesParams = {},
  options: RefetchableQueryOptions = {}
) {
  const instanceId = useEffectiveInstanceId(params.instanceId);

  return useConsoleJsonQuery<TimeseriesStatsResponse>({
    queryKey: queryKeys.timeseries({ ...params, instanceId }),
    path: '/console/stats/timeseries',
    query: {
      interval: params.interval,
      range: params.range,
      partitionId: params.partitionId,
      instanceId,
    },
    errorMessage: 'Failed to fetch timeseries stats',
    enabled: options.enabled,
    refetchInterval: resolveRefetchInterval(options.refetchIntervalMs, 30000),
  });
}

export function useLatencyStats(
  params: LatencyParams = {},
  options: RefetchableQueryOptions = {}
) {
  const instanceId = useEffectiveInstanceId(params.instanceId);

  return useConsoleJsonQuery<LatencyStatsResponse>({
    queryKey: queryKeys.latency({ ...params, instanceId }),
    path: '/console/stats/latency',
    query: {
      range: params.range,
      partitionId: params.partitionId,
      instanceId,
    },
    errorMessage: 'Failed to fetch latency stats',
    enabled: options.enabled,
    refetchInterval: resolveRefetchInterval(options.refetchIntervalMs, 30000),
  });
}

export function useCommits(
  params: ListParams = {},
  options: RefetchableQueryOptions = {}
) {
  const instanceId = useEffectiveInstanceId(params.instanceId);

  return useConsoleJsonQuery<PaginatedResponse<ConsoleCommitListItem>>({
    queryKey: queryKeys.commits({ ...params, instanceId }),
    path: '/console/commits',
    query: {
      limit: params.limit,
      offset: params.offset,
      partitionId: params.partitionId,
      instanceId,
    },
    errorMessage: 'Failed to fetch commits',
    enabled: options.enabled,
    refetchInterval: resolveRefetchInterval(options.refetchIntervalMs, 10000),
  });
}

export function useCommitDetail(
  seq: string | number | undefined,
  options: EntityLookupOptions = {}
) {
  const instanceId = useEffectiveInstanceId(options.instanceId);

  return useConsoleEntityQuery<ConsoleCommitDetail>({
    queryKey: queryKeys.commitDetail(seq, options.partitionId, instanceId),
    id: seq,
    requiredMessage: 'Commit sequence is required',
    path: (value) => `/console/commits/${encodeURIComponent(String(value))}`,
    query: {
      partitionId: options.partitionId,
      instanceId,
    },
    errorMessage: 'Failed to fetch commit detail',
    enabled: options.enabled,
  });
}

export function useTimeline(
  params: TimelineParams = {},
  options: RefetchableQueryOptions = {}
) {
  const instanceId = useEffectiveInstanceId(params.instanceId);

  return useConsoleJsonQuery<PaginatedResponse<ConsoleTimelineItem>>({
    queryKey: queryKeys.timeline({ ...params, instanceId }),
    path: '/console/timeline',
    query: {
      limit: params.limit,
      offset: params.offset,
      partitionId: params.partitionId,
      view: params.view,
      eventType: params.eventType,
      actorId: params.actorId,
      clientId: params.clientId,
      requestId: params.requestId,
      traceId: params.traceId,
      table: params.table,
      outcome: params.outcome,
      search: params.search,
      from: params.from,
      to: params.to,
      instanceId,
    },
    errorMessage: 'Failed to fetch timeline',
    enabled: options.enabled,
    refetchInterval: resolveRefetchInterval(options.refetchIntervalMs, 10000),
  });
}

export function useClients(
  params: ListParams = {},
  options: RefetchableQueryOptions = {}
) {
  const instanceId = useEffectiveInstanceId(params.instanceId);

  return useConsoleJsonQuery<PaginatedResponse<ConsoleClient>>({
    queryKey: queryKeys.clients({ ...params, instanceId }),
    path: '/console/clients',
    query: {
      limit: params.limit,
      offset: params.offset,
      partitionId: params.partitionId,
      instanceId,
    },
    errorMessage: 'Failed to fetch clients',
    enabled: options.enabled,
    refetchInterval: resolveRefetchInterval(options.refetchIntervalMs, 10000),
  });
}

export function useRequestEventDetail(
  id: string | number | undefined,
  options: EntityLookupOptions = {}
) {
  const instanceId = useEffectiveInstanceId(options.instanceId);

  return useConsoleEntityQuery<ConsoleRequestEvent>({
    queryKey: queryKeys.eventDetail(id, options.partitionId, instanceId),
    id,
    requiredMessage: 'Event id is required',
    path: (value) => `/console/events/${encodeURIComponent(String(value))}`,
    query: {
      partitionId: options.partitionId,
      instanceId,
    },
    errorMessage: 'Failed to fetch event detail',
    enabled: options.enabled,
  });
}

export function useRequestEventPayload(
  id: string | number | undefined,
  options: EntityLookupOptions = {}
) {
  const instanceId = useEffectiveInstanceId(options.instanceId);

  return useConsoleEntityQuery<ConsoleRequestPayload>({
    queryKey: queryKeys.eventPayload(id, options.partitionId, instanceId),
    id,
    requiredMessage: 'Event id is required',
    path: (value) =>
      `/console/events/${encodeURIComponent(String(value))}/payload`,
    query: {
      partitionId: options.partitionId,
      instanceId,
    },
    errorMessage: 'Failed to fetch event payload',
    enabled: options.enabled,
  });
}

export function useHandlers(options: { instanceId?: string } = {}) {
  const instanceId = useEffectiveInstanceId(options.instanceId);

  return useConsoleJsonQuery<{ items: ConsoleHandler[] }>({
    queryKey: queryKeys.handlers(instanceId),
    path: '/console/handlers',
    query: { instanceId },
    errorMessage: 'Failed to fetch handlers',
  });
}

export function usePrunePreview(options: PrunePreviewOptions = {}) {
  const instanceId = useEffectiveInstanceId(options.instanceId);

  return useConsoleJsonQuery<{
    watermarkCommitSeq: number;
    commitsToDelete: number;
  }>({
    queryKey: queryKeys.prunePreview(instanceId),
    path: '/console/prune/preview',
    query: { instanceId },
    method: 'POST',
    errorMessage: 'Failed to fetch prune preview',
    enabled: options.enabled,
  });
}

export function useOperationEvents(
  params: OperationEventsParams = {},
  options: RefetchableQueryOptions = {}
) {
  const instanceId = useEffectiveInstanceId(params.instanceId);

  return useConsoleJsonQuery<PaginatedResponse<ConsoleOperationEvent>>({
    queryKey: queryKeys.operations({ ...params, instanceId }),
    path: '/console/operations',
    query: {
      limit: params.limit,
      offset: params.offset,
      operationType: params.operationType,
      partitionId: params.partitionId,
      instanceId,
    },
    errorMessage: 'Failed to fetch operations',
    enabled: options.enabled,
    refetchInterval: resolveRefetchInterval(options.refetchIntervalMs, 10000),
  });
}

export function useClearEventsMutation() {
  return useConsoleJsonMutation<{ deletedCount: number }, void>({
    mutationFn: async ({ connectionConfig, selectedInstanceId }) =>
      fetchConsoleJson<{ deletedCount: number }>({
        connectionConfig,
        path: '/console/events',
        query: { instanceId: selectedInstanceId },
        method: 'DELETE',
        errorMessage: 'Failed to clear events',
      }),
    invalidateQueryKeys: [['console', 'events']],
  });
}

export function useEvictClientMutation() {
  return useConsoleJsonMutation<{ evicted: boolean }, EvictClientRequest>({
    mutationFn: async ({ connectionConfig, variables, selectedInstanceId }) => {
      const effectiveInstanceId = variables.instanceId ?? selectedInstanceId;
      return fetchConsoleJson<{ evicted: boolean }>({
        connectionConfig,
        path: `/console/clients/${encodeURIComponent(variables.clientId)}`,
        query: {
          partitionId: variables.partitionId,
          instanceId: effectiveInstanceId,
        },
        method: 'DELETE',
        errorMessage: 'Failed to evict client',
      });
    },
    invalidateQueryKeys: [
      ['console', 'clients'],
      ['console', 'stats'],
      ['console', 'operations'],
    ],
  });
}

export function usePruneMutation() {
  return useConsoleJsonMutation<{ deletedCommits: number }, void>({
    mutationFn: async ({ connectionConfig, selectedInstanceId }) =>
      fetchConsoleJson<{ deletedCommits: number }>({
        connectionConfig,
        path: '/console/prune',
        query: { instanceId: selectedInstanceId },
        method: 'POST',
        errorMessage: 'Failed to prune',
      }),
    invalidateQueryKeys: [
      ['console', 'stats'],
      ['console', 'commits'],
      ['console', 'timeline'],
      ['console', 'prune', 'preview'],
      ['console', 'operations'],
    ],
  });
}

export function useCompactMutation() {
  return useConsoleJsonMutation<{ deletedChanges: number }, void>({
    mutationFn: async ({ connectionConfig, selectedInstanceId }) =>
      fetchConsoleJson<{ deletedChanges: number }>({
        connectionConfig,
        path: '/console/compact',
        query: { instanceId: selectedInstanceId },
        method: 'POST',
        errorMessage: 'Failed to compact',
      }),
    invalidateQueryKeys: [
      ['console', 'stats'],
      ['console', 'operations'],
    ],
  });
}

export function useNotifyDataChangeMutation() {
  return useConsoleJsonMutation<
    ConsoleNotifyDataChangeResponse,
    NotifyDataChangeRequest
  >({
    mutationFn: async ({ connectionConfig, variables, selectedInstanceId }) => {
      const effectiveInstanceId = variables.instanceId ?? selectedInstanceId;
      return fetchConsoleJson<ConsoleNotifyDataChangeResponse>({
        connectionConfig,
        path: '/console/notify-data-change',
        query: { instanceId: effectiveInstanceId },
        method: 'POST',
        body: {
          tables: variables.tables,
          partitionId: variables.partitionId,
        },
        errorMessage: 'Failed to notify data change',
      });
    },
    invalidateQueryKeys: [
      ['console', 'stats'],
      ['console', 'commits'],
      ['console', 'timeline'],
      ['console', 'operations'],
    ],
  });
}

export function useApiKeys(params: ApiKeysParams = {}) {
  const instanceId = useEffectiveInstanceId(params.instanceId);

  return useConsoleJsonQuery<PaginatedResponse<ConsoleApiKey>>({
    queryKey: queryKeys.apiKeys({ ...params, instanceId }),
    path: '/console/api-keys',
    query: {
      limit: params.limit,
      offset: params.offset,
      type: params.type,
      status: params.status,
      expiresWithinDays: params.expiresWithinDays,
      instanceId,
    },
    errorMessage: 'Failed to fetch API keys',
  });
}

export function useCreateApiKeyMutation() {
  return useConsoleJsonMutation<ApiKeySecretResponse, CreateApiKeyRequest>({
    mutationFn: async ({ connectionConfig, variables, selectedInstanceId }) => {
      return fetchConsoleJson<ApiKeySecretResponse>({
        connectionConfig,
        path: '/console/api-keys',
        query: { instanceId: selectedInstanceId },
        method: 'POST',
        body: variables,
        errorMessage: 'Failed to create API key',
      });
    },
    invalidateQueryKeys: [['console', 'api-keys']],
  });
}

export function useRevokeApiKeyMutation() {
  return useConsoleJsonMutation<{ revoked: boolean }, string>({
    mutationFn: async ({ connectionConfig, variables, selectedInstanceId }) => {
      return fetchConsoleJson<{ revoked: boolean }>({
        connectionConfig,
        path: `/console/api-keys/${encodeURIComponent(variables)}`,
        query: { instanceId: selectedInstanceId },
        method: 'DELETE',
        errorMessage: 'Failed to revoke API key',
      });
    },
    invalidateQueryKeys: [['console', 'api-keys']],
  });
}

export function useBulkRevokeApiKeysMutation() {
  return useConsoleJsonMutation<
    ConsoleApiKeyBulkRevokeResponse,
    { keyIds: string[] }
  >({
    mutationFn: async ({ connectionConfig, variables, selectedInstanceId }) => {
      return fetchConsoleJson<ConsoleApiKeyBulkRevokeResponse>({
        connectionConfig,
        path: '/console/api-keys/bulk-revoke',
        query: { instanceId: selectedInstanceId },
        method: 'POST',
        body: variables,
        errorMessage: 'Failed to bulk revoke API keys',
      });
    },
    invalidateQueryKeys: [['console', 'api-keys']],
  });
}

export function useRotateApiKeyMutation() {
  return useConsoleJsonMutation<ApiKeySecretResponse, string>({
    mutationFn: async ({ connectionConfig, variables, selectedInstanceId }) => {
      return fetchConsoleJson<ApiKeySecretResponse>({
        connectionConfig,
        path: `/console/api-keys/${encodeURIComponent(variables)}/rotate`,
        query: { instanceId: selectedInstanceId },
        method: 'POST',
        errorMessage: 'Failed to rotate API key',
      });
    },
    invalidateQueryKeys: [['console', 'api-keys']],
  });
}

export function useStageRotateApiKeyMutation() {
  return useConsoleJsonMutation<ApiKeySecretResponse, string>({
    mutationFn: async ({ connectionConfig, variables, selectedInstanceId }) => {
      return fetchConsoleJson<ApiKeySecretResponse>({
        connectionConfig,
        path: `/console/api-keys/${encodeURIComponent(variables)}/rotate/stage`,
        query: { instanceId: selectedInstanceId },
        method: 'POST',
        errorMessage: 'Failed to stage-rotate API key',
      });
    },
    invalidateQueryKeys: [['console', 'api-keys']],
  });
}

// ---------------------------------------------------------------------------
// Blob storage hooks
// ---------------------------------------------------------------------------

export function useBlobs(options: BlobsOptions = {}) {
  return useConsoleJsonQuery<ConsoleBlobListResponse>({
    queryKey: queryKeys.storage({
      prefix: options.prefix,
      cursor: options.cursor,
      limit: options.limit,
    }),
    path: '/console/storage',
    query: {
      prefix: options.prefix,
      cursor: options.cursor,
      limit: options.limit,
    },
    errorMessage: 'Failed to list blobs',
    refetchInterval: resolveRefetchInterval(options.refetchIntervalMs, 30000),
  });
}

export function useDeleteBlobMutation() {
  return useConsoleJsonMutation<{ deleted: boolean }, string>({
    mutationFn: async ({ connectionConfig, variables }) =>
      fetchConsoleJson<{ deleted: boolean }>({
        connectionConfig,
        path: `/console/storage/${encodeURIComponent(variables)}`,
        method: 'DELETE',
        errorMessage: 'Failed to delete blob',
      }),
    invalidateQueryKeys: [['console', 'storage']],
  });
}

export function useBlobDownload() {
  const { config: connectionConfig, isConnected } = useConnection();
  return async (key: string) => {
    const blob = await fetchConsoleBlob({
      connectionConfig: requireConnection(connectionConfig, isConnected),
      path: `/console/storage/${encodeURIComponent(key)}/download`,
      errorMessage: 'Failed to download blob',
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = key.split('/').pop() || key;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };
}
