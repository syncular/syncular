/**
 * React Query hooks for Console API
 */

import { unwrap } from '@syncular/transport-http';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  ConsoleApiKey,
  ConsoleClient,
  ConsoleCommitListItem,
  ConsoleHandler,
  LatencyStatsResponse,
  PaginatedResponse,
  SyncStats,
  TimeseriesInterval,
  TimeseriesRange,
  TimeseriesStatsResponse,
} from '../lib/types';
import { useApiClient, useConnection } from './ConnectionContext';

const queryKeys = {
  stats: ['console', 'stats'] as const,
  timeseries: (params?: {
    interval?: TimeseriesInterval;
    range?: TimeseriesRange;
  }) => ['console', 'stats', 'timeseries', params] as const,
  latency: (params?: { range?: TimeseriesRange }) =>
    ['console', 'stats', 'latency', params] as const,
  commits: (params?: { limit?: number; offset?: number }) =>
    ['console', 'commits', params] as const,
  clients: (params?: { limit?: number; offset?: number }) =>
    ['console', 'clients', params] as const,
  handlers: ['console', 'handlers'] as const,
  prunePreview: ['console', 'prune', 'preview'] as const,
  apiKeys: (params?: {
    limit?: number;
    offset?: number;
    type?: 'relay' | 'proxy' | 'admin';
  }) => ['console', 'api-keys', params] as const,
};

export function useStats() {
  const client = useApiClient();

  return useQuery<SyncStats>({
    queryKey: queryKeys.stats,
    queryFn: () => {
      if (!client) throw new Error('Not connected');
      return unwrap(client.GET('/console/stats'));
    },
    enabled: !!client,
    refetchInterval: 5000,
  });
}

export function useTimeseriesStats(
  params: { interval?: TimeseriesInterval; range?: TimeseriesRange } = {}
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
      const response = await fetch(
        `${connectionConfig.serverUrl}/console/stats/timeseries?${queryString}`,
        { headers: { Authorization: `Bearer ${connectionConfig.token}` } }
      );
      if (!response.ok) throw new Error('Failed to fetch timeseries stats');
      return response.json();
    },
    enabled: !!client && !!connectionConfig,
    refetchInterval: 30000, // Refresh every 30 seconds
  });
}

export function useLatencyStats(params: { range?: TimeseriesRange } = {}) {
  const client = useApiClient();
  const { config: connectionConfig } = useConnection();

  return useQuery<LatencyStatsResponse>({
    queryKey: queryKeys.latency(params),
    queryFn: async () => {
      if (!client || !connectionConfig) throw new Error('Not connected');
      // Use fetch directly since this endpoint may not be in OpenAPI yet
      const queryString = new URLSearchParams();
      if (params.range) queryString.set('range', params.range);
      const response = await fetch(
        `${connectionConfig.serverUrl}/console/stats/latency?${queryString}`,
        { headers: { Authorization: `Bearer ${connectionConfig.token}` } }
      );
      if (!response.ok) throw new Error('Failed to fetch latency stats');
      return response.json();
    },
    enabled: !!client && !!connectionConfig,
    refetchInterval: 30000, // Refresh every 30 seconds
  });
}

export function useCommits(params: { limit?: number; offset?: number } = {}) {
  const client = useApiClient();

  return useQuery<PaginatedResponse<ConsoleCommitListItem>>({
    queryKey: queryKeys.commits(params),
    queryFn: () => {
      if (!client) throw new Error('Not connected');
      return unwrap(
        client.GET('/console/commits', { params: { query: params } })
      );
    },
    enabled: !!client,
  });
}

export function useClients(params: { limit?: number; offset?: number } = {}) {
  const client = useApiClient();

  return useQuery<PaginatedResponse<ConsoleClient>>({
    queryKey: queryKeys.clients(params),
    queryFn: () => {
      if (!client) throw new Error('Not connected');
      return unwrap(
        client.GET('/console/clients', { params: { query: params } })
      );
    },
    enabled: !!client,
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

export function useEvictClientMutation() {
  const client = useApiClient();
  const queryClient = useQueryClient();

  return useMutation<{ evicted: boolean }, Error, string>({
    mutationFn: (clientId) => {
      if (!client) throw new Error('Not connected');
      return unwrap(
        client.DELETE('/console/clients/{id}', {
          params: { path: { id: clientId } },
        })
      );
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.clients() });
      queryClient.invalidateQueries({ queryKey: queryKeys.stats });
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
      queryClient.invalidateQueries({ queryKey: queryKeys.stats });
      queryClient.invalidateQueries({ queryKey: queryKeys.commits() });
      queryClient.invalidateQueries({ queryKey: queryKeys.prunePreview });
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
      queryClient.invalidateQueries({ queryKey: queryKeys.stats });
    },
  });
}

export function useApiKeys(
  params: {
    limit?: number;
    offset?: number;
    type?: 'relay' | 'proxy' | 'admin';
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
      queryClient.invalidateQueries({ queryKey: queryKeys.apiKeys() });
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
      queryClient.invalidateQueries({ queryKey: queryKeys.apiKeys() });
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
      queryClient.invalidateQueries({ queryKey: queryKeys.apiKeys() });
    },
  });
}
