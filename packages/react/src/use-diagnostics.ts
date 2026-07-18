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
  const [snapshot, setSnapshot] = useState<
    ClientDiagnosticsSnapshot | undefined
  >();
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<Error | undefined>();

  const refresh = useCallback(() => {
    const current = ++generation.current;
    setIsLoading(true);
    void client.diagnosticsSnapshot(request).then(
      (next) => {
        if (generation.current !== current) return;
        setSnapshot(next);
        setError(undefined);
        setIsLoading(false);
      },
      (reason: unknown) => {
        if (generation.current !== current) return;
        setError(reason instanceof Error ? reason : new Error(String(reason)));
        setIsLoading(false);
      },
    );
  }, [client, request]);

  useEffect(() => {
    const unsubscribe = client.onDiagnostics(refresh);
    refresh();
    return () => {
      generation.current += 1;
      unsubscribe();
    };
  }, [client, refresh]);

  return { snapshot, isLoading, error, refresh };
}
