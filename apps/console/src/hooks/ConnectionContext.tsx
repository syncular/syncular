/**
 * Connection context for shared connection state across components
 */

import type { SyncClient } from '@syncular/transport-http';
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react';
import {
  type ConnectionConfig,
  createConsoleClient,
  testConnection,
} from '../lib/api';
import { useLocalStorage } from './useLocalStorage';

interface ConnectionState {
  isConnected: boolean;
  isConnecting: boolean;
  error: string | null;
  client: SyncClient | null;
}

interface ConnectionContextValue {
  config: ConnectionConfig | null;
  setConfig: (config: ConnectionConfig) => void;
  isConnected: boolean;
  isConnecting: boolean;
  error: string | null;
  client: SyncClient | null;
  connect: (overrideConfig?: ConnectionConfig) => Promise<boolean>;
  disconnect: () => void;
  clearError: () => void;
}

interface ConnectionProviderProps {
  children: ReactNode;
  defaultConfig?: ConnectionConfig | null;
}

const ConnectionContext = createContext<ConnectionContextValue | null>(null);

export function ConnectionProvider({
  children,
  defaultConfig = null,
}: ConnectionProviderProps) {
  const [config, setConfigStorage] = useLocalStorage<ConnectionConfig | null>(
    'sync-console-connection',
    null
  );

  const [state, setState] = useState<ConnectionState>({
    isConnected: false,
    isConnecting: false,
    error: null,
    client: null,
  });

  // Resolve initial config: URL params -> saved config -> provided defaults -> env
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const params = new URLSearchParams(window.location.search);
    const server = params.get('server');
    const token = params.get('token');
    if (server && token) {
      setConfigStorage({ serverUrl: server, token });
      // Clean up URL
      window.history.replaceState({}, '', window.location.pathname);
      return;
    }

    if (config?.serverUrl?.trim() && config.token?.trim()) {
      return;
    }

    if (defaultConfig?.serverUrl?.trim() && defaultConfig.token?.trim()) {
      setConfigStorage({
        serverUrl: defaultConfig.serverUrl.trim(),
        token: defaultConfig.token.trim(),
      });
      return;
    }

    const envServerUrl = process.env.SYNCULAR_SERVER_URL;
    const envToken = process.env.SYNCULAR_CONSOLE_TOKEN;

    if (envServerUrl?.trim() && envToken?.trim()) {
      setConfigStorage({ serverUrl: envServerUrl, token: envToken });
    }
  }, [setConfigStorage, config, defaultConfig]);

  const connect = useCallback(
    async (overrideConfig?: ConnectionConfig) => {
      const effectiveConfig = overrideConfig ?? config;
      if (!effectiveConfig) {
        setState((s) => ({ ...s, error: 'No connection configured' }));
        return false;
      }

      // Validate config has required fields
      if (!effectiveConfig.serverUrl?.trim()) {
        setState((s) => ({ ...s, error: 'Server URL is required' }));
        return false;
      }
      if (!effectiveConfig.token?.trim()) {
        setState((s) => ({ ...s, error: 'Token is required' }));
        return false;
      }

      setState((s) => ({ ...s, isConnecting: true, error: null }));

      try {
        const client = createConsoleClient(effectiveConfig);
        const ok = await testConnection(client);

        if (ok) {
          setState({
            isConnected: true,
            isConnecting: false,
            client,
            error: null,
          });
          return true;
        }
        setState({
          isConnected: false,
          isConnecting: false,
          client: null,
          error: 'Failed to connect',
        });
        return false;
      } catch (err) {
        setState({
          isConnected: false,
          isConnecting: false,
          client: null,
          error: err instanceof Error ? err.message : 'Connection failed',
        });
        return false;
      }
    },
    [config]
  );

  const disconnect = useCallback(() => {
    setState({
      isConnected: false,
      isConnecting: false,
      client: null,
      error: null,
    });
  }, []);

  const clearError = useCallback(() => {
    setState((s) => ({ ...s, error: null }));
  }, []);

  const setConfig = useCallback(
    (newConfig: ConnectionConfig) => {
      setConfigStorage(newConfig);
      setState({
        isConnected: false,
        isConnecting: false,
        client: null,
        error: null,
      });
    },
    [setConfigStorage]
  );

  // Auto-connect on mount or when config changes (if valid config exists)
  useEffect(() => {
    if (
      config?.serverUrl?.trim() &&
      config.token?.trim() &&
      !state.isConnected &&
      !state.isConnecting &&
      !state.error
    ) {
      connect();
    }
  }, [config, state.isConnected, state.isConnecting, state.error, connect]);

  const value = useMemo(
    () => ({
      config,
      setConfig,
      isConnected: state.isConnected,
      isConnecting: state.isConnecting,
      error: state.error,
      client: state.client,
      connect,
      disconnect,
      clearError,
    }),
    [config, setConfig, state, connect, disconnect, clearError]
  );

  return (
    <ConnectionContext.Provider value={value}>
      {children}
    </ConnectionContext.Provider>
  );
}

export function useConnection(): ConnectionContextValue {
  const context = useContext(ConnectionContext);
  if (!context) {
    throw new Error('useConnection must be used within a ConnectionProvider');
  }
  return context;
}

export function useApiClient(): SyncClient | null {
  const { client } = useConnection();
  return client;
}
