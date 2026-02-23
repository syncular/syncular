/**
 * React Query hooks for Console API
 */

import { unwrap } from '@syncular/transport-http';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
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
import { useApiClient, useConnection } from './ConnectionContext';
import { useInstanceContext } from './useInstanceContext';

const queryKeys = {
  stats: (params?: { partitionId?: string; instanceId?: string }) =>
    ['console', 'stats', params] as const,
  timeseries: (params?: {
    interval?: TimeseriesInterval;
    range?: TimeseriesRange;
    partitionId?: string;
    instanceId?: string;
  }) => ['console', 'stats', 'timeseries', params] as const,
  latency: (params?: {
    range?: TimeseriesRange;
    partitionId?: string;
    instanceId?: string;
  }) => ['console', 'stats', 'latency', params] as const,
  commits: (params?: {
    limit?: number;
    offset?: number;
    partitionId?: string;
    instanceId?: string;
  }) => ['console', 'commits', params] as const,
  commitDetail: (
    seq?: string | number,
    partitionId?: string,
    instanceId?: string
  ) => ['console', 'commit-detail', seq, partitionId, instanceId] as const,
  timeline: (params?: {
    limit?: number;
    offset?: number;
    partitionId?: string;
    instanceId?: string;
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
  }) => ['console', 'timeline', params] as const,
  clients: (params?: {
    limit?: number;
    offset?: number;
    partitionId?: string;
    instanceId?: string;
  }) => ['console', 'clients', params] as const,
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
  operations: (params?: {
    limit?: number;
    offset?: number;
    operationType?: ConsoleOperationType;
    partitionId?: string;
    instanceId?: string;
  }) => ['console', 'operations', params] as const,
  apiKeys: (params?: {
    limit?: number;
    offset?: number;
    type?: 'relay' | 'proxy' | 'admin';
    status?: 'active' | 'revoked' | 'expiring';
    expiresWithinDays?: number;
    instanceId?: string;
  }) => ['console', 'api-keys', params] as const,
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

interface InstanceQueryFilter {
  instanceId?: string;
}

function withInstanceQuery<T extends Record<string, unknown>>(
  query: T,
  instanceId: string | undefined
): T & InstanceQueryFilter {
  if (!instanceId) return query;
  return { ...query, instanceId };
}

function serializePathSegment(value: string | number): string {
  return encodeURIComponent(String(value));
}

function buildConsoleUrl(
  serverUrl: string,
  path: string,
  queryString?: URLSearchParams
): string {
  const baseUrl = serverUrl.endsWith('/') ? serverUrl.slice(0, -1) : serverUrl;
  const suffix = queryString?.toString();
  return `${baseUrl}${path}${suffix ? `?${suffix}` : ''}`;
}

export function useStats(
  options: {
    refetchIntervalMs?: number;
    partitionId?: string;
    instanceId?: string;
  } = {}
) {
  const client = useApiClient();
  const { instanceId: selectedInstanceId } = useInstanceContext();
  const instanceId = options.instanceId ?? selectedInstanceId;
  const query = withInstanceQuery(
    options.partitionId ? { partitionId: options.partitionId } : {},
    instanceId
  );

  return useQuery<SyncStats>({
    queryKey: queryKeys.stats({
      partitionId: options.partitionId,
      instanceId,
    }),
    queryFn: () => {
      if (!client) throw new Error('Not connected');
      return unwrap(client.GET('/console/stats', { params: { query } }));
    },
    enabled: !!client,
    refetchInterval: resolveRefetchInterval(options.refetchIntervalMs, 5000),
  });
}

export function useTimeseriesStats(
  params: {
    interval?: TimeseriesInterval;
    range?: TimeseriesRange;
    partitionId?: string;
    instanceId?: string;
  } = {},
  options: { refetchIntervalMs?: number; enabled?: boolean } = {}
) {
  const client = useApiClient();
  const { config: connectionConfig } = useConnection();
  const { instanceId: selectedInstanceId } = useInstanceContext();
  const instanceId = params.instanceId ?? selectedInstanceId;

  return useQuery<TimeseriesStatsResponse>({
    queryKey: queryKeys.timeseries({ ...params, instanceId }),
    queryFn: async () => {
      if (!client || !connectionConfig) throw new Error('Not connected');
      // Use fetch directly since this endpoint may not be in OpenAPI yet
      const queryString = new URLSearchParams();
      if (params.interval) queryString.set('interval', params.interval);
      if (params.range) queryString.set('range', params.range);
      if (params.partitionId)
        queryString.set('partitionId', params.partitionId);
      if (instanceId) queryString.set('instanceId', instanceId);
      const response = await fetch(
        `${connectionConfig.serverUrl}/console/stats/timeseries?${queryString}`,
        { headers: { Authorization: `Bearer ${connectionConfig.token}` } }
      );
      if (!response.ok) throw new Error('Failed to fetch timeseries stats');
      return response.json();
    },
    enabled: (options.enabled ?? true) && !!client && !!connectionConfig,
    refetchInterval: resolveRefetchInterval(options.refetchIntervalMs, 30000),
  });
}

export function useLatencyStats(
  params: {
    range?: TimeseriesRange;
    partitionId?: string;
    instanceId?: string;
  } = {},
  options: { refetchIntervalMs?: number; enabled?: boolean } = {}
) {
  const client = useApiClient();
  const { config: connectionConfig } = useConnection();
  const { instanceId: selectedInstanceId } = useInstanceContext();
  const instanceId = params.instanceId ?? selectedInstanceId;

  return useQuery<LatencyStatsResponse>({
    queryKey: queryKeys.latency({ ...params, instanceId }),
    queryFn: async () => {
      if (!client || !connectionConfig) throw new Error('Not connected');
      // Use fetch directly since this endpoint may not be in OpenAPI yet
      const queryString = new URLSearchParams();
      if (params.range) queryString.set('range', params.range);
      if (params.partitionId)
        queryString.set('partitionId', params.partitionId);
      if (instanceId) queryString.set('instanceId', instanceId);
      const response = await fetch(
        `${connectionConfig.serverUrl}/console/stats/latency?${queryString}`,
        { headers: { Authorization: `Bearer ${connectionConfig.token}` } }
      );
      if (!response.ok) throw new Error('Failed to fetch latency stats');
      return response.json();
    },
    enabled: (options.enabled ?? true) && !!client && !!connectionConfig,
    refetchInterval: resolveRefetchInterval(options.refetchIntervalMs, 30000),
  });
}

export function useCommits(
  params: {
    limit?: number;
    offset?: number;
    partitionId?: string;
    instanceId?: string;
  } = {},
  options: { refetchIntervalMs?: number; enabled?: boolean } = {}
) {
  const client = useApiClient();
  const { instanceId: selectedInstanceId } = useInstanceContext();
  const instanceId = params.instanceId ?? selectedInstanceId;
  const query = withInstanceQuery(
    {
      limit: params.limit,
      offset: params.offset,
      partitionId: params.partitionId,
    },
    instanceId
  );

  return useQuery<PaginatedResponse<ConsoleCommitListItem>>({
    queryKey: queryKeys.commits({ ...params, instanceId }),
    queryFn: () => {
      if (!client) throw new Error('Not connected');
      return unwrap(client.GET('/console/commits', { params: { query } }));
    },
    enabled: (options.enabled ?? true) && !!client,
    refetchInterval: resolveRefetchInterval(options.refetchIntervalMs, 10000),
  });
}

export function useCommitDetail(
  seq: string | number | undefined,
  options: { enabled?: boolean; partitionId?: string; instanceId?: string } = {}
) {
  const client = useApiClient();
  const { config: connectionConfig } = useConnection();
  const { instanceId: selectedInstanceId } = useInstanceContext();
  const instanceId = options.instanceId ?? selectedInstanceId;

  return useQuery<ConsoleCommitDetail>({
    queryKey: queryKeys.commitDetail(seq, options.partitionId, instanceId),
    queryFn: async () => {
      if (!client || !connectionConfig) throw new Error('Not connected');
      if (seq === undefined) throw new Error('Commit sequence is required');
      const queryString = new URLSearchParams();
      if (options.partitionId)
        queryString.set('partitionId', options.partitionId);
      if (instanceId) queryString.set('instanceId', instanceId);
      const suffix = queryString.toString();
      const response = await fetch(
        `${connectionConfig.serverUrl}/console/commits/${serializePathSegment(seq)}${suffix ? `?${suffix}` : ''}`,
        { headers: { Authorization: `Bearer ${connectionConfig.token}` } }
      );
      if (!response.ok) throw new Error('Failed to fetch commit detail');
      return response.json();
    },
    enabled: (options.enabled ?? true) && seq !== undefined && !!client,
  });
}

export function useTimeline(
  params: {
    limit?: number;
    offset?: number;
    partitionId?: string;
    instanceId?: string;
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
  } = {},
  options: { refetchIntervalMs?: number; enabled?: boolean } = {}
) {
  const client = useApiClient();
  const { instanceId: selectedInstanceId } = useInstanceContext();
  const instanceId = params.instanceId ?? selectedInstanceId;
  const query = withInstanceQuery(
    {
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
    },
    instanceId
  );

  return useQuery<PaginatedResponse<ConsoleTimelineItem>>({
    queryKey: queryKeys.timeline({ ...params, instanceId }),
    queryFn: () => {
      if (!client) throw new Error('Not connected');
      return unwrap(client.GET('/console/timeline', { params: { query } }));
    },
    enabled: (options.enabled ?? true) && !!client,
    refetchInterval: resolveRefetchInterval(options.refetchIntervalMs, 10000),
  });
}

export function useClients(
  params: {
    limit?: number;
    offset?: number;
    partitionId?: string;
    instanceId?: string;
  } = {},
  options: { refetchIntervalMs?: number; enabled?: boolean } = {}
) {
  const client = useApiClient();
  const { instanceId: selectedInstanceId } = useInstanceContext();
  const instanceId = params.instanceId ?? selectedInstanceId;
  const query = withInstanceQuery(
    {
      limit: params.limit,
      offset: params.offset,
      partitionId: params.partitionId,
    },
    instanceId
  );

  return useQuery<PaginatedResponse<ConsoleClient>>({
    queryKey: queryKeys.clients({ ...params, instanceId }),
    queryFn: () => {
      if (!client) throw new Error('Not connected');
      return unwrap(client.GET('/console/clients', { params: { query } }));
    },
    enabled: (options.enabled ?? true) && !!client,
    refetchInterval: resolveRefetchInterval(options.refetchIntervalMs, 10000),
  });
}

export function useRequestEventDetail(
  id: string | number | undefined,
  options: { enabled?: boolean; partitionId?: string; instanceId?: string } = {}
) {
  const client = useApiClient();
  const { config: connectionConfig } = useConnection();
  const { instanceId: selectedInstanceId } = useInstanceContext();
  const instanceId = options.instanceId ?? selectedInstanceId;

  return useQuery<ConsoleRequestEvent>({
    queryKey: queryKeys.eventDetail(id, options.partitionId, instanceId),
    queryFn: async () => {
      if (!client || !connectionConfig) throw new Error('Not connected');
      if (id === undefined) throw new Error('Event id is required');
      const queryString = new URLSearchParams();
      if (options.partitionId)
        queryString.set('partitionId', options.partitionId);
      if (instanceId) queryString.set('instanceId', instanceId);
      const suffix = queryString.toString();
      const response = await fetch(
        `${connectionConfig.serverUrl}/console/events/${serializePathSegment(id)}${suffix ? `?${suffix}` : ''}`,
        { headers: { Authorization: `Bearer ${connectionConfig.token}` } }
      );
      if (!response.ok) throw new Error('Failed to fetch event detail');
      return response.json();
    },
    enabled: (options.enabled ?? true) && id !== undefined && !!client,
  });
}

export function useRequestEventPayload(
  id: string | number | undefined,
  options: { enabled?: boolean; partitionId?: string; instanceId?: string } = {}
) {
  const client = useApiClient();
  const { config: connectionConfig } = useConnection();
  const { instanceId: selectedInstanceId } = useInstanceContext();
  const instanceId = options.instanceId ?? selectedInstanceId;

  return useQuery<ConsoleRequestPayload>({
    queryKey: queryKeys.eventPayload(id, options.partitionId, instanceId),
    queryFn: async () => {
      if (!client || !connectionConfig) throw new Error('Not connected');
      if (id === undefined) throw new Error('Event id is required');
      const queryString = new URLSearchParams();
      if (options.partitionId)
        queryString.set('partitionId', options.partitionId);
      if (instanceId) queryString.set('instanceId', instanceId);
      const suffix = queryString.toString();
      const response = await fetch(
        `${connectionConfig.serverUrl}/console/events/${serializePathSegment(id)}/payload${suffix ? `?${suffix}` : ''}`,
        { headers: { Authorization: `Bearer ${connectionConfig.token}` } }
      );
      if (!response.ok) throw new Error('Failed to fetch event payload');
      return response.json();
    },
    enabled: (options.enabled ?? true) && id !== undefined && !!client,
  });
}

export function useHandlers(options: { instanceId?: string } = {}) {
  const client = useApiClient();
  const { config: connectionConfig } = useConnection();
  const { instanceId: selectedInstanceId } = useInstanceContext();
  const instanceId = options.instanceId ?? selectedInstanceId;

  return useQuery<{ items: ConsoleHandler[] }>({
    queryKey: queryKeys.handlers(instanceId),
    queryFn: async () => {
      if (!client || !connectionConfig) throw new Error('Not connected');
      const queryString = new URLSearchParams();
      if (instanceId) queryString.set('instanceId', instanceId);
      const response = await fetch(
        buildConsoleUrl(
          connectionConfig.serverUrl,
          '/console/handlers',
          queryString
        ),
        {
          headers: { Authorization: `Bearer ${connectionConfig.token}` },
        }
      );
      if (!response.ok) throw new Error('Failed to fetch handlers');
      return response.json();
    },
    enabled: !!client && !!connectionConfig,
  });
}

export function usePrunePreview(
  options: { enabled?: boolean; instanceId?: string } = {}
) {
  const client = useApiClient();
  const { config: connectionConfig } = useConnection();
  const { instanceId: selectedInstanceId } = useInstanceContext();
  const instanceId = options.instanceId ?? selectedInstanceId;

  return useQuery<{ watermarkCommitSeq: number; commitsToDelete: number }>({
    queryKey: queryKeys.prunePreview(instanceId),
    queryFn: async () => {
      if (!client || !connectionConfig) throw new Error('Not connected');
      const queryString = new URLSearchParams();
      if (instanceId) queryString.set('instanceId', instanceId);
      const response = await fetch(
        buildConsoleUrl(
          connectionConfig.serverUrl,
          '/console/prune/preview',
          queryString
        ),
        {
          method: 'POST',
          headers: { Authorization: `Bearer ${connectionConfig.token}` },
        }
      );
      if (!response.ok) throw new Error('Failed to fetch prune preview');
      return response.json();
    },
    enabled: !!client && !!connectionConfig && (options.enabled ?? true),
  });
}

export function useOperationEvents(
  params: {
    limit?: number;
    offset?: number;
    operationType?: ConsoleOperationType;
    partitionId?: string;
    instanceId?: string;
  } = {},
  options: { enabled?: boolean; refetchIntervalMs?: number } = {}
) {
  const client = useApiClient();
  const { instanceId: selectedInstanceId } = useInstanceContext();
  const instanceId = params.instanceId ?? selectedInstanceId;
  const query = withInstanceQuery(
    {
      limit: params.limit,
      offset: params.offset,
      operationType: params.operationType,
      partitionId: params.partitionId,
    },
    instanceId
  );

  return useQuery<PaginatedResponse<ConsoleOperationEvent>>({
    queryKey: queryKeys.operations({ ...params, instanceId }),
    queryFn: () => {
      if (!client) throw new Error('Not connected');
      return unwrap(client.GET('/console/operations', { params: { query } }));
    },
    enabled: (options.enabled ?? true) && !!client,
    refetchInterval: resolveRefetchInterval(options.refetchIntervalMs, 10000),
  });
}

export function useEvictClientMutation() {
  const client = useApiClient();
  const { config: connectionConfig } = useConnection();
  const { instanceId: selectedInstanceId } = useInstanceContext();
  const queryClient = useQueryClient();

  return useMutation<
    { evicted: boolean },
    Error,
    { clientId: string; partitionId?: string; instanceId?: string }
  >({
    mutationFn: async ({ clientId, partitionId, instanceId }) => {
      if (!client || !connectionConfig) throw new Error('Not connected');
      const effectiveInstanceId = instanceId ?? selectedInstanceId;
      const queryString = new URLSearchParams();
      if (partitionId) queryString.set('partitionId', partitionId);
      if (effectiveInstanceId)
        queryString.set('instanceId', effectiveInstanceId);
      const response = await fetch(
        buildConsoleUrl(
          connectionConfig.serverUrl,
          `/console/clients/${serializePathSegment(clientId)}`,
          queryString
        ),
        {
          method: 'DELETE',
          headers: { Authorization: `Bearer ${connectionConfig.token}` },
        }
      );
      if (!response.ok) throw new Error('Failed to evict client');
      return response.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['console', 'clients'] });
      queryClient.invalidateQueries({ queryKey: ['console', 'stats'] });
      queryClient.invalidateQueries({ queryKey: ['console', 'operations'] });
    },
  });
}

