import type { SyncularSyncRequestOptions, SyncularSyncResult } from './types';

export type SyncularBrowserLifecycleResumeReason =
  | 'manual'
  | 'online'
  | 'pageshow'
  | 'resume'
  | 'visibilitychange';

export type SyncularBrowserLifecyclePauseReason =
  | 'beforeunload'
  | 'freeze'
  | 'pagehide'
  | 'visibilitychange';

export type SyncularBrowserLifecycleResumeLockState =
  | 'not-requested'
  | 'waiting'
  | 'acquired'
  | 'timed-out'
  | 'unavailable';

export interface SyncularBrowserLifecycleResumeContext {
  reason: SyncularBrowserLifecycleResumeReason;
  lockName?: string;
  lockRequired: boolean;
  lockState: SyncularBrowserLifecycleResumeLockState;
  lockTimeoutMs?: number;
}

export interface SyncularBrowserLifecyclePauseContext {
  reason: SyncularBrowserLifecyclePauseReason;
  persisted?: boolean;
  visibilityState: string | null;
}

export interface SyncularBrowserLifecycleResumeClient {
  resumeFromBackground(
    options?: SyncularSyncRequestOptions
  ): Promise<SyncularSyncResult>;
}

export interface SyncularBrowserLifecycleTarget {
  document?: SyncularBrowserLifecycleDocument;
  addEventListener?: (
    type: string,
    listener: EventListenerOrEventListenerObject
  ) => void;
  removeEventListener?: (
    type: string,
    listener: EventListenerOrEventListenerObject
  ) => void;
}

export interface SyncularBrowserLifecycleNavigator {
  locks?: {
    request?: <T>(
      name: string,
      options: { mode: 'exclusive'; signal?: AbortSignal },
      callback: () => T | Promise<T>
    ) => Promise<T>;
  };
}

export interface SyncularBrowserLifecycleDocument {
  visibilityState?: unknown;
  addEventListener?: (
    type: string,
    listener: EventListenerOrEventListenerObject
  ) => void;
  removeEventListener?: (
    type: string,
    listener: EventListenerOrEventListenerObject
  ) => void;
}

export interface SyncularBrowserLifecycleResumeLockOptions {
  /**
   * Web Locks name used to serialize foreground catch-up across browser tabs.
   * Use an app-specific name when several independent Syncular databases can
   * be open in the same origin.
   */
  name?: string;
  /**
   * When true, resume rejects if the browser does not expose Web Locks instead
   * of falling back to an uncoordinated catch-up.
   */
  required?: boolean;
  /**
   * Optional maximum time to wait for the browser Web Lock. When the timeout
   * expires, the resume rejects with
   * `SyncularBrowserLifecycleResumeLockTimeoutError` instead of hanging behind
   * another tab indefinitely.
   */
  timeoutMs?: number;
}

export interface SyncularBrowserLifecycleResumeOptions {
  global?: SyncularBrowserLifecycleTarget;
  navigator?: SyncularBrowserLifecycleNavigator;
  lock?: boolean | SyncularBrowserLifecycleResumeLockOptions;
  syncOptions?:
    | SyncularSyncRequestOptions
    | ((
        context: SyncularBrowserLifecycleResumeContext
      ) => SyncularSyncRequestOptions | undefined);
  onResumeStart?: (context: SyncularBrowserLifecycleResumeContext) => void;
  onResumeComplete?: (
    result: SyncularSyncResult,
    context: SyncularBrowserLifecycleResumeContext
  ) => void;
  onResumeError?: (
    error: unknown,
    context: SyncularBrowserLifecycleResumeContext
  ) => void;
  onPause?: (context: SyncularBrowserLifecyclePauseContext) => void;
}

export interface SyncularBrowserLifecycleResumeController {
  resume(
    reason?: SyncularBrowserLifecycleResumeReason
  ): Promise<SyncularSyncResult>;
  inFlight(): Promise<SyncularSyncResult> | null;
  destroy(): void;
}

export class SyncularBrowserLifecycleResumeLockError extends Error {
  readonly code = 'browser.web_locks_unavailable';

  constructor(readonly lockName: string) {
    super(
      `Browser Web Locks are unavailable; cannot coordinate Syncular lifecycle resume for ${lockName}.`
    );
    this.name = 'SyncularBrowserLifecycleResumeLockError';
  }
}

export class SyncularBrowserLifecycleResumeLockTimeoutError extends Error {
  readonly code = 'browser.web_locks_timeout';

