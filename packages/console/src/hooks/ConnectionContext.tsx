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
  useRef,
  useState,
} from 'react';
import {
  type ConnectionConfig,
  createConsoleClient,
  testConnection,
} from '../lib/api';

export type ConnectionStorageMode = 'memory' | 'session' | 'local';

const CONNECTION_STORAGE_KEY = 'sync-console-connection';

function normalizeConfig(
  config: ConnectionConfig | null | undefined
): ConnectionConfig | null {
  if (!config) return null;
  const serverUrl = config.serverUrl?.trim() ?? '';
  const token = config.token?.trim() ?? '';
  if (!serverUrl || !token) return null;
  return { serverUrl, token };
}

function getStorageForMode(mode: ConnectionStorageMode): Storage | null {
  if (typeof window === 'undefined') return null;
  if (mode === 'local') return window.localStorage;
  if (mode === 'session') return window.sessionStorage;
  return null;
}

function readStoredConfig(
  mode: ConnectionStorageMode
): ConnectionConfig | null {
  const storage = getStorageForMode(mode);
  if (!storage) return null;
  try {
    const raw = storage.getItem(CONNECTION_STORAGE_KEY);
    if (!raw) return null;
    return normalizeConfig(JSON.parse(raw) as ConnectionConfig);
  } catch {
    return null;
  }
}

function writeStoredConfig(
  mode: ConnectionStorageMode,
  config: ConnectionConfig | null
): void {
  const storage = getStorageForMode(mode);
  if (!storage) return;
  try {
    if (!config) {
      storage.removeItem(CONNECTION_STORAGE_KEY);
      return;
    }
    storage.setItem(CONNECTION_STORAGE_KEY, JSON.stringify(config));
  } catch {
    // Ignore storage write errors.
  }
}

interface ConnectionState {
  isConnected: boolean;
  isConnecting: boolean;
  error: string | null;
  client: SyncClient | null;
}

interface ConnectionContextValue {
  config: ConnectionConfig | null;
  setConfig: (config: ConnectionConfig | null) => void;
  isConnected: boolean;
  isConnecting: boolean;
  error: string | null;
  client: SyncClient | null;
  connect: (
    overrideConfig?: ConnectionConfig,
    options?: { persistOverride?: boolean }
  ) => Promise<boolean>;
  disconnect: (options?: { clearSavedConfig?: boolean }) => void;
  clearError: () => void;
}

interface ConnectionProviderProps {
  children: ReactNode;
  defaultConfig?: ConnectionConfig | null;
  autoConnect?: boolean;
  storageMode?: ConnectionStorageMode;
}

const ConnectionContext = createContext<ConnectionContextValue | null>(null);

export function ConnectionProvider({
  children,
  defaultConfig = null,
  autoConnect = false,
  storageMode = 'session',
}: ConnectionProviderProps) {
  const [config, setConfigState] = useState<ConnectionConfig | null>(() =>
    readStoredConfig(storageMode)
  );

  useEffect(() => {
    const storedConfig = readStoredConfig(storageMode);
    setConfigState(storedConfig);
  }, [storageMode]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (storageMode !== 'local') {
      window.localStorage.removeItem(CONNECTION_STORAGE_KEY);
    }
    if (storageMode === 'memory') {
      window.sessionStorage.removeItem(CONNECTION_STORAGE_KEY);
    }
  }, [storageMode]);

  const setConfigStorage = useCallback(
    (nextConfig: ConnectionConfig | null) => {
      const normalized = normalizeConfig(nextConfig);
      setConfigState(normalized);
      writeStoredConfig(storageMode, normalized);
    },
    [storageMode]
  );

  const [state, setState] = useState<ConnectionState>({
    isConnected: false,
    isConnecting: false,
    error: null,
    client: null,
  });
  const lastAutoConnectConfigKeyRef = useRef<string | null>(null);

  // Resolve initial config: saved config -> provided defaults
  useEffect(() => {
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
  }, [setConfigStorage, config, defaultConfig]);

  const connect = useCallback(
    async (
      overrideConfig?: ConnectionConfig,
      options?: { persistOverride?: boolean }
    ) => {
      const effectiveConfig = overrideConfig ?? config;
      if (!effectiveConfig) {
        setState((s) => ({ ...s, error: 'No connection configured' }));
        return false;
      }

      const normalizedConfig = normalizeConfig(effectiveConfig);

      // Validate config has required fields
      if (!normalizedConfig) {
        const hasServerUrl =
          (effectiveConfig.serverUrl?.trim() ?? '').length > 0;
        setState((s) => ({
          ...s,
          error: hasServerUrl ? 'Token is required' : 'Server URL is required',
        }));
        return false;
      }

      if (overrideConfig && (options?.persistOverride ?? true)) {
        setConfigStorage(normalizedConfig);
      }

      setState((s) => ({ ...s, isConnecting: true, error: null }));

      try {
        const client = createConsoleClient(normalizedConfig);
        await testConnection(client);
        setState({
          isConnected: true,
          isConnecting: false,
          client,
          error: null,
        });
        return true;
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
    [config, setConfigStorage]
  );

  const disconnect = useCallback(
    (options?: { clearSavedConfig?: boolean }) => {
      if (options?.clearSavedConfig) {
        setConfigStorage(null);
      }

      setState({
        isConnected: false,
        isConnecting: false,
        client: null,
        error: null,
      });
    },
    [setConfigStorage]
  );

  const clearError = useCallback(() => {
    setState((s) => ({ ...s, error: null }));
  }, []);

  const setConfig = useCallback(
    (newConfig: ConnectionConfig | null) => {
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

  useEffect(() => {
    if (!autoConnect || state.isConnected || state.isConnecting) {
      return;
    }

    const candidate = config ?? defaultConfig;
    const key = normalizeConfigKey(candidate);
    if (!candidate || !key) {
      return;
    }

    if (lastAutoConnectConfigKeyRef.current === key) {
      return;
    }

    lastAutoConnectConfigKeyRef.current = key;
    void connect(candidate, { persistOverride: true });
  }, [
    autoConnect,
    config,
    defaultConfig,
    state.isConnected,
    state.isConnecting,
    connect,
  ]);

  return (
    <ConnectionContext.Provider value={value}>
      {children}
    </ConnectionContext.Provider>
  );
}

function normalizeConfigKey(config: ConnectionConfig | null): string | null {
  if (!config) {
    return null;
  }
  const serverUrl = config.serverUrl?.trim() ?? '';
  const token = config.token?.trim() ?? '';
  if (!serverUrl || !token) {
    return null;
  }
  return `${serverUrl}\u0000${token}`;
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