export function usePruneMutation() {
  const client = useApiClient();
  const { config: connectionConfig } = useConnection();
  const { instanceId } = useInstanceContext();
  const queryClient = useQueryClient();

  return useMutation<{ deletedCommits: number }, Error, void>({
    mutationFn: async () => {
      if (!client || !connectionConfig) throw new Error('Not connected');
      const queryString = new URLSearchParams();
      if (instanceId) queryString.set('instanceId', instanceId);
      const response = await fetch(
        buildConsoleUrl(
          connectionConfig.serverUrl,
          '/console/prune',
          queryString
        ),
        {
          method: 'POST',
          headers: { Authorization: `Bearer ${connectionConfig.token}` },
        }
      );
      if (!response.ok) throw new Error('Failed to prune');
      return response.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['console', 'stats'] });
      queryClient.invalidateQueries({ queryKey: ['console', 'commits'] });
      queryClient.invalidateQueries({ queryKey: ['console', 'timeline'] });
      queryClient.invalidateQueries({
        queryKey: ['console', 'prune', 'preview'],
      });
      queryClient.invalidateQueries({ queryKey: ['console', 'operations'] });
    },
  });
}

export function useCompactMutation() {
  const client = useApiClient();
  const { config: connectionConfig } = useConnection();
  const { instanceId } = useInstanceContext();
  const queryClient = useQueryClient();

  return useMutation<{ deletedChanges: number }, Error, void>({
    mutationFn: async () => {
      if (!client || !connectionConfig) throw new Error('Not connected');
      const queryString = new URLSearchParams();
      if (instanceId) queryString.set('instanceId', instanceId);
      const response = await fetch(
        buildConsoleUrl(
          connectionConfig.serverUrl,
          '/console/compact',
          queryString
        ),
        {
          method: 'POST',
          headers: { Authorization: `Bearer ${connectionConfig.token}` },
        }
      );
      if (!response.ok) throw new Error('Failed to compact');
      return response.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['console', 'stats'] });
      queryClient.invalidateQueries({ queryKey: ['console', 'operations'] });
    },
  });
}

