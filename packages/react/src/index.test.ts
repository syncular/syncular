import { describe, expect, it } from 'bun:test';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { CompiledQuery } from 'kysely';
import { createElement, type ReactNode } from 'react';
import { registerHappyDomForTestFile } from './__tests__/happy-dom';
import type {
  SyncularBlobUploadQueueStats,
  SyncularBootstrapStatus,
  SyncularClientEventMap,
  SyncularClientEventSink,
  SyncularClientEventType,
  SyncularClientLike,
  SyncularClientStatus,
  SyncularConnectionState,
  SyncularDiagnosticSink,
  SyncularPresenceChangeEvent,
  SyncularPresenceEntry,
  SyncularPresenceSink,
  SyncularRowsChangedEvent,
} from './index';
import { createSyncularReact } from './index';

registerHappyDomForTestFile();

describe('@syncular/react', () => {
  it('runs ergonomic sync queries and refreshes on watched table changes', async () => {
    const fake = new FakeManagedClient();
    const { SyncProvider, useSyncQuery } = createSyncularReact<TestDb>();
    const wrapper = createWrapper(SyncProvider, fake.client);

    fake.nextQueryRows = [{ id: 'task-1', title: 'Write adapter' }];
    const { result } = renderHook(
      () =>
        useSyncQuery(
          ({ selectFrom }) =>
            selectFrom('tasks').select(['id', 'title']).execute(),
          { watchTables: ['tasks'] }
        ),
      { wrapper }
    );

    await waitFor(() => {
      expect(result.current.data).toEqual([
        { id: 'task-1', title: 'Write adapter' },
      ]);
    });
    expect(result.current.isLoading).toBe(false);

    fake.nextQueryRows = [{ id: 'task-1', title: 'Ship adapter' }];
    act(() => {
      fake.emitRowsChanged({
        source: 'remotePull',
        changedTables: ['notes'],
        changedRows: [],
      });
    });
    expect(result.current.data).toEqual([
      { id: 'task-1', title: 'Write adapter' },
    ]);

    act(() => {
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

    await waitFor(() => {
      expect(result.current.data).toEqual([
        { id: 'task-1', title: 'Ship adapter' },
      ]);
    });
  });

  it('uses live query observation for compilable sync queries', async () => {
    const fake = new FakeManagedClient();
    const { SyncProvider, useSyncQuery } = createSyncularReact<TestDb>();
    const wrapper = createWrapper(SyncProvider, fake.client);
    let executeCount = 0;

    fake.nextQueryRows = [{ id: 'task-live', title: 'Initial live' }];
    const query = {
      execute: async () => {
        executeCount += 1;
        return fake.nextQueryRows;
      },
      compile: () =>
        ({
          sql: 'select * from "tasks"',
          parameters: [],
        }) as unknown as CompiledQuery,
    };

    const { result } = renderHook(
      () => useSyncQuery(() => query, { tables: ['tasks'] }),
      { wrapper }
    );

    await waitFor(() => {
      expect(result.current.data).toEqual([
        { id: 'task-live', title: 'Initial live' },
      ]);
    });
    expect(fake.liveCalls).toEqual([{ tables: ['tasks'] }]);
    const countAfterInitialLoad = executeCount;

    act(() => {
      fake.emitRowsChanged({
        source: 'remotePull',
        changedTables: ['tasks'],
        changedRows: [
          {
            table: 'tasks',
            rowId: 'task-live',
            operation: 'update',
            changedFields: ['title'],
            crdtFields: [],
          },
        ],
      });
    });
    expect(executeCount).toBe(countAfterInitialLoad);

    act(() => {
      fake.emitLiveQuery('live-1', [
        { id: 'task-live', title: 'Observed live' },
      ]);
    });

    await waitFor(() => {
      expect(result.current.data).toEqual([
        { id: 'task-live', title: 'Observed live' },
      ]);
    });
  });

  it('exposes ergonomic table mutations and background sync state', async () => {
    const fake = new FakeManagedClient();
    const { SyncProvider, useMutations } = createSyncularReact<TestDb>();
    const wrapper = createWrapper(SyncProvider, fake.client);

    const { result } = renderHook(() => useMutations(), { wrapper });

    await act(async () => {
      await result.current.tasks.update('task-1', { completed: 1 });
    });
    let batchResult: string | undefined;
    await act(async () => {
      const batch = await result.current.$commit(async (tx) => {
        await tx.tasks.update('task-2', { completed: 0 });
        return 'batch-result';
      });
      batchResult = batch.result;
    });

    expect(fake.mutationCalls).toEqual([
      {
        table: 'tasks',
        method: 'update',
        args: ['task-1', { completed: 1 }, undefined],
      },
      {
        table: 'tasks',
        method: 'update',
        args: ['task-2', { completed: 0 }, undefined],
      },
    ]);
    expect(batchResult).toBe('batch-result');
    expect(fake.syncCount).toBe(2);
    expect(result.current.$isPending).toBe(false);
    expect(result.current.$error).toBeNull();
  });

  it('exposes leased mutation hooks through the same ergonomic shape', async () => {
    const fake = new FakeManagedClient();
    const { SyncProvider, useLeasedMutation, useLeasedMutations } =
      createSyncularReact<TestDb>();
    const wrapper = createWrapper(SyncProvider, fake.client);

    const tableHook = renderHook(
      () => useLeasedMutation({ table: 'tasks', syncImmediately: false }),
      { wrapper }
    );
    await act(async () => {
      await tableHook.result.current.mutate.update('task-1', { completed: 1 });
    });

    const rootHook = renderHook(() => useLeasedMutations({ sync: false }), {
      wrapper,
    });
    await act(async () => {
      await rootHook.result.current.tasks.upsert('task-2', { completed: 0 });
    });

    expect(fake.mutationCalls).toEqual([]);
    expect(fake.leasedMutationCalls).toEqual([
      {
        table: 'tasks',
        method: 'update',
        args: ['task-1', { completed: 1 }, undefined],
      },
      {
        table: 'tasks',
        method: 'upsert',
        args: ['task-2', { completed: 0 }, undefined],
      },
    ]);
    expect(fake.syncCount).toBe(0);
  });

  it('supports the table-scoped useMutation helper', async () => {
    const fake = new FakeManagedClient();
    const { SyncProvider, useMutation } = createSyncularReact<TestDb>();
    const wrapper = createWrapper(SyncProvider, fake.client);

    const { result } = renderHook(
      () => useMutation({ table: 'tasks', syncImmediately: false }),
      { wrapper }
    );

    await act(async () => {
      await result.current.mutate.update('task-2', {
        completed: 1,
      });
      await result.current.mutate.delete('task-2');
    });

    expect(fake.mutationCalls).toEqual([
      {
        table: 'tasks',
        method: 'update',
        args: ['task-2', { completed: 1 }, undefined],
      },
      { table: 'tasks', method: 'delete', args: ['task-2', undefined] },
    ]);
    expect(fake.syncCount).toBe(0);
  });

  it('joins presence with the old ergonomic presence syntax', async () => {
    const fake = new FakeManagedClient();
    const { SyncProvider, usePresenceWithJoin } = createSyncularReact<TestDb>();
    const wrapper = createWrapper(SyncProvider, fake.client);

    const { result, unmount } = renderHook(
      () =>
        usePresenceWithJoin('document:one', {
          metadata: { cursor: 1 },
        }),
      { wrapper }
    );

    await waitFor(() => {
      expect(result.current.presence).toHaveLength(1);
    });
    expect(result.current.presence[0]?.metadata).toEqual({ cursor: 1 });
    expect(result.current.isJoined).toBe(true);

    act(() => result.current.updateMetadata({ cursor: 2 }));
    expect(result.current.presence[0]?.metadata).toEqual({ cursor: 2 });

    unmount();
    expect(fake.leftScopes).toEqual(['document:one']);
  });

  it('keeps operational stats hooks for status UI', () => {
    const fake = new FakeManagedClient();
    const { SyncProvider, useConflictStats, useOutboxStats } =
      createSyncularReact<TestDb>();
    const wrapper = createWrapper(SyncProvider, fake.client);

    const { result } = renderHook(
      () => ({
        outbox: useOutboxStats(),
        conflicts: useConflictStats(),
      }),
      { wrapper }
    );

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

  it('exposes full Syncular status through useSyncStatus', () => {
    const fake = new FakeManagedClient();
    const { SyncProvider, useSyncStatus } = createSyncularReact<TestDb>();
    const wrapper = createWrapper(SyncProvider, fake.client);

    const { result } = renderHook(() => useSyncStatus(), { wrapper });

    expect(result.current.lifecycle.phase).toBe('complete');
    expect(result.current.isSyncing).toBe(false);

    act(() => {
      fake.setStatus({
        lifecycle: {
          phase: 'syncing',
          realtime: 'connected',
          online: true,
          requiresAction: false,
          pendingRequests: 1,
        },
        isSyncing: true,
      });
    });

    expect(result.current.lifecycle.phase).toBe('syncing');
    expect(result.current.isSyncing).toBe(true);
  });
});

interface TestDb {
  tasks: TaskRow;
}

interface TaskRow extends Record<string, unknown> {
  id: string;
  title: string;
  completed?: number;
}

function createWrapper<DB>(
  Provider: (props: {
    client: SyncularClientLike<DB>;
    children?: ReactNode;
  }) => ReturnType<typeof createElement>,
  client: SyncularClientLike<DB>
) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return createElement(Provider, { client, children });
  };
}

class FakeManagedClient {
  readonly leftScopes: string[] = [];
  readonly mutationCalls: Array<{
    table: string;
    method: string;
    args: unknown[];
  }> = [];
  readonly leasedMutationCalls: Array<{
    table: string;
    method: string;
    args: unknown[];
  }> = [];
  nextQueryRows: TaskRow[] = [];
  syncCount = 0;
  readonly #eventListeners = new Map<
    SyncularClientEventType,
    Set<SyncularClientEventSink<SyncularClientEventType>>
  >();
  readonly #presenceListeners = new Set<SyncularPresenceSink>();
  readonly #presence = new Map<string, SyncularPresenceEntry[]>();
  readonly #diagnosticListeners = new Set<SyncularDiagnosticSink>();
  readonly #liveListeners = new Map<string, (rows: TaskRow[]) => void>();
  readonly liveCalls: Array<{ tables?: readonly string[] }> = [];
  status: SyncularClientStatus = {
    lifecycle: {
      phase: 'complete',
      realtime: 'connected',
      online: true,
      requiresAction: false,
      pendingRequests: 0,
    },
    connection: this.connectionState(),
    outbox: null,
    conflicts: null,
    isConnected: true,
    isSyncing: false,
    hasPendingMutations: false,
    hasConflicts: false,
    requiresAction: false,
  };
  #liveIndex = 1;

  readonly client = {
    db: {
      selectFrom: (_table: string) => ({
        select: (_columns: readonly string[]) => ({
          execute: async () => this.nextQueryRows,
        }),
      }),
    },
    dialect: {},
    mutations: this.createMutations(this.mutationCalls),
    leasedMutations: this.createMutations(this.leasedMutationCalls),
    on: <T extends SyncularClientEventType>(
      event: T,
      listener: SyncularClientEventSink<T>
    ) => this.addEventListener(event, listener),
    getStatus: () => this.status,
    setSubscriptions: async () => undefined,
    presence: {
      get: <TMetadata extends Record<string, unknown>>(scopeKey: string) =>
        this.getPresence<TMetadata>(scopeKey),
      join: (scopeKey: string, metadata?: Record<string, unknown>) =>
        this.joinPresence(scopeKey, metadata),
      leave: (scopeKey: string) => this.leavePresence(scopeKey),
      updateMetadata: (scopeKey: string, metadata: Record<string, unknown>) =>
        this.updatePresenceMetadata(scopeKey, metadata),
      onChange: <TMetadata extends Record<string, unknown>>(
        listener: SyncularPresenceSink<TMetadata>
      ) => {
        this.#presenceListeners.add(listener as SyncularPresenceSink);
        return () =>
          this.#presenceListeners.delete(listener as SyncularPresenceSink);
      },
    },
    conflicts: {
      list: async () => [],
      retryKeepLocal: async () => 'retry-commit',
      resolve: async () => undefined,
    },
    blobs: {
      getUploadQueueStats: async () => this.blobStats(),
      processUploadQueue: async () => ({ uploaded: 0, failed: 0 }),
      retrieve: async () => new Uint8Array(),
    },
    client: {
      addDiagnosticListener: (listener: SyncularDiagnosticSink) => {
        this.#diagnosticListeners.add(listener);
        return () => this.#diagnosticListeners.delete(listener);
      },
      connectionState: () => this.connectionState(),
      addEventListener: <T extends SyncularClientEventType>(
        event: T,
        listener: SyncularClientEventSink<T>
      ) => this.addEventListener(event, listener),
      getPresence: <TMetadata extends Record<string, unknown>>(
        scopeKey: string
      ) => this.getPresence<TMetadata>(scopeKey),
      joinPresence: (scopeKey: string, metadata?: Record<string, unknown>) =>
        this.joinPresence(scopeKey, metadata),
      leavePresence: (scopeKey: string) => this.leavePresence(scopeKey),
      updatePresenceMetadata: (
        scopeKey: string,
        metadata: Record<string, unknown>
      ) => this.updatePresenceMetadata(scopeKey, metadata),
      addPresenceListener: <TMetadata extends Record<string, unknown>>(
        listener: SyncularPresenceSink<TMetadata>
      ) => {
        this.#presenceListeners.add(listener as SyncularPresenceSink);
        return () =>
          this.#presenceListeners.delete(listener as SyncularPresenceSink);
      },
    },
    live: async (
      _query: { compile(): CompiledQuery },
      options: {
        tables?: readonly string[];
        onChange: (rows: TaskRow[]) => void;
      }
    ) => {
      const id = `live-${this.#liveIndex++}`;
      this.liveCalls.push({ tables: options.tables });
      this.#liveListeners.set(id, options.onChange);
      options.onChange(this.nextQueryRows);
      return {
        id,
        unsubscribe: () => {
          this.#liveListeners.delete(id);
        },
      };
    },
    close: async () => undefined,
    start: async () => undefined,
    stop: async () => undefined,
    destroy: async () => undefined,
    sync: async () => {
      this.syncCount += 1;
      return {
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
    },
  } as unknown as SyncularClientLike<TestDb>;

  emitRowsChanged(event: SyncularRowsChangedEvent): void {
    this.emit('rowsChanged', event);
  }

  emitLiveQuery(id: string, rows: TaskRow[]): void {
    this.#liveListeners.get(id)?.(rows);
  }

  private createMutations(
    calls: Array<{
      table: string;
      method: string;
      args: unknown[];
    }>
  ) {
    const tableFor = (table: string) => ({
      insert: async (values: unknown) => {
        calls.push({ table, method: 'insert', args: [values] });
        return {
          commitId: 'commit-insert',
          clientCommitId: 'client-insert',
          id: 'generated-id',
        };
      },
      insertMany: async (rows: unknown[]) => {
        calls.push({ table, method: 'insertMany', args: [rows] });
        return {
          commitId: 'commit-insert-many',
          clientCommitId: 'client-insert-many',
          ids: rows.map((_row, index) => `generated-${index}`),
        };
      },
      update: async (id: string, patch: unknown, options?: unknown) => {
        calls.push({
          table,
          method: 'update',
          args: [id, patch, options],
        });
        return { commitId: 'commit-update', clientCommitId: 'client-update' };
      },
      delete: async (id: string, options?: unknown) => {
        calls.push({
          table,
          method: 'delete',
          args: [id, options],
        });
        return { commitId: 'commit-delete', clientCommitId: 'client-delete' };
      },
      upsert: async (id: string, patch: unknown, options?: unknown) => {
        calls.push({
          table,
          method: 'upsert',
          args: [id, patch, options],
        });
        return { commitId: 'commit-upsert', clientCommitId: 'client-upsert' };
      },
    });
    return new Proxy(
      {
        $table: tableFor,
        $commit: async (fn: (tx: Record<string, unknown>) => unknown) => {
          const result = await fn(
            new Proxy(
              {},
              {
                get: (_target, prop) =>
                  typeof prop === 'string' ? tableFor(prop) : undefined,
              }
            )
          );
          return {
            result,
            commit: {
              commitId: 'commit-batch',
              clientCommitId: 'client-batch',
            },
          };
        },
      },
      {
        get(target, prop) {
          if (prop === 'then') return undefined;
          if (typeof prop === 'string' && prop in target) {
            return target[prop as keyof typeof target];
          }
          return typeof prop === 'string' ? tableFor(prop) : undefined;
        },
      }
    );
  }

  private addEventListener<T extends SyncularClientEventType>(
    event: T,
    listener: SyncularClientEventSink<T>
  ): () => void {
    let listeners = this.#eventListeners.get(event);
    if (!listeners) {
      listeners = new Set();
      this.#eventListeners.set(event, listeners);
    }
    listeners.add(listener as SyncularClientEventSink<SyncularClientEventType>);
    return () =>
      listeners.delete(
        listener as SyncularClientEventSink<SyncularClientEventType>
      );
  }

  emit<T extends SyncularClientEventType>(
    event: T,
    payload: SyncularClientEventMap[T]
  ): void {
    for (const listener of this.#eventListeners.get(event) ?? []) {
      listener(payload as never);
    }
  }

  setStatus(next: Partial<SyncularClientStatus>): void {
    this.status = {
      ...this.status,
      ...next,
      lifecycle: {
        ...this.status.lifecycle,
        ...next.lifecycle,
      },
      connection: {
        ...this.status.connection,
        ...next.connection,
      },
    };
    this.emit('lifecycleChanged', this.status.lifecycle);
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
  ): SyncularPresenceEntry<TMetadata>[] {
    return (this.#presence.get(scopeKey) ??
      []) as SyncularPresenceEntry<TMetadata>[];
  }

  private emitPresence(scopeKey: string): void {
    const event: SyncularPresenceChangeEvent = {
      scopeKey,
      presence: this.getPresence(scopeKey),
    };
    for (const listener of this.#presenceListeners) listener(event);
  }

  private connectionState(): SyncularConnectionState {
    return {
      closed: false,
      pendingRequests: 0,
      realtime: 'connected',
    };
  }

  private blobStats(): SyncularBlobUploadQueueStats {
    return {
      pending: 0,
      uploading: 0,
      failed: 0,
    };
  }
}

function zeroBootstrapStatus(): SyncularBootstrapStatus {
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
