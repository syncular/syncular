import type {
  ClientDiagnosticsRequest,
  ClientDiagnosticsSnapshot,
  ExpectedDiagnosticSubscription,
} from '@syncular/client';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSyncClient } from './use-client';

export interface UseDiagnosticsOptions {
  /**
   * Application-owned subscription intent. IDs must be stable and PHI-free;
   * no scope values are accepted by the diagnostics contract.
   */
  readonly expectedSubscriptions?: readonly ExpectedDiagnosticSubscription[];
}

export interface UseDiagnosticsResult {
  readonly snapshot: ClientDiagnosticsSnapshot | undefined;
  readonly isLoading: boolean;
  readonly error: Error | undefined;
  readonly refresh: () => void;
}

/**
 * Observe the versioned, privacy-safe diagnostics snapshot. Native/Worker
 * events are treated as invalidation signals and followed by a fresh request,
 * so expected-but-unregistered subscriptions remain visible on every host.
 */
export function useDiagnostics(
  options: UseDiagnosticsOptions = {},
): UseDiagnosticsResult {
  const client = useSyncClient();
  const requestKey = JSON.stringify(options.expectedSubscriptions ?? []);
  const request = useMemo<ClientDiagnosticsRequest>(() => {
    const expectedSubscriptions = JSON.parse(
      requestKey,
    ) as ExpectedDiagnosticSubscription[];
    return expectedSubscriptions.length === 0 ? {} : { expectedSubscriptions };
  }, [requestKey]);
  const generation = useRef(0);
  const [state, setState] = useState<{
    readonly client: typeof client;
    readonly requestKey: string;
    readonly snapshot: ClientDiagnosticsSnapshot | undefined;
    readonly error: Error | undefined;
    readonly settled: boolean;
  }>({
    client,
    requestKey,
    snapshot: undefined,
    error: undefined,
    settled: false,
  });

  const refresh = useCallback(() => {
    const current = ++generation.current;
    setState((prev) => (prev.settled ? { ...prev, settled: false } : prev));
    void Promise.resolve()
      .then(() => client.diagnosticsSnapshot(request))
      .then(
        (next) => {
          if (generation.current !== current) return;
          setState({
            client,
            requestKey,
            snapshot: next,
            error: undefined,
            settled: true,
          });
        },
        (reason: unknown) => {
          if (generation.current !== current) return;
          setState((prev) => ({
            client,
            requestKey,
            snapshot:
              prev.client === client && prev.requestKey === requestKey
                ? prev.snapshot
                : undefined,
            error: reason instanceof Error ? reason : new Error(String(reason)),
            settled: true,
          }));
        },
      );
  }, [client, request, requestKey]);

  useEffect(() => {
    const unsubscribe = client.onDiagnostics(refresh);
    refresh();
    return () => {
      generation.current += 1;
      unsubscribe();
    };
  }, [client, refresh]);

  const current = state.client === client && state.requestKey === requestKey;
  return {
    snapshot: current ? state.snapshot : undefined,
    isLoading: !current || !state.settled,
    error: current ? state.error : undefined,
    refresh,
  };
}
