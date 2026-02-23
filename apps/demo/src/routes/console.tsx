import {
  type ConnectionConfig,
  ConnectionProvider,
  ConsoleLayout,
  useConnection,
} from '@syncular/console';
import { createRoute } from '@tanstack/react-router';
import { useEffect, useMemo } from 'react';
import { Route as rootRoute } from './__root';

function ConsoleAutoConnect() {
  const { config, isConnected, isConnecting, connect } = useConnection();

  useEffect(() => {
    if (isConnected || isConnecting) return;
    if (!config?.serverUrl?.trim() || !config.token?.trim()) return;
    void connect();
  }, [config, isConnected, isConnecting, connect]);

  return null;
}

function ConsoleWrapper() {
  const defaultConfig = useMemo<ConnectionConfig | null>(() => {
    if (typeof window === 'undefined') return null;
    return {
      serverUrl: new URL('/api', window.location.origin).toString(),
      token: 'demo-token',
    };
  }, []);

  return (
    <ConnectionProvider defaultConfig={defaultConfig}>
      <ConsoleAutoConnect />
      <ConsoleLayout
        basePath="/console"
        appHref="/"
        modeBadge={
          <span title="This demo runs entirely in-browser via a service-worker server and local SQLite storage.">
            SW Offline Demo
          </span>
        }
      />
    </ConnectionProvider>
  );
}

export const Route = createRoute({
  getParentRoute: () => rootRoute,
  path: '/console',
  component: ConsoleWrapper,
});
