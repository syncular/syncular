/**
 * React Query hooks for Console API
 */

import { unwrap } from '@syncular/transport-http';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  ConsoleApiKey,
  ConsoleApiKeyBulkRevokeResponse,
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

const queryKeys = {
  stats: (params?: { partitionId?: string }) =>
    ['console', 'stats', params] as const,
  timeseries: (params?: {
    interval?: TimeseriesInterval;
    range?: TimeseriesRange;
    partitionId?: string;
  }) => ['console', 'stats', 'timeseries', params] as const,
  latency: (params?: { range?: TimeseriesRange; partitionId?: string }) =>
    ['console', 'stats', 'latency', params] as const,
  commits: (params?: {
    limit?: number;
    offset?: number;
    partitionId?: string;
  }) => ['console', 'commits', params] as const,
  commitDetail: (seq?: number, partitionId?: string) =>
    ['console', 'commit-detail', seq, partitionId] as const,
  timeline: (params?: {
    limit?: number;
    offset?: number;
    partitionId?: string;
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
  }) => ['console', 'clients', params] as const,
  eventDetail: (id?: number, partitionId?: string) =>
    ['console', 'event-detail', id, partitionId] as const,
  eventPayload: (id?: number, partitionId?: string) =>
    ['console', 'event-payload', id, partitionId] as const,
  handlers: ['console', 'handlers'] as const,
  prunePreview: ['console', 'prune', 'preview'] as const,
  operations: (params?: {
    limit?: number;
    offset?: number;
    operationType?: ConsoleOperationType;
    partitionId?: string;
  }) => ['console', 'operations', params] as const,
  apiKeys: (params?: {
    limit?: number;
    offset?: number;
    type?: 'relay' | 'proxy' | 'admin';
    status?: 'active' | 'revoked' | 'expiring';
    expiresWithinDays?: number;
  }) => ['console', 'api-keys', params] as const,
};

function resolveRefetchInterval(
  refreshIntervalMs: number | undefined,
  defaultValueMs: number
): number | false {
  if (refreshIntervalMs === 0) return false;
  return refreshIntervalMs ?? defaultValueMs;
}

