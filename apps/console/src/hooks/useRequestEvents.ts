/**
 * React Query hooks for Request Events
 */

import { unwrap } from '@syncular/transport-http';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useApiClient } from './ConnectionContext';

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
