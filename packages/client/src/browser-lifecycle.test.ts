import { describe, expect, it } from 'bun:test';
import {
  installSyncularBrowserLifecycleResume,
  SyncularBrowserLifecycleResumeLockError,
  SyncularBrowserLifecycleResumeLockTimeoutError,
} from './browser-lifecycle';
import type { SyncularSyncRequestOptions, SyncularSyncResult } from './types';

describe('Syncular browser lifecycle resume', () => {
  it('resumes once when a hidden tab becomes visible', async () => {
    const client = new FakeResumeClient();
    const document = new FakeDocument('hidden');
    const global = new FakeGlobal(document);
    const completions: string[] = [];
    const controller = installSyncularBrowserLifecycleResume(client, {
      global,
      syncOptions: ({ reason }) => ({
        syncAttempt: { id: `resume:${reason}`, startedAt: 1 },
      }),
      onResumeComplete(_result, context) {
        completions.push(context.reason);
      },
    });

    document.dispatch('visibilitychange');
    expect(client.calls).toEqual([]);

    document.visibilityState = 'visible';
    document.dispatch('visibilitychange');

    expect(client.calls).toEqual(['resume:visibilitychange']);
    await expect(controller.inFlight()).resolves.toMatchObject({
      changedTables: ['resume:visibilitychange'],
    });
    expect(completions).toEqual(['visibilitychange']);
  });

  it('reports resume starts before the catch-up result settles', async () => {
    const client = new FakeResumeClient({ deferred: true });
    const document = new FakeDocument('visible');
    const global = new FakeGlobal(document);
    const starts: string[] = [];
    const completions: string[] = [];
    const controller = installSyncularBrowserLifecycleResume(client, {
      global,
      onResumeStart(context) {
        starts.push(context.reason);
      },
      onResumeComplete(_result, context) {
        completions.push(context.reason);
      },
    });

    const resume = controller.resume('manual');
    expect(starts).toEqual(['manual']);
    expect(completions).toEqual([]);

    client.resolveNext('manual');
    await resume;

    expect(completions).toEqual(['manual']);
  });

  it('resumes with a pageshow reason for restored pages', async () => {
    const client = new FakeResumeClient();
    const document = new FakeDocument('visible');
    const global = new FakeGlobal(document);
    const completions: string[] = [];
    installSyncularBrowserLifecycleResume(client, {
      global,
      syncOptions: ({ reason }) => ({
        syncAttempt: { id: `resume:${reason}`, startedAt: 1 },
      }),
      onResumeComplete(_result, context) {
        completions.push(context.reason);
      },
    });

    global.dispatch('pageshow');

    expect(client.calls).toEqual(['resume:pageshow']);
    await waitFor(() => completions.length === 1);
    expect(completions).toEqual(['pageshow']);
  });

  it('resumes with a resume reason for page lifecycle resume events', async () => {
    const client = new FakeResumeClient();
    const document = new FakeDocument('visible');
    const global = new FakeGlobal(document);
    const completions: string[] = [];
    installSyncularBrowserLifecycleResume(client, {
      global,
      syncOptions: ({ reason }) => ({
        syncAttempt: { id: `resume:${reason}`, startedAt: 1 },
      }),
      onResumeComplete(_result, context) {
        completions.push(context.reason);
      },
    });

    global.dispatch('resume');

    expect(client.calls).toEqual(['resume:resume']);
    await waitFor(() => completions.length === 1);
    expect(completions).toEqual(['resume']);
  });

  it('reports pause signals for hidden tabs and page shutdown', () => {
    const client = new FakeResumeClient();
    const document = new FakeDocument('visible');
    const global = new FakeGlobal(document);
    const pauses: string[] = [];
    installSyncularBrowserLifecycleResume(client, {
      global,
      onPause(context) {
        pauses.push(
          `${context.reason}:${context.visibilityState}:${context.persisted ?? false}`
        );
      },
    });

    document.visibilityState = 'hidden';
    document.dispatch('visibilitychange');
    global.dispatch('pagehide', { persisted: true });
    global.dispatch('freeze');
    global.dispatch('beforeunload');

    expect(pauses).toEqual([
      'visibilitychange:hidden:false',
      'pagehide:hidden:true',
      'freeze:hidden:false',
      'beforeunload:hidden:false',
    ]);
    expect(client.calls).toEqual([]);
  });

  it('coalesces overlapping browser resume signals', async () => {
    const client = new FakeResumeClient({ deferred: true });
    const document = new FakeDocument('visible');
    const global = new FakeGlobal(document);
    const controller = installSyncularBrowserLifecycleResume(client, {
      global,
    });

    global.dispatch('pageshow');
    global.dispatch('online');

    expect(client.calls).toEqual(['resume']);
    expect(controller.inFlight()).not.toBeNull();

    client.resolveNext('first');

    await expect(controller.inFlight()).resolves.toMatchObject({
      changedTables: ['first'],
    });

    global.dispatch('online');
    expect(client.calls).toEqual(['resume', 'resume']);
  });

  it('serializes resume through Web Locks when coordination is enabled', async () => {
    const firstClient = new FakeResumeClient({ deferred: true });
    const secondClient = new FakeResumeClient({ deferred: true });
    const locks = new FakeWebLocks();
    const starts: string[] = [];
    const navigator = { locks };
    const first = installSyncularBrowserLifecycleResume(firstClient, {
      lock: { name: 'syncular:test:resume' },
      navigator,
      onResumeStart(context) {
        starts.push(`first:${context.lockState}:${context.lockName}`);
      },
    });
    const second = installSyncularBrowserLifecycleResume(secondClient, {
      lock: { name: 'syncular:test:resume' },
      navigator,
      onResumeStart(context) {
        starts.push(`second:${context.lockState}:${context.lockName}`);
      },
    });

    const firstResume = first.resume('manual');
    const secondResume = second.resume('online');

    await waitFor(() => firstClient.calls.length === 1);
    expect(locks.requests).toEqual([
      'syncular:test:resume',
      'syncular:test:resume',
    ]);
    expect(firstClient.calls).toEqual(['resume']);
    expect(secondClient.calls).toEqual([]);
    expect(starts).toEqual(['first:acquired:syncular:test:resume']);

    firstClient.resolveNext('first');
    await firstResume;

    await waitFor(() => secondClient.calls.length === 1);
    expect(starts).toEqual([
      'first:acquired:syncular:test:resume',
      'second:acquired:syncular:test:resume',
    ]);
    secondClient.resolveNext('second');
    await secondResume;
  });

  it('falls back when optional Web Locks coordination is unavailable', async () => {
    const client = new FakeResumeClient();
    const starts: string[] = [];
    const controller = installSyncularBrowserLifecycleResume(client, {
      lock: true,
      navigator: {},
      syncOptions: ({ lockState }) => ({
        syncAttempt: { id: `resume:${lockState}`, startedAt: 1 },
      }),
      onResumeStart(context) {
        starts.push(`${context.lockState}:${context.lockRequired}`);
      },
    });

    await controller.resume('manual');

    expect(client.calls).toEqual(['resume:unavailable']);
    expect(starts).toEqual(['unavailable:false']);
  });

  it('rejects when required Web Locks coordination is unavailable', async () => {
    const client = new FakeResumeClient();
    const errors: string[] = [];
    const controller = installSyncularBrowserLifecycleResume(client, {
      lock: { name: 'syncular:test:required', required: true },
      navigator: {},
      onResumeError(error, context) {
        errors.push(
          `${error instanceof SyncularBrowserLifecycleResumeLockError}:${context.lockState}:${context.lockRequired}:${context.lockName}`
        );
      },
    });

    await expect(controller.resume('manual')).rejects.toBeInstanceOf(
      SyncularBrowserLifecycleResumeLockError
    );

    expect(client.calls).toEqual([]);
    expect(errors).toEqual(['true:unavailable:true:syncular:test:required']);
  });

  it('rejects contended lifecycle Web Locks after the configured timeout', async () => {
    const firstClient = new FakeResumeClient({ deferred: true });
    const secondClient = new FakeResumeClient();
    const locks = new FakeWebLocks();
    const navigator = { locks };
    const errors: string[] = [];
    const first = installSyncularBrowserLifecycleResume(firstClient, {
      lock: { name: 'syncular:test:contended' },
      navigator,
    });
    const second = installSyncularBrowserLifecycleResume(secondClient, {
      lock: { name: 'syncular:test:contended', timeoutMs: 5 },
      navigator,
      onResumeError(error, context) {
        errors.push(
          `${error instanceof SyncularBrowserLifecycleResumeLockTimeoutError}:${context.lockState}:${context.lockTimeoutMs}:${context.lockName}`
        );
      },
    });

    const firstResume = first.resume('manual');
    await waitFor(() => firstClient.calls.length === 1);

    const secondResume = second.resume('online');

    await expect(secondResume).rejects.toBeInstanceOf(
      SyncularBrowserLifecycleResumeLockTimeoutError
    );
    expect(secondClient.calls).toEqual([]);
    expect(errors).toEqual(['true:timed-out:5:syncular:test:contended']);

    firstClient.resolveNext('first');
    await firstResume;
  });

  it('removes page listeners when destroyed', () => {
    const client = new FakeResumeClient();
    const document = new FakeDocument('visible');
    const global = new FakeGlobal(document);
    const controller = installSyncularBrowserLifecycleResume(client, {
      global,
    });

    controller.destroy();
    document.dispatch('visibilitychange');
    global.dispatch('pagehide');
    global.dispatch('beforeunload');
    global.dispatch('freeze');
    global.dispatch('pageshow');
    global.dispatch('online');
    global.dispatch('resume');

    expect(client.calls).toEqual([]);
  });

  it('reports resume errors through the configured handler', async () => {
    const client = new FakeResumeClient();
    client.error = new Error('resume failed');
    const document = new FakeDocument('visible');
    const global = new FakeGlobal(document);
    const errors: Array<{ error: unknown; reason: string }> = [];

    installSyncularBrowserLifecycleResume(client, {
      global,
      onResumeError(error, context) {
        errors.push({ error, reason: context.reason });
      },
    });

    global.dispatch('online');

    await waitFor(() => errors.length === 1);
    expect(errors[0]?.reason).toBe('online');
    expect(errors[0]?.error).toBe(client.error);
  });
});