  constructor(
    readonly lockName: string,
    readonly timeoutMs: number
  ) {
    super(
      `Timed out waiting ${timeoutMs}ms for Syncular lifecycle resume Web Lock ${lockName}.`
    );
    this.name = 'SyncularBrowserLifecycleResumeLockTimeoutError';
  }
}

const DEFAULT_LIFECYCLE_RESUME_LOCK_NAME = 'syncular:lifecycle-resume';

type NormalizedLifecycleResumeLockOptions = {
  name: string;
  required: boolean;
  timeoutMs?: number;
};

export function installSyncularBrowserLifecycleResume(
  client: SyncularBrowserLifecycleResumeClient,
  options: SyncularBrowserLifecycleResumeOptions = {}
): SyncularBrowserLifecycleResumeController {
  const globalRef =
    options.global ?? (globalThis as unknown as SyncularBrowserLifecycleTarget);
  const navigatorRef =
    options.navigator ??
    (globalThis as unknown as { navigator?: SyncularBrowserLifecycleNavigator })
      .navigator;
  const lockOptions = normalizeLockOptions(options.lock);
  const documentRef = globalRef.document;
  const unsubscribers: Array<() => void> = [];
  let destroyed = false;
  let inFlight: Promise<SyncularSyncResult> | null = null;

  const resume = (
    reason: SyncularBrowserLifecycleResumeReason = 'manual'
  ): Promise<SyncularSyncResult> => {
    if (inFlight) return inFlight;
    let callbackContext = createResumeContext({ lockOptions, reason });

    const runResume = (
      context: SyncularBrowserLifecycleResumeContext
    ): Promise<SyncularSyncResult> => {
      callbackContext = context;
      const syncOptions =
        typeof options.syncOptions === 'function'
          ? options.syncOptions(context)
          : options.syncOptions;
      options.onResumeStart?.(context);
      try {
        return client.resumeFromBackground(syncOptions);
      } catch (error) {
        return Promise.reject(error);
      }
    };

    const runWithOptionalLock = (): Promise<SyncularSyncResult> => {
      if (!lockOptions) {
        return runResume(callbackContext);
      }

      const locks = navigatorRef?.locks;
      if (typeof locks?.request !== 'function') {
        callbackContext = createResumeContext({
          lockOptions,
          lockState: 'unavailable',
          reason,
        });
        if (lockOptions.required) {
          return Promise.reject(
            new SyncularBrowserLifecycleResumeLockError(lockOptions.name)
          );
        }
        return runResume(callbackContext);
      }

      let timeoutError: SyncularBrowserLifecycleResumeLockTimeoutError | null =
        null;
      let timedOut = false;
      const abortController =
        lockOptions.timeoutMs != null && typeof AbortController !== 'undefined'
          ? new AbortController()
          : null;
      const lockRequestOptions = {
        mode: 'exclusive' as const,
        ...(abortController ? { signal: abortController.signal } : {}),
      };
      const request = locks
        .request(lockOptions.name, lockRequestOptions, () => {
          if (timedOut) {
            throw (
              timeoutError ??
              new SyncularBrowserLifecycleResumeLockTimeoutError(
                lockOptions.name,
                lockOptions.timeoutMs ?? 0
              )
            );
          }
          return runResume(
            createResumeContext({
              lockOptions,
              lockState: 'acquired',
              reason,
            })
          );
        })
        .catch((error) => {
          if (timeoutError) throw timeoutError;
          throw error;
        });

      if (lockOptions.timeoutMs == null) {
        return request;
      }

      let timeoutId: ReturnType<typeof setTimeout> | null = null;
      const timeout = new Promise<SyncularSyncResult>((_, reject) => {
        timeoutId = setTimeout(() => {
          timedOut = true;
          timeoutError = new SyncularBrowserLifecycleResumeLockTimeoutError(
            lockOptions.name,
            lockOptions.timeoutMs ?? 0
          );
          callbackContext = createResumeContext({
            lockOptions,
            lockState: 'timed-out',
            reason,
          });
          abortController?.abort();
          reject(timeoutError);
        }, lockOptions.timeoutMs);
      });

      return Promise.race([request, timeout]).finally(() => {
        if (timeoutId) clearTimeout(timeoutId);
      });
    };

    inFlight = runWithOptionalLock()
      .then(
        (result) => {
          options.onResumeComplete?.(result, callbackContext);
          return result;
        },
        (error) => {
          options.onResumeError?.(error, callbackContext);
          throw error;
        }
      )
      .finally(() => {
        inFlight = null;
      });
    return inFlight;
  };

  const resumeFromBrowserSignal = (
    reason: SyncularBrowserLifecycleResumeReason
  ): void => {
    if (destroyed || isDocumentHidden(documentRef)) return;
    void resume(reason).catch(() => undefined);
  };
  const notifyPause = (
    reason: SyncularBrowserLifecyclePauseReason,
    event?: Event
  ): void => {
    if (destroyed) return;
    options.onPause?.({
      reason,
      ...(reason === 'pagehide' ? { persisted: eventPersisted(event) } : {}),
      visibilityState: documentVisibilityState(documentRef),
    });
  };

  if (documentRef?.addEventListener) {
    const onVisibilityChange = () => {
      if (documentRef.visibilityState === 'visible') {
        resumeFromBrowserSignal('visibilitychange');
      } else if (documentRef.visibilityState === 'hidden') {
        notifyPause('visibilitychange');
      }
    };
    documentRef.addEventListener('visibilitychange', onVisibilityChange);
    unsubscribers.push(() => {
      documentRef.removeEventListener?.('visibilitychange', onVisibilityChange);
    });
  }

  if (globalRef.addEventListener) {
    const onPageShow = () => resumeFromBrowserSignal('pageshow');
    const onPageHide = (event: Event) => notifyPause('pagehide', event);
    const onBeforeUnload = () => notifyPause('beforeunload');
    const onFreeze = () => notifyPause('freeze');
    const onOnline = () => resumeFromBrowserSignal('online');
    const onResume = () => resumeFromBrowserSignal('resume');
    globalRef.addEventListener('pagehide', onPageHide);
    globalRef.addEventListener('beforeunload', onBeforeUnload);
    globalRef.addEventListener('freeze', onFreeze);
    globalRef.addEventListener('pageshow', onPageShow);
    globalRef.addEventListener('online', onOnline);
    globalRef.addEventListener('resume', onResume);
    unsubscribers.push(() => {
      globalRef.removeEventListener?.('pagehide', onPageHide);
      globalRef.removeEventListener?.('beforeunload', onBeforeUnload);
      globalRef.removeEventListener?.('freeze', onFreeze);
      globalRef.removeEventListener?.('pageshow', onPageShow);
      globalRef.removeEventListener?.('online', onOnline);
      globalRef.removeEventListener?.('resume', onResume);
    });
  }

  return {
    resume,
    inFlight: () => inFlight,
    destroy() {
      if (destroyed) return;
      destroyed = true;
      while (unsubscribers.length > 0) {
        unsubscribers.pop()?.();
      }
    },
  };
}

