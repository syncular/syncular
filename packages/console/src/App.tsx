import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createRouter, RouterProvider } from '@tanstack/react-router';
import { useMemo, useState } from 'react';
import {
  ConnectionProvider,
  type ConnectionStorageMode,
} from './hooks/ConnectionContext';
import type { ConnectionConfig } from './lib/api';
import { routeTree } from './routeTree';
import {
  normalizeBasePath,
  resolveConsoleBasePathFromMeta,
  resolveConsoleConnectionConfigFromMeta,
} from './runtime-config';
import { SYNCULAR_CONSOLE_ROOT_CLASS } from './theme-scope';

export interface SyncularConsoleProps {
  basePath?: string;
  defaultConfig?: ConnectionConfig | null;
  autoConnect?: boolean;
  storageMode?: ConnectionStorageMode;
}

function createDefaultQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 5000,
        retry: 1,
      },
    },
  });
}

function resolveBasePath(basePath: string | undefined): string {
  return normalizeBasePath(basePath ?? resolveConsoleBasePathFromMeta());
}

function SyncularConsole(props: SyncularConsoleProps) {
  const [queryClient] = useState(() => createDefaultQueryClient());
  const router = useMemo(
    () =>
      createRouter({ routeTree, basepath: resolveBasePath(props.basePath) }),
    [props.basePath]
  );

  const defaultConfig =
    props.defaultConfig === undefined
      ? resolveConsoleConnectionConfigFromMeta()
      : props.defaultConfig;
  const autoConnect = props.autoConnect ?? props.defaultConfig === undefined;

  return (
    <QueryClientProvider client={queryClient}>
      <ConnectionProvider
        defaultConfig={defaultConfig}
        autoConnect={autoConnect}
        storageMode={props.storageMode}
      >
        <RouterProvider router={router} />
      </ConnectionProvider>
    </QueryClientProvider>
  );
}

export function App(props: SyncularConsoleProps) {
  return (
    <div className={SYNCULAR_CONSOLE_ROOT_CLASS}>
      <SyncularConsole {...props} />
    </div>
  );
}
