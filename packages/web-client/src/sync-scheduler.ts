import type { WakeReason } from '@syncular/core';
import type { SecurityLifecycle } from './client';
import type { SyncIntent } from './invalidation';

export interface SyncSchedulerClient {
  readonly syncNeeded: boolean;
  readonly securityLifecycle: SecurityLifecycle;
  syncUntilIdle(maxRounds?: number): Promise<unknown>;
  onSyncNeeded(
    listener: (reason: 'startup' | 'hello' | WakeReason) => void,
  ): () => void;
  onSyncIntent(listener: (intent: SyncIntent) => void): () => void;
}

export interface SyncSchedulerOptions {
  readonly maxRounds?: number;
  readonly onError?: (error: unknown) => void;
  readonly now?: () => number;
  readonly queueMicrotask?: (callback: () => void) => void;
  readonly schedule?: (callback: () => void, delayMs: number) => () => void;
}

export interface SyncScheduler {
  readonly stopped: boolean;
  stop(): void;
}

/** Install the event-driven single-flight host loop for a direct client. */
export function installSyncScheduler(
  client: SyncSchedulerClient,
  options: SyncSchedulerOptions = {},
): SyncScheduler {
  const now = options.now ?? Date.now;
  const enqueue = options.queueMicrotask ?? globalThis.queueMicrotask;
  const schedule =
    options.schedule ??
    ((callback: () => void, delayMs: number): (() => void) => {
      const timer = globalThis.setTimeout(callback, delayMs);
      return () => globalThis.clearTimeout(timer);
    });
  let stopped = false;
  let running = false;
  let immediatePending = false;
  let immediateQueued = false;
  let backgroundReady = false;
  let backgroundDue = Number.POSITIVE_INFINITY;
  let cancelBackground: (() => void) | undefined;

  const report = (error: unknown): void => {
    if (options.onError !== undefined) {
      options.onError(error);
      return;
    }
    const root: typeof globalThis & {
      reportError?: (error: unknown) => void;
    } = globalThis;
    if (root.reportError !== undefined) root.reportError(error);
    else console.error(error);
  };

  const clearBackground = (): void => {
    cancelBackground?.();
    cancelBackground = undefined;
    backgroundReady = false;
    backgroundDue = Number.POSITIVE_INFINITY;
  };

  const queueImmediate = (): void => {
    immediatePending = true;
    if (stopped || running || immediateQueued) return;
    immediateQueued = true;
    enqueue(() => {
      immediateQueued = false;
      if (stopped || !immediatePending) return;
      immediatePending = false;
      run();
    });
  };

  const run = (): void => {
    if (stopped || running) return;
    if (client.securityLifecycle === 'preflight') {
      immediatePending = false;
      return;
    }
    running = true;
    backgroundReady = false;
    void client
      .syncUntilIdle(options.maxRounds)
      .catch((error: unknown) => {
        if (!stopped) report(error);
      })
      .finally(() => {
        running = false;
        if (stopped) return;
        if (immediatePending || backgroundReady) {
          queueImmediate();
          return;
        }
        if (cancelBackground !== undefined && backgroundDue <= now()) {
          clearBackground();
          queueImmediate();
        }
      });
  };

  const consume = (intent: SyncIntent): void => {
    if (stopped) return;
    if (intent.kind === 'none') {
      clearBackground();
      immediatePending = false;
      return;
    }
    if (intent.kind === 'interactive') {
      clearBackground();
      queueImmediate();
      return;
    }
    if (immediatePending || immediateQueued) return;
    clearBackground();
    backgroundDue = now() + Math.max(0, intent.delayMs);
    cancelBackground = schedule(
      () => {
        cancelBackground = undefined;
        backgroundDue = Number.POSITIVE_INFINITY;
        backgroundReady = true;
        if (!running) queueImmediate();
      },
      Math.max(0, intent.delayMs),
    );
  };

  const unsubscribeNeeded = client.onSyncNeeded(() => {
    consume({ kind: 'interactive' });
  });
  const unsubscribeIntent = client.onSyncIntent(consume);
  if (client.syncNeeded && client.securityLifecycle === 'active') {
    consume({ kind: 'interactive' });
  }

  return {
    get stopped() {
      return stopped;
    },
    stop() {
      if (stopped) return;
      stopped = true;
      clearBackground();
      immediatePending = false;
      unsubscribeNeeded();
      unsubscribeIntent();
    },
  };
}
