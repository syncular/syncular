import type { ClientDiagnosticsSnapshot } from '@syncular/client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useSyncClient } from './use-client';

export interface UseDiagnosticsResult {
  readonly snapshot: ClientDiagnosticsSnapshot | undefined;
  readonly isLoading: boolean;
  readonly error: Error | undefined;
  readonly refresh: () => void;
}

/**
 * Observe the versioned, privacy-safe diagnostics snapshot. Native/Worker
 * events are treated as invalidation signals and followed by a fresh read.
 */
export function useDiagnostics(): UseDiagnosticsResult {
  const client = useSyncClient();
  const generation = useRef(0);
  const [state, setState] = useState<{
    readonly client: typeof client;
    readonly snapshot: ClientDiagnosticsSnapshot | undefined;
    readonly error: Error | undefined;
    readonly settled: boolean;
  }>({
    client,
    snapshot: undefined,
    error: undefined,
    settled: false,
  });

  const refresh = useCallback(() => {
    const current = ++generation.current;
    setState((prev) => (prev.settled ? { ...prev, settled: false } : prev));
    void Promise.resolve()
      .then(() => client.diagnosticsSnapshot())
      .then(
        (next) => {
          if (generation.current !== current) return;
          setState({
            client,
            snapshot: next,
            error: undefined,
            settled: true,
          });
        },
        (reason: unknown) => {
          if (generation.current !== current) return;
          setState((prev) => ({
            client,
            snapshot: prev.client === client ? prev.snapshot : undefined,
            error: reason instanceof Error ? reason : new Error(String(reason)),
            settled: true,
          }));
        },
      );
  }, [client]);

  useEffect(() => {
    const unsubscribe = client.onDiagnostics(refresh);
    refresh();
    return () => {
      generation.current += 1;
      unsubscribe();
    };
  }, [client, refresh]);

  const current = state.client === client;
  return {
    snapshot: current ? state.snapshot : undefined,
    isLoading: !current || !state.settled,
    error: current ? state.error : undefined,
    refresh,
  };
}
