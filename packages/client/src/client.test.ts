import { describe, expect, it } from 'bun:test';
import { SyncularClientLifecycle } from './client';
import type {
  SyncularDiagnosticEvent,
  SyncularDiagnosticSink,
  SyncularNetworkStatusSource,
  SyncularRealtimeConnectionState,
  SyncularSubscriptionSpec,
  SyncularSyncResult,
} from './types';

describe('Syncular browser client lifecycle', () => {
  it('starts subscriptions, initial sync, and realtime in order', async () => {
    const client = new FakeLifecycleClient();
    const subscription = taskSubscription('actor');
    const lifecycle = new SyncularClientLifecycle(client, {
      subscriptions: [subscription],
      realtime: { wsUrl: 'wss://example.test/sync/realtime' },
    });

    await lifecycle.start();

    expect(client.calls).toEqual([
      'setSubscriptions',
      'syncOnce',
      'startRealtime',
    ]);
    expect(client.subscriptions).toEqual([subscription]);
    expect(client.realtimeOptions).toEqual({
      wsUrl: 'wss://example.test/sync/realtime',
    });
  });

  it('uses websocket reconnects as wakeups for HTTP catchup', async () => {
    const client = new FakeLifecycleClient();
    const lifecycle = new SyncularClientLifecycle(client);

    await lifecycle.start();
    expect(client.syncCount).toBe(1);
    expect(client.calls).toEqual(['syncOnce', 'startRealtime']);

    client.emitRealtimeState('connected');
    await Promise.resolve();
    expect(client.syncCount).toBe(1);

    client.emitRealtimeState('disconnected');
    client.emitRealtimeState('connected');
    await waitFor(() => client.syncCount === 2);
  });

  it('keeps interval polling opt-in', async () => {
    const client = new FakeLifecycleClient();
    const lifecycle = new SyncularClientLifecycle(client, {
      initialSync: false,
    });

    await lifecycle.start();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(client.syncCount).toBe(0);

    await lifecycle.stop();
    expect(client.calls.at(-1)).toBe('stopRealtime');
  });

  it('forces bootstrap and resyncs when sync diagnostics require resync', async () => {
    const client = new FakeLifecycleClient();
    const lifecycle = new SyncularClientLifecycle(client);

    await lifecycle.start();
    client.emitSyncResyncRequired();

    await waitFor(() => client.calls.includes('forceSubscriptionsBootstrap'));
    await waitFor(() => client.syncCount === 2);
    expect(client.calls).toEqual([
      'syncOnce',
      'startRealtime',
      'forceSubscriptionsBootstrap',
      'syncOnce',
    ]);
  });

  it('starts offline and syncs when the browser comes online', async () => {
    const client = new FakeLifecycleClient();
    const network = new FakeNetworkStatus(false);
    const lifecycle = new SyncularClientLifecycle(client, { network });

    await lifecycle.start();

    expect(client.calls).toEqual([]);

    network.setOnline(true);

    await waitFor(
      () => client.syncCount === 1 && client.calls.includes('startRealtime')
    );
    expect(client.calls).toEqual(['syncOnce', 'startRealtime']);
  });

  it('keeps lifecycle running when initial sync hits a retryable offline error', async () => {
    const client = new FakeLifecycleClient();
    client.syncError = new Error('browser fetch failed: offline');
    const lifecycle = new SyncularClientLifecycle(client, {
      network: new FakeNetworkStatus(true),
    });

    await lifecycle.start();

    expect(client.calls).toEqual(['syncOnce', 'startRealtime']);
  });

  it('coalesces concurrent sync callers onto one awaited follow-up', async () => {
    const client = new FakeLifecycleClient();
    client.deferSync = true;
    const lifecycle = new SyncularClientLifecycle(client, {
      initialSync: false,
      realtime: false,
    });

    await lifecycle.start();

    const first = lifecycle.sync();
    const second = lifecycle.sync();
    const third = lifecycle.sync();
    let secondResolved = false;
    second.then(() => {
      secondResolved = true;
    });

    expect(client.syncCount).toBe(1);
    client.resolveNextSync('first');

    await expect(first).resolves.toMatchObject({
      changedTables: ['first'],
    });
    await waitFor(() => client.syncCount === 2);
    expect(secondResolved).toBe(false);

    client.resolveNextSync('second');

    await expect(second).resolves.toMatchObject({
      changedTables: ['second'],
    });
    await expect(third).resolves.toMatchObject({
      changedTables: ['second'],
    });
    expect(client.syncCount).toBe(2);
  });

  it('schedules another follow-up for callers that arrive during the queued sync', async () => {
    const client = new FakeLifecycleClient();
    client.deferSync = true;
    const lifecycle = new SyncularClientLifecycle(client, {
      initialSync: false,
      realtime: false,
    });

    await lifecycle.start();

    const first = lifecycle.sync();
    const second = lifecycle.sync();
    client.resolveNextSync('first');

    await expect(first).resolves.toMatchObject({
      changedTables: ['first'],
    });
    await waitFor(() => client.syncCount === 2);

    const third = lifecycle.sync();
    expect(client.syncCount).toBe(2);

    client.resolveNextSync('second');

    await expect(second).resolves.toMatchObject({
      changedTables: ['second'],
    });
    await waitFor(() => client.syncCount === 3);
    client.resolveNextSync('third');

    await expect(third).resolves.toMatchObject({
      changedTables: ['third'],
    });
    expect(client.syncCount).toBe(3);
  });

  it('runs a queued sync even when the in-flight sync fails', async () => {
    const client = new FakeLifecycleClient();
    client.deferSync = true;
    const lifecycle = new SyncularClientLifecycle(client, {
      initialSync: false,
      realtime: false,
    });

    await lifecycle.start();

    const first = lifecycle.sync();
    const second = lifecycle.sync();
    const firstError = new Error('first sync failed');
    client.rejectNextSync(firstError);

    await expect(first).rejects.toThrow('first sync failed');
    await waitFor(() => client.syncCount === 2);

    client.resolveNextSync('second');

    await expect(second).resolves.toMatchObject({
      changedTables: ['second'],
    });
  });

  it('rejects queued sync callers when the queued follow-up fails', async () => {
    const client = new FakeLifecycleClient();
    client.deferSync = true;
    const lifecycle = new SyncularClientLifecycle(client, {
      initialSync: false,
      realtime: false,
    });

    await lifecycle.start();

    const first = lifecycle.sync();
    const second = lifecycle.sync();
    client.resolveNextSync('first');

    await expect(first).resolves.toMatchObject({
      changedTables: ['first'],
    });
    await waitFor(() => client.syncCount === 2);

    client.rejectNextSync(new Error('queued sync failed'));

    await expect(second).rejects.toThrow('queued sync failed');
  });
});

