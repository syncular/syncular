/**
 * React Query hooks for Request Events
 */

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useApiClient, useConnection } from './ConnectionContext';
import { useInstanceContext } from './useInstanceContext';

export function useClearEventsMutation() {
  const client = useApiClient();
  const { config: connectionConfig } = useConnection();
  const { instanceId } = useInstanceContext();
  const queryClient = useQueryClient();

  return useMutation<{ deletedCount: number }, Error, void>({
    mutationFn: async () => {
      if (!client || !connectionConfig) throw new Error('Not connected');
      const queryString = new URLSearchParams();
      if (instanceId) queryString.set('instanceId', instanceId);
      const suffix = queryString.toString();
      const response = await fetch(
        `${connectionConfig.serverUrl}/console/events${suffix ? `?${suffix}` : ''}`,
        {
          method: 'DELETE',
          headers: { Authorization: `Bearer ${connectionConfig.token}` },
        }
      );
      if (!response.ok) throw new Error('Failed to clear events');
      return response.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['console', 'events'] });
    },
  });
}