export function useNotifyDataChangeMutation() {
  const client = useApiClient();
  const { config: connectionConfig } = useConnection();
  const { instanceId: selectedInstanceId } = useInstanceContext();
  const queryClient = useQueryClient();

  return useMutation<
    ConsoleNotifyDataChangeResponse,
    Error,
    { tables: string[]; partitionId?: string; instanceId?: string }
  >({
    mutationFn: async (request) => {
      if (!client || !connectionConfig) throw new Error('Not connected');
      const effectiveInstanceId = request.instanceId ?? selectedInstanceId;
      const queryString = new URLSearchParams();
      if (effectiveInstanceId)
        queryString.set('instanceId', effectiveInstanceId);
      const response = await fetch(
        buildConsoleUrl(
          connectionConfig.serverUrl,
          '/console/notify-data-change',
          queryString
        ),
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${connectionConfig.token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            tables: request.tables,
            partitionId: request.partitionId,
          }),
        }
      );
      if (!response.ok) throw new Error('Failed to notify data change');
      return response.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['console', 'stats'] });
      queryClient.invalidateQueries({ queryKey: ['console', 'commits'] });
      queryClient.invalidateQueries({ queryKey: ['console', 'timeline'] });
      queryClient.invalidateQueries({ queryKey: ['console', 'operations'] });
    },
  });
}