function taskSubscription(actorId: string): SyncularSubscriptionSpec {
  return {
    id: `tasks:${actorId}`,
    table: 'tasks',
    scopes: { user_id: actorId },
  };
}

class FakeLifecycleClient {
  calls: string[] = [];
  subscriptions: readonly SyncularSubscriptionSpec[] = [];
  realtimeOptions: boolean | Record<string, unknown> | undefined;
  syncCount = 0;
  syncError: unknown = undefined;
  deferSync = false;
  readonly deferredSyncs: Array<{
    resolve(result: SyncularSyncResult): void;
    reject(error: unknown): void;
  }> = [];
  realtime: SyncularRealtimeConnectionState = 'disconnected';
  readonly #diagnosticListeners = new Set<SyncularDiagnosticSink>();

  addDiagnosticListener(listener: SyncularDiagnosticSink): () => void {
    this.#diagnosticListeners.add(listener);
    return () => {
      this.#diagnosticListeners.delete(listener);
    };
  }

  connectionState(): {
    closed: boolean;
    pendingRequests: number;
    realtime: SyncularRealtimeConnectionState;
  } {
    return {
      closed: false,
      pendingRequests: 0,
      realtime: this.realtime,
    };
  }

  async setSubscriptions(
    subscriptions: readonly SyncularSubscriptionSpec[]
  ): Promise<void> {
    this.calls.push('setSubscriptions');
    this.subscriptions = subscriptions;
  }

