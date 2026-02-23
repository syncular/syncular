import type {
  SyncClientDb,
  SyncEngine,
  SyncProgress,
  SyncRepairOptions,
  SyncResetOptions,
  SyncResetResult,
  SyncResult,
  SyncTransportMode,
  TransportHealth,
} from '@syncular/client';
import { useCallback, useMemo, useSyncExternalStore } from 'react';

export interface SyncGroupChannel<DB extends SyncClientDb = SyncClientDb> {
  id: string;
  engine: SyncEngine<DB>;
}

export interface SyncGroupStatus {
  phase: 'idle' | 'syncing' | 'live' | 'error';
  isOnline: boolean;
  isSyncing: boolean;
  pendingCount: number;
  retryCount: number;
  hasError: boolean;
}

export interface SyncGroupChannelSnapshot {
  id: string;
  transportMode: SyncTransportMode;
  transport: TransportHealth;
  isOnline: boolean;
  isSyncing: boolean;
  pendingCount: number;
  retryCount: number;
  lastSyncAt: number | null;
  error: { code: string; message: string } | null;
}

export interface UseSyncGroupResult {
  status: SyncGroupStatus;
  channels: SyncGroupChannelSnapshot[];
  syncNow: () => Promise<SyncResult[]>;
  reset: (options: SyncResetOptions) => Promise<SyncResetResult[]>;
  repair: (options: SyncRepairOptions) => Promise<SyncResetResult[]>;
  getProgress: () => Promise<Array<{ id: string; progress: SyncProgress }>>;
}

export function useSyncGroup<DB extends SyncClientDb = SyncClientDb>(args: {
  channels: SyncGroupChannel<DB>[];
}): UseSyncGroupResult {
  const { channels } = args;

  const subscribe = useCallback(
    (callback: () => void) => {
      const unsubs = channels.flatMap((channel) => [
        channel.engine.subscribe(callback),
        channel.engine.on('connection:change', callback),
        channel.engine.on('sync:complete', callback),
        channel.engine.on('sync:error', callback),
        channel.engine.on('outbox:change', callback),
      ]);

      return () => {
        for (const unsubscribe of unsubs) unsubscribe();
      };
    },
    [channels]
  );

  const getSnapshot = useCallback(
    () =>
      channels.map((channel) => {
        const state = channel.engine.getState();
        const transport = channel.engine.getTransportHealth();

        return {
          id: channel.id,
          transportMode: state.transportMode,
          transport,
          isOnline: state.connectionState === 'connected',
          isSyncing: state.isSyncing,
          pendingCount: state.pendingCount,
          retryCount: state.retryCount,
          lastSyncAt: state.lastSyncAt,
          error: state.error
            ? { code: state.error.code, message: state.error.message }
            : null,
        };
      }),
    [channels]
  );

  const channelSnapshots = useSyncExternalStore(
    subscribe,
    getSnapshot,
    getSnapshot
  );

  const status = useMemo<SyncGroupStatus>(() => {
    const hasError = channelSnapshots.some((channel) => channel.error !== null);
    const isSyncing = channelSnapshots.some((channel) => channel.isSyncing);
    const isOnline =
      channelSnapshots.length > 0 &&
      channelSnapshots.every((channel) => channel.isOnline);
    const pendingCount = channelSnapshots.reduce(
      (sum, channel) => sum + channel.pendingCount,
      0
    );
    const retryCount = channelSnapshots.reduce(
      (sum, channel) => sum + channel.retryCount,
      0
    );

    const phase: SyncGroupStatus['phase'] = hasError
      ? 'error'
      : isSyncing
        ? 'syncing'
        : channelSnapshots.every((channel) => channel.lastSyncAt !== null)
          ? 'live'
          : 'idle';

    return {
      phase,
      isOnline,
      isSyncing,
      pendingCount,
      retryCount,
      hasError,
    };
  }, [channelSnapshots]);

  const syncNow = useCallback(
    () => Promise.all(channels.map((channel) => channel.engine.sync())),
    [channels]
  );

  const reset = useCallback(
    (options: SyncResetOptions) =>
      Promise.all(channels.map((channel) => channel.engine.reset(options))),
    [channels]
  );

  const repair = useCallback(
    (options: SyncRepairOptions) =>
      Promise.all(channels.map((channel) => channel.engine.repair(options))),
    [channels]
  );

  const getProgress = useCallback(
    () =>
      Promise.all(
        channels.map(async (channel) => ({
          id: channel.id,
          progress: await channel.engine.getProgress(),
        }))
      ),
    [channels]
  );

  return {
    status,
    channels: channelSnapshots,
    syncNow,
    reset,
    repair,
    getProgress,
  };
}
