import { describe, expect, it } from 'bun:test';
import {
  createSyncularBridgeClient,
  type SyncularBridge,
  type SyncularBridgeMutationBatch,
} from './bridge-client';
import type {
  SyncularV2ClientEventMap,
  SyncularV2ClientEventSink,
  SyncularV2ClientEventType,
} from './types';

describe('Syncular bridge client', () => {
  it('exposes the shared ergonomic client shape over a host bridge', async () => {
    const bridge = new FakeBridge();
    const client = await createSyncularBridgeClient<TestDb>({
      bridge,
    });

    bridge.nextRows = [{ id: 'task-1', title: 'Bridge query' }];
    const rows = await client.db.selectFrom('tasks').selectAll().execute();
    expect(rows).toEqual([{ id: 'task-1', title: 'Bridge query' }]);
    expect(bridge.queries[0]?.sql).toContain('select * from "tasks"');

    await client.mutations.tasks.update('task-1', { completed: 1 });
    expect(bridge.lastBatch?.operations).toEqual([
      {
        table: 'tasks',
        row_id: 'task-1',
        op: 'upsert',
        payload: { completed: 1 },
        base_version: null,
      },
    ]);
    expect(bridge.syncCount).toBe(1);

    const changedTables: string[][] = [];
    const unsubscribe = client.on('rowsChanged', (event) => {
      changedTables.push(event.changedTables);
    });
    bridge.emit('rowsChanged', {
      source: 'remotePull',
      changedTables: ['tasks'],
      changedRows: [],
    });
    unsubscribe();
    expect(changedTables).toEqual([['tasks']]);

    bridge.status = {
      connection: {
        closed: false,
        pendingRequests: 0,
        realtime: 'connected',
      },
      outbox: {
        pending: 1,
        sending: 0,
        failed: 0,
        acked: 0,
        total: 1,
      },
    };
    expect(client.getStatus().isConnected).toBe(true);
    expect(client.getStatus().hasPendingMutations).toBe(true);

    await client.destroy();
    expect(bridge.closed).toBe(true);
  });
});

interface TestDb {
  tasks: {
    id: string;
    title: string;
    completed?: number;
  };
}

class FakeBridge implements SyncularBridge {
  queries: Array<{ sql: string; parameters: readonly unknown[] }> = [];
  nextRows: Array<Record<string, unknown>> = [];
  lastBatch: SyncularBridgeMutationBatch | null = null;
  syncCount = 0;
  closed = false;
  status: ReturnType<NonNullable<SyncularBridge['getStatus']>> = {};
  readonly #listeners = new Map<
    SyncularV2ClientEventType,
    Set<SyncularV2ClientEventSink<SyncularV2ClientEventType>>
  >();

  executeSql(request: { sql: string; parameters: readonly unknown[] }) {
    this.queries.push(request);
    return { rows: this.nextRows };
  }

  applyMutationsCommit(batch: SyncularBridgeMutationBatch) {
    this.lastBatch = batch;
    return 'bridge-commit';
  }

  async sync() {
    this.syncCount += 1;
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
      timings: {
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
        snapshotChunkResetMs: 0,
        snapshotChunkBindMs: 0,
        snapshotChunkStepMs: 0,
        commitApplyMs: 0,
        subscriptionStateMs: 0,
        notifyMs: 0,
      },
    };
  }

  close() {
    this.closed = true;
  }

  getStatus() {
    return this.status;
  }

  on<T extends SyncularV2ClientEventType>(
    event: T,
    listener: SyncularV2ClientEventSink<T>
  ): () => void {
    const listeners = this.#listeners.get(event) ?? new Set();
    listeners.add(
      listener as SyncularV2ClientEventSink<SyncularV2ClientEventType>
    );
    this.#listeners.set(event, listeners);
    return () => {
      listeners.delete(
        listener as SyncularV2ClientEventSink<SyncularV2ClientEventType>
      );
    };
  }

  emit<T extends SyncularV2ClientEventType>(
    event: T,
    payload: SyncularV2ClientEventMap[T]
  ): void {
    for (const listener of this.#listeners.get(event) ?? []) {
      listener(payload as never);
    }
  }
}
