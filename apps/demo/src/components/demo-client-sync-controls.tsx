import { SyncControls } from '@syncular/ui/demo';
import { useCallback, useEffect, useState } from 'react';
import {
  type ActiveClientResetOptions,
  registerActiveDemoClientResetter,
} from '../client/demo-data-reset';
import { resetClientData } from '../client/migrate';
import {
  useSyncConnection,
  useSyncContext,
  useSyncEngine,
} from '../client/react';

interface UseDemoClientSyncControlsOptions {
  clientKey: string;
  onAfterReset?: () => Promise<void> | void;
}

interface ResetLocalOptions {
  reconnect?: boolean;
}

interface DemoClientSyncControlsState {
  isOffline: boolean;
  isResetting: boolean;
  resetError: string | null;
  toggleOffline: () => void;
  resetLocalData: (options?: ResetLocalOptions) => Promise<void>;
  clearResetError: () => void;
}

export function useDemoClientSyncControls(
  options: UseDemoClientSyncControlsOptions
): DemoClientSyncControlsState {
  const { clientKey, onAfterReset } = options;
  const { db } = useSyncContext();
  const engine = useSyncEngine();
  const connection = useSyncConnection();

  const [isResetting, setIsResetting] = useState(false);
  const [resetError, setResetError] = useState<string | null>(null);

  const toggleOffline = useCallback(() => {
    if (connection.isConnected) {
      engine.disconnect();
    } else {
      engine.reconnect();
    }
  }, [connection.isConnected, engine]);

  const resetLocalData = useCallback(
    async (options?: ResetLocalOptions) => {
      if (isResetting) return;

      const reconnect = options?.reconnect ?? true;
      const wasOnline = connection.isConnected;

      setIsResetting(true);
      setResetError(null);

      try {
        engine.disconnect();
        await resetClientData(db);
        await onAfterReset?.();

        if (reconnect && wasOnline) {
          await new Promise((resolve) => setTimeout(resolve, 50));
          engine.reconnect();
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        setResetError(message);
        throw error;
      } finally {
        setIsResetting(false);
      }
    },
    [connection.isConnected, db, engine, isResetting, onAfterReset]
  );

  useEffect(
    () =>
      registerActiveDemoClientResetter(
        clientKey,
        async (activeResetOptions: ActiveClientResetOptions) => {
          await resetLocalData({ reconnect: activeResetOptions.reconnect });
        }
      ),
    [clientKey, resetLocalData]
  );

  return {
    isOffline: !connection.isConnected,
    isResetting,
    resetError,
    toggleOffline,
    resetLocalData,
    clearResetError: () => setResetError(null),
  };
}

export function DemoClientSyncControls(props: {
  controls: DemoClientSyncControlsState;
  className?: string;
}) {
  const { controls, className } = props;
  const wrapperClassName = ['flex items-center gap-2', className]
    .filter(Boolean)
    .join(' ');

  return (
    <div className={wrapperClassName}>
      <SyncControls
        isOffline={controls.isOffline}
        onToggleOffline={controls.toggleOffline}
        onReset={() => void controls.resetLocalData()}
      />
      {controls.isResetting ? (
        <span className="font-mono text-[9px] text-neutral-600">
          Resetting...
        </span>
      ) : null}
    </div>
  );
}
