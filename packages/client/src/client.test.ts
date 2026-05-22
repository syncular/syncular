import { describe, expect, it } from 'bun:test';
import { SyncularV2ClientLifecycle } from './client';
import type {
  SyncularV2DiagnosticEvent,
  SyncularV2DiagnosticSink,
  SyncularV2NetworkStatusSource,
  SyncularV2RealtimeConnectionState,
  SyncularV2SubscriptionSpec,
  SyncularV2SyncResult,
} from './types';

describe('Syncular v2 browser client lifecycle', () => {
  it('starts subscriptions, initial sync, and realtime in order', async () => {
    const client = new FakeLifecycleClient();
    const subscription = taskSubscription('actor');
    const lifecycle = new SyncularV2ClientLifecycle(client, {
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
    const lifecycle = new SyncularV2ClientLifecycle(client);

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
    const lifecycle = new SyncularV2ClientLifecycle(client, {
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
    const lifecycle = new SyncularV2ClientLifecycle(client);

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
    const lifecycle = new SyncularV2ClientLifecycle(client, { network });

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
    const lifecycle = new SyncularV2ClientLifecycle(client, {
      network: new FakeNetworkStatus(true),
    });

    await lifecycle.start();

    expect(client.calls).toEqual(['syncOnce', 'startRealtime']);
  });
});

function taskSubscription(actorId: string): SyncularV2SubscriptionSpec {
  return {
    id: `tasks:${actorId}`,
    table: 'tasks',
    scopes: { user_id: actorId },
  };
}

class FakeLifecycleClient {
  calls: string[] = [];
  subscriptions: readonly SyncularV2SubscriptionSpec[] = [];
  realtimeOptions: boolean | Record<string, unknown> | undefined;
  syncCount = 0;
  syncError: unknown = undefined;
  realtime: SyncularV2RealtimeConnectionState = 'disconnected';
  readonly #diagnosticListeners = new Set<SyncularV2DiagnosticSink>();

  addDiagnosticListener(listener: SyncularV2DiagnosticSink): () => void {
    this.#diagnosticListeners.add(listener);
    return () => {
      this.#diagnosticListeners.delete(listener);
    };
  }

  connectionState(): {
    closed: boolean;
    pendingRequests: number;
    realtime: SyncularV2RealtimeConnectionState;
  } {
    return {
      closed: false,
      pendingRequests: 0,
      realtime: this.realtime,
    };
  }

  async setSubscriptions(
    subscriptions: readonly SyncularV2SubscriptionSpec[]
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

  async syncOnce(): Promise<SyncularV2SyncResult> {
    this.calls.push('syncOnce');
    this.syncCount += 1;
    if (this.syncError) throw this.syncError;
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
    };
  }

  emitRealtimeState(state: SyncularV2RealtimeConnectionState): void {
    this.realtime = state;
    const event: SyncularV2DiagnosticEvent = {
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
    const event: SyncularV2DiagnosticEvent = {
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

class FakeNetworkStatus implements SyncularV2NetworkStatusSource {
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

function zeroSyncTimings(): SyncularV2SyncResult['timings'] {
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
  } as SyncularV2SyncResult['timings'];
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error('timed out waiting for condition');
}
