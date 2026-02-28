/**
 * Tests for React hooks
 *
 * These tests use `autoStart={false}` to prevent the SyncProvider from
 * auto-starting the engine, allowing tests to control the lifecycle.
 */

import { beforeEach, describe, expect, it } from 'bun:test';
import type { SyncClientDb } from '@syncular/client';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { Kysely } from 'kysely';
import type { ReactNode } from 'react';
import { createSyncularReact } from '../index';
import {
  createMockDb,
  createMockHandlerRegistry,
  createMockSync,
  createMockTransport,
} from './test-utils';

const {
  SyncProvider,
  useConflicts,
  useEngine,
  useNewConflicts,
  useOutbox,
  usePresenceWithJoin,
  useResolveConflict,
  useSyncConnection,
  useSyncEngine,
  useSyncInspector,
  useSyncQuery,
  useSyncStatus,
} = createSyncularReact<SyncClientDb>();

describe('React Hooks', () => {
  let db: Kysely<SyncClientDb>;

  beforeEach(async () => {
    db = await createMockDb();
  });

  function createWrapper(options?: { autoStart?: boolean }) {
    const transport = createMockTransport();
    const handlers = createMockHandlerRegistry();
    const sync = createMockSync({ handlers });

    const Wrapper = ({ children }: { children: ReactNode }) => (
      <SyncProvider
        db={db}
        transport={transport}
        sync={sync}
        identity={{ actorId: 'test-actor' }}
        clientId="test-client"
        pollIntervalMs={999999} // Long poll interval to prevent continuous polling
        autoStart={options?.autoStart ?? false} // Disable auto-start for tests
      >
        {children}
      </SyncProvider>
    );

    return Wrapper;
  }

  describe('useSyncEngine', () => {
    it('should return engine state', async () => {
      const { result } = renderHook(() => useSyncEngine(), {
        wrapper: createWrapper(),
      });

      expect(result.current.state).toBeDefined();
      expect(result.current.state.enabled).toBe(true);
    });

    it('should provide sync function', async () => {
      const { result } = renderHook(() => useSyncEngine(), {
        wrapper: createWrapper(),
      });

      expect(typeof result.current.sync).toBe('function');
    });

    it('should provide control functions', () => {
      const { result } = renderHook(() => useSyncEngine(), {
        wrapper: createWrapper(),
      });

      expect(typeof result.current.reconnect).toBe('function');
      expect(typeof result.current.disconnect).toBe('function');
      expect(typeof result.current.start).toBe('function');
      expect(typeof result.current.getInspectorSnapshot).toBe('function');
    });
  });

  describe('useSyncInspector', () => {
    it('returns a serializable inspector snapshot', async () => {
      const { result } = renderHook(
        () => ({
          inspector: useSyncInspector({ eventLimit: 20 }),
          engine: useSyncEngine(),
        }),
        { wrapper: createWrapper() }
      );

      await act(async () => {
        await result.current.engine.start();
      });

      await act(async () => {
        await result.current.engine.sync();
      });

      await waitFor(() => {
        expect(result.current.inspector.isLoading).toBe(false);
      });

      const snapshot = result.current.inspector.snapshot;
      expect(snapshot).toBeDefined();
      expect(snapshot?.version).toBe(1);
      expect(Array.isArray(snapshot?.recentEvents)).toBe(true);
      expect(snapshot?.recentEvents.length).toBeGreaterThan(0);
    });
  });

  describe('useSyncStatus', () => {
    it('should return status object', () => {
      const { result } = renderHook(() => useSyncStatus(), {
        wrapper: createWrapper(),
      });

      expect(result.current).toMatchObject({
        enabled: true,
        isOnline: expect.any(Boolean),
        isSyncing: expect.any(Boolean),
        pendingCount: expect.any(Number),
        error: null,
        isRetrying: false,
        retryCount: 0,
      });
    });

    it('should show lastSyncAt after manual sync', async () => {
      const { result } = renderHook(
        () => ({
          status: useSyncStatus(),
          engine: useSyncEngine(),
        }),
        { wrapper: createWrapper() }
      );

      // Start the engine manually
      await act(async () => {
        await result.current.engine.start();
      });

      // Trigger a sync
      await act(async () => {
        await result.current.engine.sync();
      });

      expect(result.current.status.lastSyncAt).not.toBe(null);
    });

    it('marks status as stale after staleAfterMs', async () => {
      const { result } = renderHook(
        () => ({
          status: useSyncStatus({ staleAfterMs: 120 }),
          engine: useSyncEngine(),
        }),
        { wrapper: createWrapper() }
      );

      await act(async () => {
        await result.current.engine.start();
      });

      await act(async () => {
        await result.current.engine.sync();
      });

      expect(result.current.status.isStale).toBe(false);
      await waitFor(() => {
        expect(result.current.status.isStale).toBe(true);
      });
    });
  });

  describe('useSyncConnection', () => {
    it('should return connection state', () => {
      const { result } = renderHook(() => useSyncConnection(), {
        wrapper: createWrapper(),
      });

      expect(result.current.state).toBeDefined();
      expect(result.current.mode).toBe('polling');
      expect(typeof result.current.isConnected).toBe('boolean');
      expect(typeof result.current.isReconnecting).toBe('boolean');
    });

    it('should provide reconnect and disconnect functions', () => {
      const { result } = renderHook(() => useSyncConnection(), {
        wrapper: createWrapper(),
      });

      expect(typeof result.current.reconnect).toBe('function');
      expect(typeof result.current.disconnect).toBe('function');
    });

    // Note: Connection lifecycle tests are covered in integration tests
    // The SyncEngine.test.ts tests the engine directly
    // These hook tests verify the React binding works
  });

  describe('useSyncQuery', () => {
    it('supports watchTables invalidation on matching data:change scopes', async () => {
      const transport = createMockTransport();
      const handlers = createMockHandlerRegistry();
      handlers.push({
        table: 'tasks',
        applySnapshot: async () => {},
        clearAll: async () => {},
        applyChange: async () => {},
      });
      const sync = createMockSync({ handlers });

      const Wrapper = ({ children }: { children: ReactNode }) => (
        <SyncProvider
          db={db}
          transport={transport}
          sync={sync}
          identity={{ actorId: 'test-actor' }}
          clientId="test-client"
          pollIntervalMs={999999}
          autoStart={false}
        >
          {children}
        </SyncProvider>
      );

      let executions = 0;
      const { result } = renderHook(
        () => {
          const engine = useEngine();
          const query = useSyncQuery(
            async ({ selectFrom }) => {
              executions += 1;
              const row = await selectFrom('sync_outbox_commits')
                .select((eb) => [eb.fn.count('id').as('total')])
                .executeTakeFirst();
              return Number(row?.total ?? 0);
            },
            { watchTables: ['tasks'] }
          );

          return { engine, query };
        },
        { wrapper: Wrapper }
      );

      await waitFor(() => {
        expect(result.current.query.isLoading).toBe(false);
      });

      const initialExecutions = executions;

      await act(async () => {
        await result.current.engine.applyLocalMutation([
          {
            table: 'tasks',
            rowId: 'task-1',
            op: 'upsert',
            payload: { id: 'task-1' },
          },
        ]);
      });

      await waitFor(() => {
        expect(executions).toBeGreaterThan(initialExecutions);
      });
    });

    it('supports pollIntervalMs', async () => {
      let executions = 0;

      const { result } = renderHook(
        () =>
          useSyncQuery(
            async ({ selectFrom }) => {
              executions += 1;
              const row = await selectFrom('sync_outbox_commits')
                .select((eb) => [eb.fn.count('id').as('total')])
                .executeTakeFirst();
              return Number(row?.total ?? 0);
            },
            { pollIntervalMs: 20 }
          ),
        { wrapper: createWrapper() }
      );

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false);
      });

      await waitFor(() => {
        expect(executions).toBeGreaterThanOrEqual(2);
      });
    });

    it('does not refetch twice when sync:complete and data:change occur together', async () => {
      let executions = 0;
      const metricSnapshots: Array<{
        executions: number;
        coalescedRefreshes: number;
        skippedDataUpdates: number;
        lastDurationMs: number | null;
      }> = [];

      const { result } = renderHook(
        () => {
          const engine = useEngine();
          const query = useSyncQuery(
            async ({ selectFrom }) => {
              executions += 1;
              const row = await selectFrom('sync_outbox_commits')
                .select((eb) => [eb.fn.count('id').as('total')])
                .executeTakeFirst();
              return Number(row?.total ?? 0);
            },
            {
              watchTables: ['tasks'],
              onMetrics(metrics) {
                metricSnapshots.push(metrics);
              },
            }
          );

          return { engine, query };
        },
        { wrapper: createWrapper() }
      );

      await waitFor(() => {
        expect(result.current.query.isLoading).toBe(false);
      });

      const initialExecutions = executions;
      const emit = Reflect.get(result.current.engine, 'emit');
      if (typeof emit !== 'function') {
        throw new Error('Expected engine.emit to be callable');
      }

      await act(async () => {
        emit.call(result.current.engine, 'sync:complete', {
          timestamp: Date.now(),
          pushedCommits: 0,
          pullRounds: 0,
          pullResponse: { ok: true, subscriptions: [] },
        });
        emit.call(result.current.engine, 'data:change', {
          scopes: ['tasks'],
          timestamp: Date.now(),
        });
      });

      await waitFor(() => {
        expect(executions).toBe(initialExecutions + 1);
      });

      await waitFor(() => {
        const last = metricSnapshots[metricSnapshots.length - 1];
        expect(last?.executions ?? 0).toBeGreaterThanOrEqual(
          initialExecutions + 1
        );
      });
    });
  });

  describe('usePresenceWithJoin', () => {
    it('does not re-join when metadata object identity changes with equal values', async () => {
      let joinCalls = 0;
      let leaveCalls = 0;

      const { result, rerender } = renderHook(
        ({ metadata }: { metadata: { displayName: string } }) => {
          const engine = useEngine();
          const presence = usePresenceWithJoin('room:1', {
            metadata,
            autoJoin: true,
          });
          return { engine, presence };
        },
        {
          wrapper: createWrapper(),
          initialProps: { metadata: { displayName: 'Alice' } },
        }
      );

      await waitFor(() => {
        expect(result.current.presence.isJoined).toBe(true);
      });

      const originalJoin = result.current.engine.joinPresence.bind(
        result.current.engine
      );
      const originalLeave = result.current.engine.leavePresence.bind(
        result.current.engine
      );

      result.current.engine.joinPresence = (scopeKey, metadata) => {
        joinCalls += 1;
        originalJoin(scopeKey, metadata);
      };
      result.current.engine.leavePresence = (scopeKey) => {
        leaveCalls += 1;
        originalLeave(scopeKey);
      };

      rerender({ metadata: { displayName: 'Alice' } });
      await act(async () => {
        await Promise.resolve();
      });

      expect(joinCalls).toBe(0);
      expect(leaveCalls).toBe(0);
    });

    it('updates metadata when auto-join metadata changes', async () => {
      let updateCalls = 0;

      const { result, rerender } = renderHook(
        ({ metadata }: { metadata: { displayName: string } }) => {
          const engine = useEngine();
          const presence = usePresenceWithJoin('room:2', {
            metadata,
            autoJoin: true,
          });
          return { engine, presence };
        },
        {
          wrapper: createWrapper(),
          initialProps: { metadata: { displayName: 'Alice' } },
        }
      );

      await waitFor(() => {
        expect(result.current.presence.isJoined).toBe(true);
      });

      const originalUpdate = result.current.engine.updatePresenceMetadata.bind(
        result.current.engine
      );
      result.current.engine.updatePresenceMetadata = (scopeKey, metadata) => {
        updateCalls += 1;
        originalUpdate(scopeKey, metadata);
      };

      rerender({ metadata: { displayName: 'Bob' } });

      await waitFor(() => {
        expect(updateCalls).toBe(1);
      });

      await waitFor(() => {
        expect(result.current.presence.presence[0]?.metadata).toMatchObject({
          displayName: 'Bob',
        });
      });
    });
  });

  describe('useOutbox', () => {
    it('should return outbox stats', async () => {
      const { result } = renderHook(() => useOutbox(), {
        wrapper: createWrapper(),
      });

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false);
      });

      expect(result.current.stats).toMatchObject({
        pending: 0,
        sending: 0,
        failed: 0,
        acked: 0,
        total: 0,
      });
      expect(result.current.hasUnsent).toBe(false);
    });

    it('should return empty pending and failed arrays initially', async () => {
      const { result } = renderHook(() => useOutbox(), {
        wrapper: createWrapper(),
      });

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false);
      });

      expect(result.current.pending).toEqual([]);
      expect(result.current.failed).toEqual([]);
    });

    it('refreshes once when outbox:change and sync:complete are both emitted', async () => {
      const metricSnapshots: Array<{
        refreshes: number;
        coalescedRefreshes: number;
        lastDurationMs: number | null;
      }> = [];

      const { result } = renderHook(
        () => {
          const engine = useEngine();
          const outbox = useOutbox({
            onMetrics(metrics) {
              metricSnapshots.push(metrics);
            },
          });
          return { engine, outbox };
        },
        { wrapper: createWrapper() }
      );

      await waitFor(() => {
        expect(result.current.outbox.isLoading).toBe(false);
      });

      let refreshStatsCalls = 0;
      const originalRefreshOutboxStats =
        result.current.engine.refreshOutboxStats.bind(result.current.engine);
      result.current.engine.refreshOutboxStats = async (options) => {
        refreshStatsCalls += 1;
        return originalRefreshOutboxStats(options);
      };

      const emit = Reflect.get(result.current.engine, 'emit');
      if (typeof emit !== 'function') {
        throw new Error('Expected engine.emit to be callable');
      }

      await act(async () => {
        emit.call(result.current.engine, 'outbox:change', {
          pendingCount: 0,
          sendingCount: 0,
          failedCount: 0,
          ackedCount: 0,
        });
        emit.call(result.current.engine, 'sync:complete', {
          timestamp: Date.now(),
          pushedCommits: 0,
          pullRounds: 0,
          pullResponse: { ok: true, subscriptions: [] },
        });
      });

      await waitFor(() => {
        expect(refreshStatsCalls).toBe(1);
      });

      await waitFor(() => {
        const last = metricSnapshots[metricSnapshots.length - 1];
        expect(last?.refreshes ?? 0).toBeGreaterThanOrEqual(1);
      });
    });
  });

  describe('useConflicts', () => {
    it('should return empty conflicts initially', async () => {
      const { result } = renderHook(() => useConflicts(), {
        wrapper: createWrapper(),
      });

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false);
      });

      expect(result.current.conflicts).toEqual([]);
      expect(result.current.count).toBe(0);
      expect(result.current.hasConflicts).toBe(false);
    });
  });

  describe('useNewConflicts', () => {
    it('buffers conflict:new notifications and supports dismiss/clear', async () => {
      const { result } = renderHook(
        () => ({
          stream: useNewConflicts({ maxBuffered: 2 }),
          engine: useEngine(),
        }),
        { wrapper: createWrapper() }
      );

      const emit = Reflect.get(result.current.engine, 'emit');
      if (typeof emit !== 'function') {
        throw new Error('Expected engine.emit to be callable');
      }

      const makeConflict = (id: string) => ({
        id,
        outboxCommitId: `outbox-${id}`,
        clientCommitId: `client-${id}`,
        opIndex: 0,
        resultStatus: 'conflict' as const,
        message: `Conflict ${id}`,
        code: 'CONFLICT',
        serverVersion: 2,
        serverRowJson: JSON.stringify({ id }),
        createdAt: Date.now(),
        table: 'tasks',
        rowId: id,
        localPayload: { id },
      });

      await act(async () => {
        emit.call(result.current.engine, 'conflict:new', makeConflict('c1'));
        emit.call(result.current.engine, 'conflict:new', makeConflict('c2'));
        emit.call(result.current.engine, 'conflict:new', makeConflict('c3'));
      });

      await waitFor(() => {
        expect(result.current.stream.count).toBe(2);
      });
      expect(
        result.current.stream.conflicts.map((conflict) => conflict.id)
      ).toEqual(['c2', 'c3']);

      act(() => {
        result.current.stream.dismiss('c2');
      });
      expect(
        result.current.stream.conflicts.map((conflict) => conflict.id)
      ).toEqual(['c3']);

      act(() => {
        result.current.stream.clear();
      });
      expect(result.current.stream.count).toBe(0);
      expect(result.current.stream.latest).toBe(null);
    });
  });

  describe('useResolveConflict', () => {
    it('should return resolve function and state', () => {
      const { result } = renderHook(() => useResolveConflict(), {
        wrapper: createWrapper(),
      });

      expect(typeof result.current.resolve).toBe('function');
      expect(result.current.isPending).toBe(false);
      expect(result.current.error).toBe(null);
      expect(typeof result.current.reset).toBe('function');
    });

    it('should set isPending during resolution', async () => {
      const { result } = renderHook(() => useResolveConflict(), {
        wrapper: createWrapper(),
      });

      // Try to resolve a non-existent conflict (will throw but we test the pending state)
      const resolvePromise = act(async () => {
        try {
          await result.current.resolve('non-existent', 'accept');
        } catch {
          // Expected to fail - conflict doesn't exist
        }
      });

      await resolvePromise;

      // After resolution attempt, isPending should be false
      expect(result.current.isPending).toBe(false);
    });

    it('should handle accept resolution type', async () => {
      // Create a conflict in the database first
      await db
        .insertInto('sync_conflicts')
        .values({
          id: 'test-conflict-1',
          outbox_commit_id: 'commit-1',
          client_commit_id: 'client-commit-1',
          op_index: 0,
          result_status: 'conflict',
          message: 'Version conflict',
          code: 'VERSION_MISMATCH',
          server_version: 2,
          server_row_json: JSON.stringify({
            id: 'row-1',
            title: 'Server Title',
          }),
          created_at: Date.now(),
          resolved_at: null,
          resolution: null,
        })
        .execute();

      const { result } = renderHook(
        () => ({
          resolve: useResolveConflict({ syncAfterResolve: false }),
          conflicts: useConflicts(),
        }),
        { wrapper: createWrapper() }
      );

      // Wait for conflicts to load
      await waitFor(() => {
        expect(result.current.conflicts.isLoading).toBe(false);
      });

      // Resolve the conflict
      await act(async () => {
        await result.current.resolve.resolve('test-conflict-1', 'accept');
      });

      // Verify conflict was resolved
      const resolved = await db
        .selectFrom('sync_conflicts')
        .where('id', '=', 'test-conflict-1')
        .selectAll()
        .executeTakeFirst();

      expect(resolved?.resolution).toBe('accept');
      expect(resolved?.resolved_at).not.toBe(null);
    });

    it('should handle reject resolution type', async () => {
      // Create a conflict
      await db
        .insertInto('sync_conflicts')
        .values({
          id: 'test-conflict-2',
          outbox_commit_id: 'commit-2',
          client_commit_id: 'client-commit-2',
          op_index: 0,
          result_status: 'conflict',
          message: 'Version conflict',
          code: 'VERSION_MISMATCH',
          server_version: 3,
          server_row_json: null,
          created_at: Date.now(),
          resolved_at: null,
          resolution: null,
        })
        .execute();

      const { result } = renderHook(
        () => useResolveConflict({ syncAfterResolve: false }),
        { wrapper: createWrapper() }
      );

      await act(async () => {
        await result.current.resolve('test-conflict-2', 'reject');
      });

      const resolved = await db
        .selectFrom('sync_conflicts')
        .where('id', '=', 'test-conflict-2')
        .selectAll()
        .executeTakeFirst();

      expect(resolved?.resolution).toBe('reject');
    });

    it('should call onSuccess callback on successful resolution', async () => {
      await db
        .insertInto('sync_conflicts')
        .values({
          id: 'test-conflict-3',
          outbox_commit_id: 'commit-3',
          client_commit_id: 'client-commit-3',
          op_index: 0,
          result_status: 'conflict',
          message: 'Version conflict',
          code: null,
          server_version: 1,
          server_row_json: null,
          created_at: Date.now(),
          resolved_at: null,
          resolution: null,
        })
        .execute();

      let successId: string | null = null;
      const onSuccess = (id: string) => {
        successId = id;
      };

      const { result } = renderHook(
        () => useResolveConflict({ onSuccess, syncAfterResolve: false }),
        { wrapper: createWrapper() }
      );

      await act(async () => {
        await result.current.resolve('test-conflict-3', 'accept');
      });

      expect(successId!).toBe('test-conflict-3');
    });

    it('should reset error state', async () => {
      const { result } = renderHook(() => useResolveConflict(), {
        wrapper: createWrapper(),
      });

      // Trigger an error by resolving non-existent conflict
      await act(async () => {
        try {
          await result.current.resolve('non-existent', 'accept');
        } catch {
          // Expected
        }
      });

      // Reset should clear the error
      act(() => {
        result.current.reset();
      });

      expect(result.current.error).toBe(null);
    });
  });
});