class FakeResumeClient {
  calls: string[] = [];
  error: unknown;
  readonly #deferred: boolean;
  readonly #pending: Array<{
    resolve(result: SyncularSyncResult): void;
    reject(error: unknown): void;
  }> = [];

  constructor(options: { deferred?: boolean } = {}) {
    this.#deferred = options.deferred === true;
  }

  resumeFromBackground(
    options: SyncularSyncRequestOptions = {}
  ): Promise<SyncularSyncResult> {
    const label = options.syncAttempt?.id ?? 'resume';
    this.calls.push(label);
    if (this.error) return Promise.reject(this.error);
    if (this.#deferred) {
      return new Promise((resolve, reject) => {
        this.#pending.push({ resolve, reject });
      });
    }
    return Promise.resolve(syncResult(label));
  }

  resolveNext(label: string): void {
    const pending = this.#pending.shift();
    if (!pending) throw new Error('no pending resume');
    pending.resolve(syncResult(label));
  }
}

class FakeDocument {
  readonly #listeners = new Map<string, Set<(event?: unknown) => void>>();

  constructor(public visibilityState: 'hidden' | 'visible') {}

  addEventListener(type: string, listener: EventListenerOrEventListenerObject) {
    this.listeners(type).add(listener as (event?: unknown) => void);
  }

  removeEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject
  ) {
    this.listeners(type).delete(listener as (event?: unknown) => void);
  }

  dispatch(type: string, event?: unknown): void {
    for (const listener of this.listeners(type)) listener(event);
  }

  private listeners(type: string): Set<(event?: unknown) => void> {
    let listeners = this.#listeners.get(type);
    if (!listeners) {
      listeners = new Set();
      this.#listeners.set(type, listeners);
    }
    return listeners;
  }
}

class FakeGlobal {
  readonly #listeners = new Map<string, Set<(event?: unknown) => void>>();

  constructor(public document: FakeDocument) {}

  addEventListener(type: string, listener: EventListenerOrEventListenerObject) {
    this.listeners(type).add(listener as (event?: unknown) => void);
  }

  removeEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject
  ) {
    this.listeners(type).delete(listener as (event?: unknown) => void);
  }

  dispatch(type: string, event?: unknown): void {
    for (const listener of this.listeners(type)) listener(event);
  }

  private listeners(type: string): Set<(event?: unknown) => void> {
    let listeners = this.#listeners.get(type);
    if (!listeners) {
      listeners = new Set();
      this.#listeners.set(type, listeners);
    }
    return listeners;
  }
}

class FakeWebLocks {
  readonly requests: string[] = [];
  #active = false;
  readonly #queue: FakeWebLockWaiter[] = [];