export function useApiKeys(
  params: {
    limit?: number;
    offset?: number;
    type?: 'relay' | 'proxy' | 'admin';
    status?: 'active' | 'revoked' | 'expiring';
    expiresWithinDays?: number;
    instanceId?: string;
  } = {}
) {
  const client = useApiClient();
  const { config: connectionConfig } = useConnection();
  const { instanceId: selectedInstanceId } = useInstanceContext();
  const instanceId = params.instanceId ?? selectedInstanceId;

  return useQuery<PaginatedResponse<ConsoleApiKey>>({
    queryKey: queryKeys.apiKeys({ ...params, instanceId }),
    queryFn: async () => {
      if (!client || !connectionConfig) throw new Error('Not connected');
      const queryString = new URLSearchParams();
      if (params.limit !== undefined)
        queryString.set('limit', String(params.limit));
      if (params.offset !== undefined)
        queryString.set('offset', String(params.offset));
      if (params.type) queryString.set('type', params.type);
      if (params.status) queryString.set('status', params.status);
      if (params.expiresWithinDays !== undefined) {
        queryString.set('expiresWithinDays', String(params.expiresWithinDays));
      }
      if (instanceId) queryString.set('instanceId', instanceId);

      const response = await fetch(
        buildConsoleUrl(
          connectionConfig.serverUrl,
          '/console/api-keys',
          queryString
        ),
        {
          headers: { Authorization: `Bearer ${connectionConfig.token}` },
        }
      );
      if (!response.ok) throw new Error('Failed to fetch API keys');
      return response.json();
    },
    enabled: !!client && !!connectionConfig,
  });
}

