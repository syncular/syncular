import { GlobalRegistrator } from '@happy-dom/global-registrator';
import { act, renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'bun:test';
import { createElement, type ReactNode } from 'react';
import { createSyncularV2React } from './react';
import type {
  SyncularV2BlobUploadQueueStats,
  SyncularV2BootstrapStatus,
  SyncularV2ClientEventMap,
  SyncularV2ClientEventSink,
  SyncularV2ClientEventType,
  SyncularV2ConnectionState,
  SyncularV2DiagnosticSink,
  SyncularV2LiveQueryChange,
  SyncularV2LiveQueryOptions,
  SyncularV2LiveQuerySubscription,
  SyncularV2ManagedClient,
  SyncularV2PresenceChangeEvent,
  SyncularV2PresenceEntry,
  SyncularV2PresenceSink,
  SyncularV2RowsChangedEvent,
} from './index';

if (!GlobalRegistrator.isRegistered) {
  GlobalRegistrator.register();
}

describe('@syncular/client-rust/react', () => {
  it('joins presence on mount, exposes members, and leaves on unmount', async () => {
    const fake = new FakeManagedClient();
    const { SyncularProvider, usePresence } = createSyncularV2React<TestDb>();
    const wrapper = createWrapper(SyncularProvider, fake.client);

    const { result, unmount } = renderHook(
      () =>
        usePresence({
          scopeKey: 'document:one',
          metadata: { cursor: 1 },
        }),
      { wrapper }
    );

    await waitFor(() => {
      expect(result.current.members).toHaveLength(1);
    });
    expect(result.current.members[0]?.metadata).toEqual({ cursor: 1 });

    act(() => result.current.updateMetadata({ cursor: 2 }));
    expect(result.current.members[0]?.metadata).toEqual({ cursor: 2 });

    unmount();
    expect(fake.leftScopes).toEqual(['document:one']);
  });

  it('filters row change events by table', () => {
    const fake = new FakeManagedClient();
    const { SyncularProvider, useRowsChanged } = createSyncularV2React<TestDb>();
    const wrapper = createWrapper(SyncularProvider, fake.client);
    const events: SyncularV2RowsChangedEvent[] = [];

    renderHook(
      () => useRowsChanged((event) => events.push(event), { tables: ['tasks'] }),
      { wrapper }
    );

    act(() => {
      fake.emitRowsChanged({
        source: 'remotePull',
        changedTables: ['notes'],
        changedRows: [],
      });
      fake.emitRowsChanged({
        source: 'remotePull',
        changedTables: ['tasks'],
        changedRows: [
          {
            table: 'tasks',
            rowId: 'task-1',
            operation: 'update',
            changedFields: ['title'],
            crdtFields: [],
          },
        ],
      });
    });

    expect(events).toHaveLength(1);
    expect(events[0]?.changedRows[0]?.rowId).toBe('task-1');
  });

  it('exposes outbox and conflict stats as React state', () => {
    const fake = new FakeManagedClient();
    const { SyncularProvider, useConflictStats, useOutboxStats } =
      createSyncularV2React<TestDb>();
    const wrapper = createWrapper(SyncularProvider, fake.client);

    const { result } = renderHook(
      () => ({
        outbox: useOutboxStats(),
        conflicts: useConflictStats(),
      }),
      { wrapper }
    );

    expect(result.current.outbox).toBeNull();
    expect(result.current.conflicts).toBeNull();

    act(() => {
      fake.emit('outboxChanged', {
        pending: 2,
        sending: 1,
        failed: 0,
        acked: 4,
        total: 7,
      });
      fake.emit('conflictsChanged', {
        unresolved: 1,
        resolved: 3,
        total: 4,
      });
    });

    expect(result.current.outbox?.pending).toBe(2);
    expect(result.current.conflicts?.unresolved).toBe(1);
  });

  it('subscribes to Rust live queries and unsubscribes on cleanup', async () => {
    const fake = new FakeManagedClient();
    fake.nextLiveRows = [{ id: 'task-1', title: 'Write adapter' }];
    const { SyncularProvider, useLiveQuery } = createSyncularV2React<TestDb>();
    const wrapper = createWrapper(SyncularProvider, fake.client);

    const { result, unmount } = renderHook(
      () => useLiveQuery<TaskRow>(compiledQuery(), { tables: ['tasks'] }),
      { wrapper }
    );

    await waitFor(() => {
      expect(result.current.rows).toEqual([
        { id: 'task-1', title: 'Write adapter' },
      ]);
    });
    expect(result.current.isLoading).toBe(false);

    unmount();
    expect(fake.liveUnsubscribed).toBe(true);
  });

  it('wraps async mutations with pending and error state', async () => {
    const fake = new FakeManagedClient();
    const { SyncularProvider, useMutation } = createSyncularV2React<TestDb>();
    const wrapper = createWrapper(SyncularProvider, fake.client);

    const { result } = renderHook(
      () =>
        useMutation(async (_client, title: string) => {
          await Promise.resolve();
          return { id: 'task-1', title };
        }),
      { wrapper }
    );

    let mutationResult: { id: string; title: string } | undefined;
    await act(async () => {
      mutationResult = await result.current.mutate('Ship it');
    });
    expect(mutationResult).toEqual({ id: 'task-1', title: 'Ship it' });
    expect(result.current.isPending).toBe(false);
    expect(result.current.error).toBeNull();
  });
});

interface TestDb {
  tasks: TaskRow;
}

interface TaskRow extends Record<string, unknown> {
  id: string;
  title: string;
}

function createWrapper<DB>(
  Provider: (props: {
    client: SyncularV2ManagedClient<DB>;
    children?: ReactNode;
  }) => ReturnType<typeof createElement>,
  client: SyncularV2ManagedClient<DB>
) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return createElement(Provider, { client, children });
  };
}