function normalizeLockOptions(
  lock: SyncularBrowserLifecycleResumeOptions['lock']
): NormalizedLifecycleResumeLockOptions | null {
  if (!lock) return null;
  if (lock === true) {
    return {
      name: DEFAULT_LIFECYCLE_RESUME_LOCK_NAME,
      required: false,
    };
  }
  return {
    name: lock.name?.trim() || DEFAULT_LIFECYCLE_RESUME_LOCK_NAME,
    required: lock.required === true,
    ...(normalizeTimeoutMs(lock.timeoutMs) != null
      ? { timeoutMs: normalizeTimeoutMs(lock.timeoutMs) }
      : {}),
  };
}

function createResumeContext(args: {
  lockOptions: NormalizedLifecycleResumeLockOptions | null;
  lockState?: SyncularBrowserLifecycleResumeLockState;
  reason: SyncularBrowserLifecycleResumeReason;
}): SyncularBrowserLifecycleResumeContext {
  return {
    reason: args.reason,
    lockRequired: args.lockOptions?.required ?? false,
    lockState:
      args.lockState ?? (args.lockOptions ? 'waiting' : 'not-requested'),
    ...(args.lockOptions ? { lockName: args.lockOptions.name } : {}),
    ...(args.lockOptions?.timeoutMs != null
      ? { lockTimeoutMs: args.lockOptions.timeoutMs }
      : {}),
  };
}

function normalizeTimeoutMs(timeoutMs: unknown): number | undefined {
  if (typeof timeoutMs !== 'number' || !Number.isFinite(timeoutMs)) {
    return undefined;
  }
  const normalized = Math.ceil(timeoutMs);
  return normalized > 0 ? normalized : undefined;
}

function isDocumentHidden(
  documentRef: SyncularBrowserLifecycleDocument | undefined
): boolean {
  return documentRef?.visibilityState === 'hidden';
}

function documentVisibilityState(
  documentRef: SyncularBrowserLifecycleDocument | undefined
): string | null {
  return typeof documentRef?.visibilityState === 'string'
    ? documentRef.visibilityState
    : null;
}

function eventPersisted(event: Event | undefined): boolean {
  if (!event || !('persisted' in event)) return false;
  return (event as { persisted?: unknown }).persisted === true;
}
