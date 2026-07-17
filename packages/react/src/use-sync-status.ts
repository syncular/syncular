import type {
  LeaseState,
  SchemaFloor,
  SyncAvailability,
} from '@syncular/client';
import { useCallback, useSyncExternalStore } from 'react';
import { useReactiveStore } from './use-client';

export interface SyncStatus {
  readonly currentSchemaVersion: number | undefined;
  readonly outbox: number;
  readonly upgrading: boolean;
  readonly leaseState: LeaseState | undefined;
  readonly schemaFloor: SchemaFloor | undefined;
  readonly syncNeeded: boolean;
  readonly isLoading: boolean;
  readonly error: Error | undefined;
  readonly availability: SyncAvailability;
  readonly refresh: () => void;
}

export function useSyncStatus(): SyncStatus {
  const store = useReactiveStore();
  const entry = store.status;
  const snapshot = useSyncExternalStore(
    entry.subscribe,
    entry.getSnapshot,
    entry.getSnapshot,
  );
  const refresh = useCallback(() => entry.refresh(), [entry]);
  return {
    currentSchemaVersion: snapshot.status?.currentSchemaVersion,
    outbox: snapshot.status?.outbox ?? 0,
    upgrading: snapshot.status?.upgrading ?? false,
    leaseState: snapshot.status?.leaseState,
    schemaFloor: snapshot.status?.schemaFloor,
    syncNeeded: snapshot.status?.syncNeeded ?? false,
    isLoading: snapshot.isLoading,
    error: snapshot.error,
    availability: store.availabilitySnapshot(),
    refresh,
  };
}