function compiledQuery() {
  return {
    compile() {
      return {
        sql: 'select id, title from tasks',
        parameters: [],
        query: { kind: 'SelectQueryNode' },
      };
    },
  };
}

class FakeManagedClient {
  readonly leftScopes: string[] = [];
  nextLiveRows: TaskRow[] = [];
  liveUnsubscribed = false;
  readonly #eventListeners = new Map<
    SyncularV2ClientEventType,
    Set<SyncularV2ClientEventSink<SyncularV2ClientEventType>>
  >();
  readonly #presenceListeners = new Set<SyncularV2PresenceSink>();
  readonly #presence = new Map<string, SyncularV2PresenceEntry[]>();
  readonly #diagnosticListeners = new Set<SyncularV2DiagnosticSink>();

  readonly client = {
    db: {},
    dialect: {},
    mutations: {},
    blobs: {
      getUploadQueueStats: async () => this.blobStats(),
      processUploadQueue: async () => ({ uploaded: 0, failed: 0 }),
      retrieve: async () => new Uint8Array(),
    },
    client: {
      addDiagnosticListener: (listener: SyncularV2DiagnosticSink) => {
        this.#diagnosticListeners.add(listener);
        return () => this.#diagnosticListeners.delete(listener);
      },
      connectionState: () => this.connectionState(),
      addEventListener: <T extends SyncularV2ClientEventType>(
        event: T,
        listener: SyncularV2ClientEventSink<T>
      ) => this.addEventListener(event, listener),
      getPresence: <TMetadata extends Record<string, unknown>>(
        scopeKey: string
      ) => this.getPresence<TMetadata>(scopeKey),
      joinPresence: (
        scopeKey: string,
        metadata?: Record<string, unknown>
      ) => this.joinPresence(scopeKey, metadata),
      leavePresence: (scopeKey: string) => this.leavePresence(scopeKey),
      updatePresenceMetadata: (
        scopeKey: string,
        metadata: Record<string, unknown>
      ) => this.updatePresenceMetadata(scopeKey, metadata),
      addPresenceListener: <TMetadata extends Record<string, unknown>>(
        listener: SyncularV2PresenceSink<TMetadata>
      ) => {
        this.#presenceListeners.add(listener as SyncularV2PresenceSink);
        return () =>
          this.#presenceListeners.delete(listener as SyncularV2PresenceSink);
      },
    },
    live: <Row extends Record<string, unknown>>(
      _query: unknown,
      options: SyncularV2LiveQueryOptions<Row>
    ): Promise<SyncularV2LiveQuerySubscription> => {
      options.onChange(this.nextLiveRows as unknown as Row[], {
        queryId: 'live-1',
        version: 1,
        changedRows: [],
        rows: this.nextLiveRows as unknown as Row[],
        initial: true,
      } satisfies SyncularV2LiveQueryChange<Row>);
      return Promise.resolve({
        id: 'live-1',
        unsubscribe: () => {
          this.liveUnsubscribed = true;
        },
      });
    },
    close: async () => undefined,
    start: async () => undefined,
    stop: async () => undefined,
    destroy: async () => undefined,
    sync: async () => ({
      changedTables: [],
      changedRows: [],
      changedRowsTruncated: false,
      subscriptions: [],
      bootstrap: zeroBootstrapStatus(),
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
        snapshotChunkApplyMs: 0,
        snapshotChunkMaterializeMs: 0,
        commitApplyMs: 0,
        subscriptionStateMs: 0,
        notifyMs: 0,
      },
    }),
  } as unknown as SyncularV2ManagedClient<TestDb>;

  emitRowsChanged(event: SyncularV2RowsChangedEvent): void {
    this.emit('rowsChanged', event);
  }

  private addEventListener<T extends SyncularV2ClientEventType>(
    event: T,
    listener: SyncularV2ClientEventSink<T>
  ): () => void {
    let listeners = this.#eventListeners.get(event);
    if (!listeners) {
      listeners = new Set();
      this.#eventListeners.set(event, listeners);
    }
    listeners.add(
      listener as SyncularV2ClientEventSink<SyncularV2ClientEventType>
    );
    return () =>
      listeners.delete(
        listener as SyncularV2ClientEventSink<SyncularV2ClientEventType>
      );
  }

  emit<T extends SyncularV2ClientEventType>(
    event: T,
    payload: SyncularV2ClientEventMap[T]
  ): void {
    for (const listener of this.#eventListeners.get(event) ?? []) {
      listener(payload as never);
    }
  }

  private joinPresence(
    scopeKey: string,
    metadata?: Record<string, unknown>
  ): void {
    this.#presence.set(scopeKey, [
      {
        clientId: 'client-a',
        actorId: 'actor-a',
        joinedAt: 1,
        metadata,
      },
    ]);
    this.emitPresence(scopeKey);
  }

  private leavePresence(scopeKey: string): void {
    this.leftScopes.push(scopeKey);
    this.#presence.set(scopeKey, []);
    this.emitPresence(scopeKey);
  }

  private updatePresenceMetadata(
    scopeKey: string,
    metadata: Record<string, unknown>
  ): void {
    this.#presence.set(
      scopeKey,
      this.getPresence(scopeKey).map((entry) => ({ ...entry, metadata }))
    );
    this.emitPresence(scopeKey);
  }

  private getPresence<TMetadata extends Record<string, unknown>>(
    scopeKey: string
  ): SyncularV2PresenceEntry<TMetadata>[] {
    return (this.#presence.get(scopeKey) ??
      []) as SyncularV2PresenceEntry<TMetadata>[];
  }

  private emitPresence(scopeKey: string): void {
    const event: SyncularV2PresenceChangeEvent = {
      scopeKey,
      presence: this.getPresence(scopeKey),
    };
    for (const listener of this.#presenceListeners) listener(event);
  }

  private connectionState(): SyncularV2ConnectionState {
    return {
      closed: false,
      pendingRequests: 0,
      realtime: 'connected',
    };
  }

  private blobStats(): SyncularV2BlobUploadQueueStats {
    return {
      pending: 0,
      uploading: 0,
      failed: 0,
    };
  }
}

function zeroBootstrapStatus(): SyncularV2BootstrapStatus {
  return {
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
  };
}
