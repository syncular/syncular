/**
 * React Query hooks for Request Events
 */

import { unwrap } from '@syncular/transport-http';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ConsoleRequestEvent, PaginatedResponse } from '@/lib/types';
import { useApiClient } from './ConnectionContext';

const queryKeys = {
  events: (params?: {
    limit?: number;
    offset?: number;
    eventType?: 'push' | 'pull';
    actorId?: string;
    clientId?: string;
    outcome?: string;
  }) => ['console', 'events', params] as const,
};

export function useRequestEvents(
  params: {
    limit?: number;
    offset?: number;
    eventType?: 'push' | 'pull';
    actorId?: string;
    clientId?: string;
    outcome?: string;
  } = {}
) {
  const client = useApiClient();

  return useQuery<PaginatedResponse<ConsoleRequestEvent>>({
    queryKey: queryKeys.events(params),
    queryFn: () => {
      if (!client) throw new Error('Not connected');
      return unwrap(
        client.GET('/console/events', { params: { query: params } })
      );
    },
    enabled: !!client,
    refetchInterval: 10000,
  });
}

export function useClearEventsMutation() {
  const client = useApiClient();
  const queryClient = useQueryClient();

  return useMutation<{ deletedCount: number }, Error, void>({
    mutationFn: () => {
      if (!client) throw new Error('Not connected');
      return unwrap(client.DELETE('/console/events'));
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['console', 'events'] });
    },
  });
}