export function useCreateApiKeyMutation() {
  const client = useApiClient();
  const { config: connectionConfig } = useConnection();
  const { instanceId } = useInstanceContext();
  const queryClient = useQueryClient();

  return useMutation<
    { key: ConsoleApiKey; secretKey: string },
    Error,
    {
      name: string;
      keyType: 'relay' | 'proxy' | 'admin';
      scopeKeys?: string[];
      actorId?: string;
      expiresInDays?: number;
    }
  >({
    mutationFn: async (request) => {
      if (!client || !connectionConfig) throw new Error('Not connected');
      const queryString = new URLSearchParams();
      if (instanceId) queryString.set('instanceId', instanceId);
      const response = await fetch(
        buildConsoleUrl(
          connectionConfig.serverUrl,
          '/console/api-keys',
          queryString
        ),
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${connectionConfig.token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(request),
        }
      );
      if (!response.ok) throw new Error('Failed to create API key');
      return response.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['console', 'api-keys'] });
    },
  });
}

export function useRevokeApiKeyMutation() {
  const client = useApiClient();
  const { config: connectionConfig } = useConnection();
  const { instanceId } = useInstanceContext();
  const queryClient = useQueryClient();

  return useMutation<{ revoked: boolean }, Error, string>({
    mutationFn: async (keyId) => {
      if (!client || !connectionConfig) throw new Error('Not connected');
      const queryString = new URLSearchParams();
      if (instanceId) queryString.set('instanceId', instanceId);
      const response = await fetch(
        buildConsoleUrl(
          connectionConfig.serverUrl,
          `/console/api-keys/${serializePathSegment(keyId)}`,
          queryString
        ),
        {
          method: 'DELETE',
          headers: { Authorization: `Bearer ${connectionConfig.token}` },
        }
      );
      if (!response.ok) throw new Error('Failed to revoke API key');
      return response.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['console', 'api-keys'] });
    },
  });
}

