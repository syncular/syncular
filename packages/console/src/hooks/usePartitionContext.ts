import { useMemo } from 'react';
import { useLocalStorage } from './useLocalStorage';

interface PartitionContext {
  partitionId: string | undefined;
  rawPartitionId: string;
  setPartitionId: (value: string) => void;
  clearPartitionId: () => void;
}

const PARTITION_STORAGE_KEY = 'console:partition-id';

export function usePartitionContext(): PartitionContext {
  const [rawPartitionId, setRawPartitionId] = useLocalStorage<string>(
    PARTITION_STORAGE_KEY,
    ''
  );

  const normalizedPartitionId = rawPartitionId.trim();

  return useMemo(
    () => ({
      partitionId:
        normalizedPartitionId.length > 0 ? normalizedPartitionId : undefined,
      rawPartitionId,
      setPartitionId: setRawPartitionId,
      clearPartitionId: () => setRawPartitionId(''),
    }),
    [normalizedPartitionId, rawPartitionId, setRawPartitionId]
  );
}
