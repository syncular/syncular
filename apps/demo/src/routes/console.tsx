import {
  type ConnectionConfig,
  ConnectionProvider,
  ConsoleLayout,
} from '@syncular/console-app';
import { createRoute } from '@tanstack/react-router';
import { useMemo } from 'react';
import { Route as rootRoute } from './__root';

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
      <ConsoleLayout basePath="/console" />
    </ConnectionProvider>
  );
}

export const Route = createRoute({
  getParentRoute: () => rootRoute,
  path: '/console',
  component: ConsoleWrapper,
});