  async forceSubscriptionsBootstrap(): Promise<number> {
    this.calls.push('forceSubscriptionsBootstrap');
    return this.subscriptions.length;
  }

  async startRealtime(
    options?: boolean | Record<string, unknown>
  ): Promise<void> {
    this.calls.push('startRealtime');
    this.realtimeOptions = options;
  }

  async stopRealtime(): Promise<void> {
    this.calls.push('stopRealtime');
  }

  async syncOnce(): Promise<SyncularSyncResult> {
    this.calls.push('syncOnce');
    this.syncCount += 1;
    if (this.syncError) throw this.syncError;
    if (this.deferSync) {
      return new Promise((resolve, reject) => {
        this.deferredSyncs.push({ resolve, reject });
      });
    }
    return syncResult();
  }

  resolveNextSync(label: string): void {
    const deferred = this.deferredSyncs.shift();
    if (!deferred) throw new Error('no deferred sync to resolve');
    deferred.resolve(syncResult(label));
  }

  rejectNextSync(error: unknown): void {
    const deferred = this.deferredSyncs.shift();
    if (!deferred) throw new Error('no deferred sync to reject');
    deferred.reject(error);
  }

  emitRealtimeState(state: SyncularRealtimeConnectionState): void {
    this.realtime = state;
    const event: SyncularDiagnosticEvent = {
      at: Date.now(),
      level: 'info',
      source: 'realtime',
      code: 'realtime.state',
      message: `realtime ${state}`,
      details: { state },
    };
    for (const listener of this.#diagnosticListeners) listener(event);
  }

  emitSyncResyncRequired(): void {
    const event: SyncularDiagnosticEvent = {
      at: Date.now(),
      level: 'error',
      source: 'sync',
      code: 'sync.resync_required',
      message: 'sync requires resync',
      details: { resyncRequired: true },
    };
    for (const listener of this.#diagnosticListeners) listener(event);
  }
}

function syncResult(label?: string): SyncularSyncResult {
  return {
    changedTables: [],
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
    timings: zeroSyncTimings(),
    ...(label ? { changedTables: [label] } : {}),
  };
}

class FakeNetworkStatus implements SyncularNetworkStatusSource {
  #online: boolean;
  readonly #listeners = new Map<'online' | 'offline', Set<() => void>>([
    ['online', new Set()],
    ['offline', new Set()],
  ]);

  constructor(online: boolean) {
    this.#online = online;
  }

  isOnline(): boolean {
    return this.#online;
  }

  addEventListener(type: 'online' | 'offline', listener: () => void): void {
    this.#listeners.get(type)?.add(listener);
  }

  removeEventListener(type: 'online' | 'offline', listener: () => void): void {
    this.#listeners.get(type)?.delete(listener);
  }

  setOnline(online: boolean): void {
    if (this.#online === online) return;
    this.#online = online;
    const type = online ? 'online' : 'offline';
    for (const listener of this.#listeners.get(type) ?? []) listener();
  }
}

function zeroSyncTimings(): SyncularSyncResult['timings'] {
  return {
    totalMs: 0,
    pushMs: 0,
    pullMs: 0,
    pullRequestMs: 0,
    syncPackDecodeMs: 0,
    pullTransformMs: 0,
    integrityVerifyMs: 0,
    snapshotFetchMs: 0,
    pullApplyMs: 0,
    scopeClearMs: 0,
    snapshotRowApplyMs: 0,
    snapshotArtifactApplyMs: 0,
    snapshotArtifactCheckpointMs: 0,
    snapshotArtifactCheckpointCount: 0,
    snapshotChunkApplyMs: 0,
    snapshotChunkMaterializeMs: 0,
    commitApplyMs: 0,
    subscriptionStateMs: 0,
    notifyMs: 0,
    ...({
      snapshotChunkResetMs: 0,
      snapshotChunkBindMs: 0,
      snapshotChunkStepMs: 0,
    } as object),
  } as SyncularSyncResult['timings'];
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error('timed out waiting for condition');
}
