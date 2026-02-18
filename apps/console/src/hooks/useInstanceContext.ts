import { useMemo } from 'react';
import { useLocalStorage } from './useLocalStorage';

interface InstanceContext {
  instanceId: string | undefined;
  rawInstanceId: string;
  setInstanceId: (value: string) => void;
  clearInstanceId: () => void;
}

const INSTANCE_STORAGE_KEY = 'console:instance-id';

export function useInstanceContext(): InstanceContext {
  const [rawInstanceId, setRawInstanceId] = useLocalStorage<string>(
    INSTANCE_STORAGE_KEY,
    ''
  );

  const normalizedInstanceId = rawInstanceId.trim();

  return useMemo(
    () => ({
      instanceId:
        normalizedInstanceId.length > 0 ? normalizedInstanceId : undefined,
      rawInstanceId,
      setInstanceId: setRawInstanceId,
      clearInstanceId: () => setRawInstanceId(''),
    }),
    [normalizedInstanceId, rawInstanceId, setRawInstanceId]
  );
}