export function useStats(
  options: { refetchIntervalMs?: number; partitionId?: string } = {}
) {
  const client = useApiClient();
  const query = options.partitionId ? { partitionId: options.partitionId } : {};

  return useQuery<SyncStats>({
    queryKey: queryKeys.stats({ partitionId: options.partitionId }),
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
  } = {},
  options: { refetchIntervalMs?: number; enabled?: boolean } = {}
) {
  const client = useApiClient();
  const { config: connectionConfig } = useConnection();

  return useQuery<TimeseriesStatsResponse>({
    queryKey: queryKeys.timeseries(params),
    queryFn: async () => {
      if (!client || !connectionConfig) throw new Error('Not connected');
      // Use fetch directly since this endpoint may not be in OpenAPI yet
      const queryString = new URLSearchParams();
      if (params.interval) queryString.set('interval', params.interval);
      if (params.range) queryString.set('range', params.range);
      if (params.partitionId)
        queryString.set('partitionId', params.partitionId);
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
  params: { range?: TimeseriesRange; partitionId?: string } = {},
  options: { refetchIntervalMs?: number; enabled?: boolean } = {}
) {
  const client = useApiClient();
  const { config: connectionConfig } = useConnection();

  return useQuery<LatencyStatsResponse>({
    queryKey: queryKeys.latency(params),
    queryFn: async () => {
      if (!client || !connectionConfig) throw new Error('Not connected');
      // Use fetch directly since this endpoint may not be in OpenAPI yet
      const queryString = new URLSearchParams();
      if (params.range) queryString.set('range', params.range);
      if (params.partitionId)
        queryString.set('partitionId', params.partitionId);
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
  params: { limit?: number; offset?: number; partitionId?: string } = {},
  options: { refetchIntervalMs?: number; enabled?: boolean } = {}
) {
  const client = useApiClient();

  return useQuery<PaginatedResponse<ConsoleCommitListItem>>({
    queryKey: queryKeys.commits(params),
    queryFn: () => {
      if (!client) throw new Error('Not connected');
      return unwrap(
        client.GET('/console/commits', { params: { query: params } })
      );
    },
    enabled: (options.enabled ?? true) && !!client,
    refetchInterval: resolveRefetchInterval(options.refetchIntervalMs, 10000),
  });
}

export function useCommitDetail(
  seq: number | undefined,
  options: { enabled?: boolean; partitionId?: string } = {}
) {
  const client = useApiClient();

  return useQuery<ConsoleCommitDetail>({
    queryKey: queryKeys.commitDetail(seq, options.partitionId),
    queryFn: () => {
      if (!client) throw new Error('Not connected');
      if (seq === undefined) throw new Error('Commit sequence is required');
      return unwrap(
        client.GET('/console/commits/{seq}', {
          params: {
            path: { seq },
            ...(options.partitionId
              ? { query: { partitionId: options.partitionId } }
              : {}),
          },
        })
      );
    },
    enabled: (options.enabled ?? true) && seq !== undefined && !!client,
  });
}

export function useTimeline(
  params: {
    limit?: number;
    offset?: number;
    partitionId?: string;
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

  return useQuery<PaginatedResponse<ConsoleTimelineItem>>({
    queryKey: queryKeys.timeline(params),
    queryFn: () => {
      if (!client) throw new Error('Not connected');
      return unwrap(
        client.GET('/console/timeline', { params: { query: params } })
      );
    },
    enabled: (options.enabled ?? true) && !!client,
    refetchInterval: resolveRefetchInterval(options.refetchIntervalMs, 10000),
  });
}

export function useClients(
  params: { limit?: number; offset?: number; partitionId?: string } = {},
  options: { refetchIntervalMs?: number; enabled?: boolean } = {}
) {
  const client = useApiClient();

  return useQuery<PaginatedResponse<ConsoleClient>>({
    queryKey: queryKeys.clients(params),
    queryFn: () => {
      if (!client) throw new Error('Not connected');
      return unwrap(
        client.GET('/console/clients', { params: { query: params } })
      );
    },
    enabled: (options.enabled ?? true) && !!client,
    refetchInterval: resolveRefetchInterval(options.refetchIntervalMs, 10000),
  });
}

export function useRequestEventDetail(
  id: number | undefined,
  options: { enabled?: boolean; partitionId?: string } = {}
) {
  const client = useApiClient();

  return useQuery<ConsoleRequestEvent>({
    queryKey: queryKeys.eventDetail(id, options.partitionId),
    queryFn: () => {
      if (!client) throw new Error('Not connected');
      if (id === undefined) throw new Error('Event id is required');
      return unwrap(
        client.GET('/console/events/{id}', {
          params: {
            path: { id },
            ...(options.partitionId
              ? { query: { partitionId: options.partitionId } }
              : {}),
          },
        })
      );
    },
    enabled: (options.enabled ?? true) && id !== undefined && !!client,
  });
}

export function useRequestEventPayload(
  id: number | undefined,
  options: { enabled?: boolean; partitionId?: string } = {}
) {
  const client = useApiClient();

  return useQuery<ConsoleRequestPayload>({
    queryKey: queryKeys.eventPayload(id, options.partitionId),
    queryFn: () => {
      if (!client) throw new Error('Not connected');
      if (id === undefined) throw new Error('Event id is required');
      return unwrap(
        client.GET('/console/events/{id}/payload', {
          params: {
            path: { id },
            ...(options.partitionId
              ? { query: { partitionId: options.partitionId } }
              : {}),
          },
        })
      );
    },
    enabled: (options.enabled ?? true) && id !== undefined && !!client,
  });
}

export function useHandlers() {
  const client = useApiClient();

  return useQuery<{ items: ConsoleHandler[] }>({
    queryKey: queryKeys.handlers,
    queryFn: () => {
      if (!client) throw new Error('Not connected');
      return unwrap(client.GET('/console/handlers'));
    },
    enabled: !!client,
  });
}

export function usePrunePreview(options: { enabled?: boolean } = {}) {
  const client = useApiClient();

  return useQuery<{ watermarkCommitSeq: number; commitsToDelete: number }>({
    queryKey: queryKeys.prunePreview,
    queryFn: () => {
      if (!client) throw new Error('Not connected');
      return unwrap(client.POST('/console/prune/preview'));
    },
    enabled: !!client && (options.enabled ?? true),
  });
}

export function useOperationEvents(
  params: {
    limit?: number;
    offset?: number;
    operationType?: ConsoleOperationType;
    partitionId?: string;
  } = {},
  options: { enabled?: boolean; refetchIntervalMs?: number } = {}
) {
  const client = useApiClient();

  return useQuery<PaginatedResponse<ConsoleOperationEvent>>({
    queryKey: queryKeys.operations(params),
    queryFn: () => {
      if (!client) throw new Error('Not connected');
      return unwrap(
        client.GET('/console/operations', { params: { query: params } })
      );
    },
    enabled: (options.enabled ?? true) && !!client,
    refetchInterval: resolveRefetchInterval(options.refetchIntervalMs, 10000),
  });
}

export function useEvictClientMutation() {
  const client = useApiClient();
  const queryClient = useQueryClient();

  return useMutation<
    { evicted: boolean },
    Error,
    { clientId: string; partitionId?: string }
  >({
    mutationFn: ({ clientId, partitionId }) => {
      if (!client) throw new Error('Not connected');
      return unwrap(
        client.DELETE('/console/clients/{id}', {
          params: {
            path: { id: clientId },
            ...(partitionId ? { query: { partitionId } } : {}),
          },
        })
      );
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
  const queryClient = useQueryClient();

  return useMutation<{ deletedCommits: number }, Error, void>({
    mutationFn: () => {
      if (!client) throw new Error('Not connected');
      return unwrap(client.POST('/console/prune'));
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['console', 'stats'] });
      queryClient.invalidateQueries({ queryKey: ['console', 'commits'] });
      queryClient.invalidateQueries({ queryKey: ['console', 'timeline'] });
      queryClient.invalidateQueries({ queryKey: queryKeys.prunePreview });
      queryClient.invalidateQueries({ queryKey: ['console', 'operations'] });
    },
  });
}

export function useCompactMutation() {
  const client = useApiClient();
  const queryClient = useQueryClient();

  return useMutation<{ deletedChanges: number }, Error, void>({
    mutationFn: () => {
      if (!client) throw new Error('Not connected');
      return unwrap(client.POST('/console/compact'));
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['console', 'stats'] });
      queryClient.invalidateQueries({ queryKey: ['console', 'operations'] });
    },
  });
}

export function useNotifyDataChangeMutation() {
  const client = useApiClient();
  const queryClient = useQueryClient();

  return useMutation<
    ConsoleNotifyDataChangeResponse,
    Error,
    { tables: string[]; partitionId?: string }
  >({
    mutationFn: (request) => {
      if (!client) throw new Error('Not connected');
      return unwrap(
        client.POST('/console/notify-data-change', { body: request })
      );
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
  } = {}
) {
  const client = useApiClient();

  return useQuery<PaginatedResponse<ConsoleApiKey>>({
    queryKey: queryKeys.apiKeys(params),
    queryFn: () => {
      if (!client) throw new Error('Not connected');
      return unwrap(
        client.GET('/console/api-keys', { params: { query: params } })
      );
    },
    enabled: !!client,
  });
}

export function useCreateApiKeyMutation() {
  const client = useApiClient();
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
    mutationFn: (request) => {
      if (!client) throw new Error('Not connected');
      return unwrap(client.POST('/console/api-keys', { body: request }));
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['console', 'api-keys'] });
    },
  });
}

export function useRevokeApiKeyMutation() {
  const client = useApiClient();
  const queryClient = useQueryClient();

  return useMutation<{ revoked: boolean }, Error, string>({
    mutationFn: (keyId) => {
      if (!client) throw new Error('Not connected');
      return unwrap(
        client.DELETE('/console/api-keys/{id}', {
          params: { path: { id: keyId } },
        })
      );
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['console', 'api-keys'] });
    },
  });
}

export function useBulkRevokeApiKeysMutation() {
  const client = useApiClient();
  const queryClient = useQueryClient();

  return useMutation<
    ConsoleApiKeyBulkRevokeResponse,
    Error,
    { keyIds: string[] }
  >({
    mutationFn: (request) => {
      if (!client) throw new Error('Not connected');
      return unwrap(
        client.POST('/console/api-keys/bulk-revoke', { body: request })
      );
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['console', 'api-keys'] });
    },
  });
}

export function useRotateApiKeyMutation() {
  const client = useApiClient();
  const queryClient = useQueryClient();

  return useMutation<{ key: ConsoleApiKey; secretKey: string }, Error, string>({
    mutationFn: (keyId) => {
      if (!client) throw new Error('Not connected');
      return unwrap(
        client.POST('/console/api-keys/{id}/rotate', {
          params: { path: { id: keyId } },
        })
      );
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['console', 'api-keys'] });
    },
  });
}

export function useStageRotateApiKeyMutation() {
  const client = useApiClient();
  const queryClient = useQueryClient();

  return useMutation<{ key: ConsoleApiKey; secretKey: string }, Error, string>({
    mutationFn: (keyId) => {
      if (!client) throw new Error('Not connected');
      return unwrap(
        client.POST('/console/api-keys/{id}/rotate/stage', {
          params: { path: { id: keyId } },
        })
      );
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['console', 'api-keys'] });
    },
  });
}