export function useBulkRevokeApiKeysMutation() {
  const client = useApiClient();
  const { config: connectionConfig } = useConnection();
  const { instanceId } = useInstanceContext();
  const queryClient = useQueryClient();

  return useMutation<
    ConsoleApiKeyBulkRevokeResponse,
    Error,
    { keyIds: string[] }
  >({
    mutationFn: async (request) => {
      if (!client || !connectionConfig) throw new Error('Not connected');
      const queryString = new URLSearchParams();
      if (instanceId) queryString.set('instanceId', instanceId);
      const response = await fetch(
        buildConsoleUrl(
          connectionConfig.serverUrl,
          '/console/api-keys/bulk-revoke',
          queryString
        ),
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${connectionConfig.token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(request),
        }
      );
      if (!response.ok) throw new Error('Failed to bulk revoke API keys');
      return response.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['console', 'api-keys'] });
    },
  });
}

export function useRotateApiKeyMutation() {
  const client = useApiClient();
  const { config: connectionConfig } = useConnection();
  const { instanceId } = useInstanceContext();
  const queryClient = useQueryClient();

  return useMutation<{ key: ConsoleApiKey; secretKey: string }, Error, string>({
    mutationFn: async (keyId) => {
      if (!client || !connectionConfig) throw new Error('Not connected');
      const queryString = new URLSearchParams();
      if (instanceId) queryString.set('instanceId', instanceId);
      const response = await fetch(
        buildConsoleUrl(
          connectionConfig.serverUrl,
          `/console/api-keys/${serializePathSegment(keyId)}/rotate`,
          queryString
        ),
        {
          method: 'POST',
          headers: { Authorization: `Bearer ${connectionConfig.token}` },
        }
      );
      if (!response.ok) throw new Error('Failed to rotate API key');
      return response.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['console', 'api-keys'] });
    },
  });
}

