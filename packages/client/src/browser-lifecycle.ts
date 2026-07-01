import type { SyncularSyncRequestOptions, SyncularSyncResult } from './types';

export type SyncularBrowserLifecycleResumeReason =
  | 'manual'
  | 'online'
  | 'pageshow'
  | 'visibilitychange';

export interface SyncularBrowserLifecycleResumeContext {
  reason: SyncularBrowserLifecycleResumeReason;
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

export interface SyncularBrowserLifecycleResumeOptions {
  global?: SyncularBrowserLifecycleTarget;
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
}

export interface SyncularBrowserLifecycleResumeController {
  resume(
    reason?: SyncularBrowserLifecycleResumeReason
  ): Promise<SyncularSyncResult>;
  inFlight(): Promise<SyncularSyncResult> | null;
  destroy(): void;
}

export function installSyncularBrowserLifecycleResume(
  client: SyncularBrowserLifecycleResumeClient,
  options: SyncularBrowserLifecycleResumeOptions = {}
): SyncularBrowserLifecycleResumeController {
  const globalRef =
    options.global ?? (globalThis as unknown as SyncularBrowserLifecycleTarget);
  const documentRef = globalRef.document;
  const unsubscribers: Array<() => void> = [];
  let destroyed = false;
  let inFlight: Promise<SyncularSyncResult> | null = null;

  const resume = (
    reason: SyncularBrowserLifecycleResumeReason = 'manual'
  ): Promise<SyncularSyncResult> => {
    if (inFlight) return inFlight;
    const context = { reason };
    const syncOptions =
      typeof options.syncOptions === 'function'
        ? options.syncOptions(context)
        : options.syncOptions;
    options.onResumeStart?.(context);
    let resumePromise: Promise<SyncularSyncResult>;
    try {
      resumePromise = client.resumeFromBackground(syncOptions);
    } catch (error) {
      resumePromise = Promise.reject(error);
    }
    inFlight = resumePromise
      .then(
        (result) => {
          options.onResumeComplete?.(result, context);
          return result;
        },
        (error) => {
          options.onResumeError?.(error, context);
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

  if (documentRef?.addEventListener) {
    const onVisibilityChange = () => {
      if (documentRef.visibilityState === 'visible') {
        resumeFromBrowserSignal('visibilitychange');
      }
    };
    documentRef.addEventListener('visibilitychange', onVisibilityChange);
    unsubscribers.push(() => {
      documentRef.removeEventListener?.('visibilitychange', onVisibilityChange);
    });
  }

  if (globalRef.addEventListener) {
    const onPageShow = () => resumeFromBrowserSignal('pageshow');
    const onOnline = () => resumeFromBrowserSignal('online');
    globalRef.addEventListener('pageshow', onPageShow);
    globalRef.addEventListener('online', onOnline);
    unsubscribers.push(() => {
      globalRef.removeEventListener?.('pageshow', onPageShow);
      globalRef.removeEventListener?.('online', onOnline);
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

function isDocumentHidden(
  documentRef: SyncularBrowserLifecycleDocument | undefined
): boolean {
  return documentRef?.visibilityState === 'hidden';
}