  async request<T>(
    name: string,
    options: { mode: 'exclusive'; signal?: AbortSignal },
    callback: () => T | Promise<T>
  ): Promise<T> {
    this.requests.push(name);
    if (options.signal?.aborted) throw abortError();
    if (this.#active) {
      await this.waitForTurn(options.signal);
    }
    this.#active = true;
    try {
      return await callback();
    } finally {
      this.#active = false;
      this.releaseNext();
    }
  }

  private waitForTurn(signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) return Promise.reject(abortError());
    return new Promise((resolve, reject) => {
      const waiter: FakeWebLockWaiter = {
        cleanup: () => {},
        reject: (error) => {
          waiter.cleanup();
          reject(error);
        },
        resolve: () => {
          waiter.cleanup();
          resolve();
        },
        signal,
      };
      const onAbort = () => {
        const index = this.#queue.indexOf(waiter);
        if (index >= 0) this.#queue.splice(index, 1);
        waiter.reject(abortError());
      };
      waiter.cleanup = () => signal?.removeEventListener('abort', onAbort);
      signal?.addEventListener('abort', onAbort, { once: true });
      this.#queue.push(waiter);
    });
  }

  private releaseNext(): void {
    while (this.#queue.length > 0) {
      const waiter = this.#queue.shift();
      if (!waiter) return;
      if (waiter.signal?.aborted) {
        waiter.reject(abortError());
        continue;
      }
      waiter.resolve();
      return;
    }
  }
}

interface FakeWebLockWaiter {
  cleanup(): void;
  reject(error: unknown): void;
  resolve(): void;
  signal?: AbortSignal;
}

function abortError(): Error {
  const error = new Error('AbortError');
  error.name = 'AbortError';
  return error;
}

function syncResult(label: string): SyncularSyncResult {
  return {
    changedTables: [label],
    changedRows: [],
    changedRowsTruncated: false,
    subscriptions: [],
    bootstrap: {
      channelPhase: 'idle',
      progressPercent: 100,
      isBootstrapping: false,
      criticalReady: true,
      interactiveReady: true,
      complete: true,
      activePhase: null,
      expectedSubscriptionIds: [],
      readySubscriptionIds: [],
      pendingSubscriptionIds: [],
      subscriptions: [],
      phases: [],
    },
    pushedCommits: 0,
    timings: {
      pushMs: 0,
      pullMs: 0,
      totalMs: 0,
      serverMs: 0,
      applyMs: 0,
    },
  };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 1000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('Timed out waiting for predicate');
}