export function useStageRotateApiKeyMutation() {
  const client = useApiClient();
  const { config: connectionConfig } = useConnection();
  const { instanceId } = useInstanceContext();
  const queryClient = useQueryClient();

  return useMutation<{ key: ConsoleApiKey; secretKey: string }, Error, string>({
    mutationFn: async (keyId) => {
      if (!client || !connectionConfig) throw new Error('Not connected');
      const queryString = new URLSearchParams();
      if (instanceId) queryString.set('instanceId', instanceId);
      const response = await fetch(
        buildConsoleUrl(
          connectionConfig.serverUrl,
          `/console/api-keys/${serializePathSegment(keyId)}/rotate/stage`,
          queryString
        ),
        {
          method: 'POST',
          headers: { Authorization: `Bearer ${connectionConfig.token}` },
        }
      );
      if (!response.ok) throw new Error('Failed to stage-rotate API key');
      return response.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['console', 'api-keys'] });
    },
  });
}

// ---------------------------------------------------------------------------
// Blob storage hooks
// ---------------------------------------------------------------------------

export function useBlobs(
  options: {
    prefix?: string;
    cursor?: string;
    limit?: number;
    refetchIntervalMs?: number;
  } = {}
) {
  const { config: connectionConfig } = useConnection();
  return useQuery<ConsoleBlobListResponse>({
    queryKey: queryKeys.storage({
      prefix: options.prefix,
      cursor: options.cursor,
      limit: options.limit,
    }),
    queryFn: async () => {
      if (!connectionConfig) throw new Error('Not connected');
      const queryString = new URLSearchParams();
      if (options.prefix) queryString.set('prefix', options.prefix);
      if (options.cursor) queryString.set('cursor', options.cursor);
      if (options.limit) queryString.set('limit', String(options.limit));
      const response = await fetch(
        buildConsoleUrl(
          connectionConfig.serverUrl,
          '/console/storage',
          queryString
        ),
        {
          method: 'GET',
          headers: { Authorization: `Bearer ${connectionConfig.token}` },
        }
      );
      if (!response.ok) throw new Error('Failed to list blobs');
      return response.json();
    },
    enabled: !!connectionConfig,
    refetchInterval: resolveRefetchInterval(options.refetchIntervalMs, 30000),
  });
}

export function useDeleteBlobMutation() {
  const { config: connectionConfig } = useConnection();
  const queryClient = useQueryClient();
  return useMutation<{ deleted: boolean }, Error, string>({
    mutationFn: async (key: string) => {
      if (!connectionConfig) throw new Error('Not connected');
      const encodedKey = encodeURIComponent(key);
      const response = await fetch(
        buildConsoleUrl(
          connectionConfig.serverUrl,
          `/console/storage/${encodedKey}`,
          new URLSearchParams()
        ),
        {
          method: 'DELETE',
          headers: { Authorization: `Bearer ${connectionConfig.token}` },
        }
      );
      if (!response.ok) throw new Error('Failed to delete blob');
      return response.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['console', 'storage'] });
    },
  });
}

export function useBlobDownload() {
  const { config: connectionConfig } = useConnection();
  return async (key: string) => {
    if (!connectionConfig) throw new Error('Not connected');
    const encodedKey = encodeURIComponent(key);
    const response = await fetch(
      buildConsoleUrl(
        connectionConfig.serverUrl,
        `/console/storage/${encodedKey}/download`,
        new URLSearchParams()
      ),
      {
        method: 'GET',
        headers: { Authorization: `Bearer ${connectionConfig.token}` },
      }
    );
    if (!response.ok) throw new Error('Failed to download blob');
    const blob = await response.blob();
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
