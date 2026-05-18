import { describe, expect, it } from 'bun:test';
import { SyncularV2ClientLifecycle } from './client';
import type {
  SyncularV2DiagnosticEvent,
  SyncularV2DiagnosticSink,
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
    const lifecycle = new SyncularV2ClientLifecycle(client, {
      realtime: true,
    });

    await lifecycle.start();
    expect(client.syncCount).toBe(1);

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
      realtime: true,
      initialSync: false,
    });

    await lifecycle.start();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(client.syncCount).toBe(0);

    await lifecycle.stop();
    expect(client.calls.at(-1)).toBe('stopRealtime');
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

  async startRealtime(options?: boolean | Record<string, unknown>): Promise<void> {
    this.calls.push('startRealtime');
    this.realtimeOptions = options;
  }

  async stopRealtime(): Promise<void> {
    this.calls.push('stopRealtime');
  }

  async syncOnce(): Promise<SyncularV2SyncResult> {
    this.calls.push('syncOnce');
    this.syncCount += 1;
    return {
      changedTables: [],
      changedRows: [],
      changedRowsTruncated: false,
      subscriptions: [],
      pushedCommits: 0,
      timings: {
        totalMs: 0,
        pushMs: 0,
        pullMs: 0,
        pullRequestMs: 0,
        pullTransformMs: 0,
        snapshotFetchMs: 0,
        pullApplyMs: 0,
        notifyMs: 0,
      },
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
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error('timed out waiting for condition');
}
