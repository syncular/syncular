import {
  applyOfflineLockEvent,
  attemptOfflineUnlock,
  attemptOfflineUnlockAsync,
  clearOfflineAuthState,
  createEmptyOfflineAuthState,
  createOfflineLockState,
  isOfflineLockBlocked,
  type LoadOfflineAuthStateOptions,
  loadOfflineAuthState,
  type OfflineAuthState,
  type OfflineLockEvent,
  type OfflineLockPolicyOptions,
  type OfflineLockState,
  type OfflineSubjectIdentity,
  type OfflineUnlockResult,
  saveOfflineAuthState,
} from '@syncular/client-plugin-offline-auth';
import { useCallback, useEffect, useRef, useState } from 'react';

export interface UseOfflineAuthStateOptions<
  TSession,
  TIdentity extends OfflineSubjectIdentity,
> extends LoadOfflineAuthStateOptions<TSession, TIdentity> {
  initialState?: OfflineAuthState<TSession, TIdentity>;
}

export interface UseOfflineAuthStateResult<
  TSession,
  TIdentity extends OfflineSubjectIdentity,
> {
  state: OfflineAuthState<TSession, TIdentity>;
  isLoaded: boolean;
  error: Error | null;
  reload: () => Promise<void>;
  save: (nextState: OfflineAuthState<TSession, TIdentity>) => Promise<void>;
  update: (
    updater: (
      previousState: OfflineAuthState<TSession, TIdentity>
    ) => OfflineAuthState<TSession, TIdentity>
  ) => Promise<OfflineAuthState<TSession, TIdentity>>;
  clear: (options?: {
    preserveLastActorId?: boolean;
  }) => Promise<OfflineAuthState<TSession, TIdentity>>;
}

export interface UseOfflineLockPolicyOptions extends OfflineLockPolicyOptions {
  enabled?: boolean;
  lockOnMount?: boolean;
  trackWindowActivity?: boolean;
  lockOnDocumentHidden?: boolean;
  activityEvents?: readonly (keyof WindowEventMap)[];
}

export interface UseOfflineLockPolicyResult {
  state: OfflineLockState;
  isBlocked: boolean;
  cooldownRemainingMs: number;
  dispatch: (event: OfflineLockEvent) => OfflineLockState;
  lock: () => OfflineLockState;
  forceUnlock: () => OfflineUnlockResult;
  recordActivity: () => OfflineLockState;
  recordFailedUnlock: () => OfflineLockState;
  resetFailures: () => OfflineLockState;
  evaluateIdleTimeout: () => OfflineLockState;
  attemptUnlock: (verify: () => boolean) => OfflineUnlockResult;
  attemptUnlockAsync: (
    verify: () => boolean | Promise<boolean>
  ) => Promise<OfflineUnlockResult>;
}

const DEFAULT_ACTIVITY_EVENTS: readonly (keyof WindowEventMap)[] = [
  'pointerdown',
  'keydown',
  'mousedown',
  'touchstart',
  'focus',
];

function toError(error: unknown): Error {
  if (error instanceof Error) return error;
  return new Error('Unknown error');
}

export function useOfflineAuthState<
  TSession,
  TIdentity extends OfflineSubjectIdentity,
>(
  options: UseOfflineAuthStateOptions<TSession, TIdentity>
): UseOfflineAuthStateResult<TSession, TIdentity> {
  const [state, setState] = useState<OfflineAuthState<TSession, TIdentity>>(
    options.initialState ?? createEmptyOfflineAuthState<TSession, TIdentity>()
  );
  const [isLoaded, setIsLoaded] = useState(Boolean(options.initialState));
  const [error, setError] = useState<Error | null>(null);

  const stateRef = useRef(state);
  const isMountedRef = useRef(true);

  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  useEffect(() => {
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  const applyState = useCallback(
    (nextState: OfflineAuthState<TSession, TIdentity>) => {
      stateRef.current = nextState;
      if (isMountedRef.current) {
        setState(nextState);
      }
    },
    []
  );

  const save = useCallback(
    async (nextState: OfflineAuthState<TSession, TIdentity>) => {
      applyState(nextState);
      await saveOfflineAuthState(nextState, {
        storage: options.storage,
        storageKey: options.storageKey,
      });
    },
    [applyState, options.storage, options.storageKey]
  );

  const update = useCallback(
    async (
      updater: (
        previousState: OfflineAuthState<TSession, TIdentity>
      ) => OfflineAuthState<TSession, TIdentity>
    ): Promise<OfflineAuthState<TSession, TIdentity>> => {
      const nextState = updater(stateRef.current);
      await save(nextState);
      return nextState;
    },
    [save]
  );

  const clear = useCallback(
    async (clearOptions?: { preserveLastActorId?: boolean }) => {
      const nextState = clearOfflineAuthState(stateRef.current, clearOptions);
      await save(nextState);
      return nextState;
    },
    [save]
  );

  const reload = useCallback(async () => {
    try {
      const loadedState = await loadOfflineAuthState({
        storage: options.storage,
        codec: options.codec,
        storageKey: options.storageKey,
      });
      applyState(loadedState);
      setError(null);
    } catch (loadError) {
      setError(toError(loadError));
    } finally {
      setIsLoaded(true);
    }
  }, [applyState, options.codec, options.storage, options.storageKey]);

  useEffect(() => {
    void reload();
  }, [reload]);

  return {
    state,
    isLoaded,
    error,
    reload,
    save,
    update,
    clear,
  };
}

export function useOfflineLockPolicy(
  options: UseOfflineLockPolicyOptions = {}
): UseOfflineLockPolicyResult {
  const [state, setState] = useState<OfflineLockState>(() =>
    createOfflineLockState(options)
  );
  const stateRef = useRef(state);

  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  const dispatch = useCallback(
    (event: OfflineLockEvent): OfflineLockState => {
      const nextState = applyOfflineLockEvent(stateRef.current, event, options);
      stateRef.current = nextState;
      setState(nextState);
      return nextState;
    },
    [options]
  );

  const lock = useCallback(() => {
    return dispatch({ type: 'lock' });
  }, [dispatch]);

  const forceUnlock = useCallback((): OfflineUnlockResult => {
    const nextState = dispatch({ type: 'unlock' });
    if (nextState.isLocked) {
      return {
        ok: false,
        reason: 'blocked',
        state: nextState,
      };
    }

    return {
      ok: true,
      reason: null,
      state: nextState,
    };
  }, [dispatch]);

  const recordActivity = useCallback(() => {
    return dispatch({ type: 'activity' });
  }, [dispatch]);

  const recordFailedUnlock = useCallback(() => {
    return dispatch({ type: 'failed-unlock' });
  }, [dispatch]);

  const resetFailures = useCallback(() => {
    return dispatch({ type: 'reset-failures' });
  }, [dispatch]);

  const evaluateIdleTimeout = useCallback(() => {
    return dispatch({ type: 'tick' });
  }, [dispatch]);

  const attemptUnlock = useCallback(
    (verify: () => boolean): OfflineUnlockResult => {
      const result = attemptOfflineUnlock({
        state: stateRef.current,
        verify,
        options,
      });
      stateRef.current = result.state;
      setState(result.state);
      return result;
    },
    [options]
  );

  const attemptUnlockAsync = useCallback(
    async (
      verify: () => boolean | Promise<boolean>
    ): Promise<OfflineUnlockResult> => {
      const result = await attemptOfflineUnlockAsync({
        state: stateRef.current,
        verify,
        options,
      });
      stateRef.current = result.state;
      setState(result.state);
      return result;
    },
    [options]
  );

  const enabled = options.enabled ?? true;
  const lockOnMount = options.lockOnMount ?? false;

  useEffect(() => {
    if (!enabled || !lockOnMount) return;
    dispatch({ type: 'lock' });
  }, [dispatch, enabled, lockOnMount]);

  const idleTimeoutMs = Math.max(0, options.idleTimeoutMs ?? 0);

  useEffect(() => {
    if (!enabled) return;
    if (idleTimeoutMs <= 0) return;
    if (state.isLocked) return;

    const nowMs = options.now ? options.now() : Date.now();
    const idleAtMs = state.lastActivityAtMs + idleTimeoutMs;
    const delayMs = Math.max(0, idleAtMs - nowMs);

    const timeout = setTimeout(() => {
      dispatch({ type: 'tick' });
    }, delayMs);

    return () => {
      clearTimeout(timeout);
    };
  }, [
    dispatch,
    enabled,
    idleTimeoutMs,
    options,
    state.isLocked,
    state.lastActivityAtMs,
  ]);

  const trackWindowActivity = options.trackWindowActivity ?? false;
  const lockOnDocumentHidden = options.lockOnDocumentHidden ?? true;

  useEffect(() => {
    if (!enabled || !trackWindowActivity) return;
    if (typeof window === 'undefined') return;

    const events = options.activityEvents ?? DEFAULT_ACTIVITY_EVENTS;

    const onActivity = () => {
      dispatch({ type: 'activity' });
    };

    const onVisibilityChange = () => {
      if (lockOnDocumentHidden && document.visibilityState === 'hidden') {
        dispatch({ type: 'lock' });
        return;
      }
      dispatch({ type: 'activity' });
    };

    for (const eventName of events) {
      window.addEventListener(eventName, onActivity);
    }

    document.addEventListener('visibilitychange', onVisibilityChange);

    return () => {
      for (const eventName of events) {
        window.removeEventListener(eventName, onActivity);
      }
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, [
    dispatch,
    enabled,
    lockOnDocumentHidden,
    options.activityEvents,
    trackWindowActivity,
  ]);

  const nowMs = options.now ? options.now() : Date.now();

  const isBlocked = isOfflineLockBlocked(state, nowMs);
  const cooldownRemainingMs =
    state.blockedUntilMs === null
      ? 0
      : Math.max(0, state.blockedUntilMs - nowMs);

  return {
    state,
    isBlocked,
    cooldownRemainingMs,
    dispatch,
    lock,
    forceUnlock,
    recordActivity,
    recordFailedUnlock,
    resetFailures,
    evaluateIdleTimeout,
    attemptUnlock,
    attemptUnlockAsync,
  };
}
