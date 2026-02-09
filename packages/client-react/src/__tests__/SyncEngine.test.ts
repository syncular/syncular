/**
 * Tests for SyncEngine
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import {
  ClientTableRegistry,
  enqueueOutboxCommit,
  type SyncClientDb,
  SyncEngine,
  type SyncEngineConfig,
} from '@syncular/client';
import type { Kysely } from 'kysely';
import {
  createMockDb,
  createMockShapeRegistry,
  createMockTransport,
  flushPromises,
  waitFor,
} from './test-utils';

describe('SyncEngine', () => {
  let db: Kysely<SyncClientDb>;
  let engine: SyncEngine;

  beforeEach(async () => {
    db = await createMockDb();
  });

  afterEach(() => {
    engine?.destroy();
  });

  function createEngine(overrides: Partial<SyncEngineConfig> = {}): SyncEngine {
    const config: SyncEngineConfig = {
      db,
      transport: createMockTransport(),
      shapes: createMockShapeRegistry(),
      actorId: 'test-actor',
      clientId: 'test-client',
      subscriptions: [],
      ...overrides,
    };
    engine = new SyncEngine(config);
    return engine;
  }

  describe('initialization', () => {
    it('should create engine with initial state', () => {
      const engine = createEngine();
      const state = engine.getState();

      expect(state.enabled).toBe(true);
      expect(state.isSyncing).toBe(false);
      expect(state.connectionState).toBe('disconnected');
      expect(state.lastSyncAt).toBe(null);
      expect(state.error).toBe(null);
    });

    it('should be disabled when actorId is null', () => {
      const engine = createEngine({ actorId: null });
      const state = engine.getState();

      expect(state.enabled).toBe(false);
    });

    it('should be disabled when clientId is null', () => {
      const engine = createEngine({ clientId: null });
      const state = engine.getState();

      expect(state.enabled).toBe(false);
    });

    it('should detect polling mode when realtimeEnabled is false', () => {
      const engine = createEngine({ realtimeEnabled: false });
      const state = engine.getState();

      expect(state.transportMode).toBe('polling');
    });
  });

  describe('start/stop lifecycle', () => {
    it('should start and set connection state', async () => {
      const engine = createEngine();
      await engine.start();

      const state = engine.getState();
      expect(state.connectionState).toBe('connected');
    });

    it('should reconnect in polling mode after disconnect', async () => {
      const engine = createEngine({ realtimeEnabled: false });
      await engine.start();

      engine.disconnect();
      expect(engine.getState().connectionState).toBe('disconnected');

      engine.reconnect();
      await waitFor(
        () => engine.getState().connectionState === 'connected',
        500
      );
    });

    it('should reconnect in realtime mode after disconnect', async () => {
      type ConnState = 'disconnected' | 'connecting' | 'connected';

      let connectCount = 0;
      let reconnectCount = 0;
      let currentState: ConnState = 'disconnected';
      let currentStateCallback: ((state: ConnState) => void) | null = null;

      const base = createMockTransport();
      const sseTransport = {
        ...base,
        connect(
          _args: { clientId: string },
          _onEvent: (_event: unknown) => void,
          onStateChange?: (state: ConnState) => void
        ) {
          connectCount += 1;
          currentStateCallback = onStateChange ?? null;
          currentState = 'connecting';
          currentStateCallback?.('connecting');
          queueMicrotask(() => {
            currentState = 'connected';
            currentStateCallback?.('connected');
          });
          return () => {
            currentState = 'disconnected';
            currentStateCallback?.('disconnected');
          };
        },
        getConnectionState(): ConnState {
          return currentState;
        },
        reconnect() {
          reconnectCount += 1;
          currentState = 'connecting';
          currentStateCallback?.('connecting');
          queueMicrotask(() => {
            currentState = 'connected';
            currentStateCallback?.('connected');
          });
        },
      };

      const engine = createEngine({
        transport: sseTransport,
        realtimeEnabled: true,
      });
      await engine.start();
      await waitFor(
        () => engine.getState().connectionState === 'connected',
        500
      );

      // While connected, reconnect should call transport.reconnect().
      engine.reconnect();
      expect(reconnectCount).toBe(1);

      // After disconnect, reconnect should re-register callbacks via connect().
      engine.disconnect();
      expect(engine.getState().connectionState).toBe('disconnected');

      engine.reconnect();
      await waitFor(
        () => engine.getState().connectionState === 'connected',
        500
      );
      expect(connectCount).toBe(2);
    });

    it('should stop and disconnect', async () => {
      const engine = createEngine();
      await engine.start();
      engine.stop();

      const state = engine.getState();
      expect(state.connectionState).toBe('disconnected');
    });

    it('should throw when starting destroyed engine', async () => {
      const engine = createEngine();
      engine.destroy();

      await expect(engine.start()).rejects.toThrow('destroyed');
    });
  });

  describe('sync cycle', () => {
    it('should perform sync and update state', async () => {
      const engine = createEngine();
      await engine.start();

      const result = await engine.sync();

      expect(result.success).toBe(true);
      expect(engine.getState().lastSyncAt).not.toBe(null);
    });

    it('should emit sync:start event', async () => {
      const engine = createEngine();
      await engine.start();

      let eventReceived = false;
      engine.on('sync:start', () => {
        eventReceived = true;
      });

      await engine.sync();
      expect(eventReceived).toBe(true);
    });

    it('should emit sync:complete event', async () => {
      const engine = createEngine();
      await engine.start();

      let eventPayload: { timestamp: number } = { timestamp: 0 };
      engine.on('sync:complete', (payload) => {
        eventPayload = payload;
      });

      await engine.sync();

      expect(eventPayload.timestamp).toBeGreaterThan(0);
    });

    it('should emit sync:error on failure', async () => {
      const transport = createMockTransport();
      transport.pull = async () => {
        throw new Error('Network error');
      };

      const engine = createEngine({ transport });
      await engine.start();

      let errorPayload: { message: string } = { message: '' };
      engine.on('sync:error', (payload) => {
        errorPayload = payload;
      });

      const result = await engine.sync();

      expect(result.success).toBe(false);
      expect(errorPayload.message).toBe('Network error');
    });

    it('should dedupe concurrent sync calls', async () => {
      let pullCount = 0;
      const transport = createMockTransport({
        onPull: () => {
          pullCount++;
        },
      });

      const engine = createEngine({ transport });
      await engine.start();

      // Reset count after start's initial sync
      pullCount = 0;

      // Trigger multiple concurrent syncs
      const [r1, r2, r3] = await Promise.all([
        engine.sync(),
        engine.sync(),
        engine.sync(),
      ]);

      // All should resolve to the same result
      expect(r1.success).toBe(true);
      expect(r2.success).toBe(true);
      expect(r3.success).toBe(true);

      // Only one sync runs at a time, but we should schedule at most one extra
      // pass if sync() is requested while a sync is already in-flight.
      expect(pullCount).toBe(2);
    });

    it('should flush outbox commits enqueued during pull via queued sync', async () => {
      let enableInjection = false;
      let injected = false;
      const transport = createMockTransport({
        onPull: () => {},
      });

      // Delay pull so we can enqueue a new commit after push finished.
      transport.pull = async (_request) => {
        if (enableInjection && !injected) {
          injected = true;
          await enqueueOutboxCommit(db, {
            operations: [
              {
                table: 'tasks',
                row_id: 'late-commit',
                op: 'upsert',
                payload: { title: 'Late' },
                base_version: null,
              },
            ],
          });

          // Request another sync while this pull is in-flight.
          void engine.sync();
        }

        // Small delay so the second sync request is definitely concurrent.
        await new Promise((r) => setTimeout(r, 10));

        return { ok: true, subscriptions: [] };
      };

      const engine = createEngine({ transport });
      await engine.start();
      enableInjection = true;

      // Enqueue a commit that will be pushed in the first cycle.
      await enqueueOutboxCommit(db, {
        operations: [
          {
            table: 'tasks',
            row_id: 'first-commit',
            op: 'upsert',
            payload: { title: 'First' },
            base_version: null,
          },
        ],
      });

      await engine.sync();

      // Both commits should be acked (late commit is pushed by the queued follow-up sync).
      const remaining = await db
        .selectFrom('sync_outbox_commits')
        .select(['status'])
        .where('status', '!=', 'acked')
        .execute();

      expect(remaining.length).toBe(0);
    });
  });

  describe('event subscriptions', () => {
    it('should allow subscribing to events', async () => {
      const engine = createEngine();

      const events: string[] = [];
      engine.on('sync:start', () => events.push('start'));
      engine.on('sync:complete', () => events.push('complete'));

      await engine.start();
      await engine.sync();

      expect(events).toContain('start');
      expect(events).toContain('complete');
    });

    it('should allow unsubscribing from events', async () => {
      const engine = createEngine();

      let callCount = 0;
      const unsubscribe = engine.on('sync:complete', () => {
        callCount++;
      });

      await engine.start();
      unsubscribe();
      await engine.sync();

      // Only the initial sync from start() should have triggered
      expect(callCount).toBe(1);
    });

    it('should support subscribe() for all events', async () => {
      const engine = createEngine();

      let callCount = 0;
      engine.subscribe(() => {
        callCount++;
      });

      await engine.start();
      await engine.sync();

      // Multiple events should trigger the callback
      expect(callCount).toBeGreaterThan(1);
    });
  });

  describe('outbox stats', () => {
    it('should refresh outbox stats', async () => {
      const engine = createEngine();
      await engine.start();

      const stats = await engine.refreshOutboxStats();

      expect(stats).toEqual({
        pending: 0,
        sending: 0,
        failed: 0,
        acked: 0,
        total: 0,
      });
    });

    it('should emit outbox:change event', async () => {
      const engine = createEngine();
      await engine.start();

      let eventPayload: { pendingCount: number } = { pendingCount: -1 };
      engine.on('outbox:change', (payload) => {
        eventPayload = payload;
      });

      await engine.refreshOutboxStats();

      expect(eventPayload.pendingCount).toBe(0);
    });
  });

  describe('conflicts', () => {
    it('should return empty conflicts list initially', async () => {
      const engine = createEngine();
      await engine.start();

      const conflicts = await engine.getConflicts();

      expect(conflicts).toEqual([]);
    });
  });

  describe('subscriptions', () => {
    it('should update subscriptions and trigger sync', async () => {
      let pullCount = 0;
      const transport = createMockTransport({
        onPull: () => {
          pullCount++;
        },
      });

      const engine = createEngine({ transport });
      await engine.start();

      const initialPullCount = pullCount;

      engine.updateSubscriptions([
        { id: 'new-sub', shape: 'test', scopes: {} },
      ]);

      await flushPromises();
      await waitFor(() => pullCount > initialPullCount, 500);

      expect(pullCount).toBeGreaterThan(initialPullCount);
    });
  });

  describe('mutation timestamps', () => {
    interface TestDb extends SyncClientDb {
      tasks: { id: string; title: string };
      projects: { id: string; name: string };
    }

    let local: {
      engine: SyncEngine<TestDb>;
      db: Kysely<TestDb>;
    } | null = null;

    afterEach(() => {
      local?.engine.destroy();
      void local?.db.destroy();
      local = null;
    });

    async function createTestEngine(
      args: { includeProjects?: boolean } = {}
    ): Promise<SyncEngine<TestDb>> {
      const shapes = new ClientTableRegistry<TestDb>();
      shapes.register({
        table: 'tasks',
        applySnapshot: async () => {},
        clearAll: async () => {},
        applyChange: async () => {},
      });
      if (args.includeProjects) {
        shapes.register({
          table: 'projects',
          applySnapshot: async () => {},
          clearAll: async () => {},
          applyChange: async () => {},
        });
      }

      const testDb = await createMockDb<TestDb>();
      const config: SyncEngineConfig<TestDb> = {
        db: testDb,
        transport: createMockTransport(),
        shapes,
        actorId: 'test-actor',
        clientId: 'test-client',
        subscriptions: [],
      };
      const engine = new SyncEngine<TestDb>(config);
      await engine.start();

      local = { engine, db: testDb };
      return engine;
    }

    it('should return 0 for rows with no mutations', () => {
      const engine = createEngine();

      expect(engine.getMutationTimestamp('tasks', 'unknown-id')).toBe(0);
      expect(engine.getMutationTimestamp('other_table', 'any-id')).toBe(0);
    });

    it('should track mutation timestamps after applyLocalMutation', async () => {
      const engine = await createTestEngine();

      // Initially no timestamp
      expect(engine.getMutationTimestamp('tasks', 'task-1')).toBe(0);

      const beforeMutation = Date.now();

      // Apply a local mutation
      await engine.applyLocalMutation([
        {
          table: 'tasks',
          rowId: 'task-1',
          op: 'upsert',
          payload: { id: 'task-1', title: 'Test Task' },
        },
      ]);

      const afterMutation = Date.now();

      // Should now have a timestamp
      const timestamp = engine.getMutationTimestamp('tasks', 'task-1');
      expect(timestamp).toBeGreaterThanOrEqual(beforeMutation);
      expect(timestamp).toBeLessThanOrEqual(afterMutation);
    });

    it('should remove timestamp on delete mutation', async () => {
      const engine = await createTestEngine();

      // First create an entry
      await engine.applyLocalMutation([
        {
          table: 'tasks',
          rowId: 'task-1',
          op: 'upsert',
          payload: { id: 'task-1', title: 'Test Task' },
        },
      ]);

      // Should have a timestamp
      expect(engine.getMutationTimestamp('tasks', 'task-1')).toBeGreaterThan(0);

      // Now delete it
      await engine.applyLocalMutation([
        {
          table: 'tasks',
          rowId: 'task-1',
          op: 'delete',
        },
      ]);

      // Timestamp should be removed (back to 0)
      expect(engine.getMutationTimestamp('tasks', 'task-1')).toBe(0);
    });

    it('should track multiple rows independently', async () => {
      const engine = await createTestEngine();

      // Mutate task-1
      await engine.applyLocalMutation([
        {
          table: 'tasks',
          rowId: 'task-1',
          op: 'upsert',
          payload: { id: 'task-1' },
        },
      ]);

      const ts1 = engine.getMutationTimestamp('tasks', 'task-1');

      // Small delay to ensure different timestamp
      await new Promise((r) => setTimeout(r, 5));

      // Mutate task-2
      await engine.applyLocalMutation([
        {
          table: 'tasks',
          rowId: 'task-2',
          op: 'upsert',
          payload: { id: 'task-2' },
        },
      ]);

      const ts2 = engine.getMutationTimestamp('tasks', 'task-2');

      expect(ts1).toBeGreaterThan(0);
      expect(ts2).toBeGreaterThan(0);
      expect(ts2).toBeGreaterThanOrEqual(ts1);

      // task-3 should still be 0
      expect(engine.getMutationTimestamp('tasks', 'task-3')).toBe(0);
    });

    it('should use composite key with table:rowId', async () => {
      const engine = await createTestEngine({ includeProjects: true });

      // Same rowId in different tables
      await engine.applyLocalMutation([
        {
          table: 'tasks',
          rowId: 'id-1',
          op: 'upsert',
          payload: { id: 'id-1' },
        },
      ]);

      // tasks:id-1 should have timestamp
      expect(engine.getMutationTimestamp('tasks', 'id-1')).toBeGreaterThan(0);

      // projects:id-1 should NOT have timestamp (different table)
      expect(engine.getMutationTimestamp('projects', 'id-1')).toBe(0);
    });

    it('should emit data:change event after mutation', async () => {
      const engine = await createTestEngine();

      let dataChangeEvent: { scopes: string[]; timestamp: number } = {
        scopes: [],
        timestamp: 0,
      };
      engine.on('data:change', (payload) => {
        dataChangeEvent = payload;
      });

      await engine.applyLocalMutation([
        {
          table: 'tasks',
          rowId: 'task-1',
          op: 'upsert',
          payload: { id: 'task-1' },
        },
      ]);

      expect(dataChangeEvent.scopes).toContain('tasks');
      expect(dataChangeEvent.timestamp).toBeGreaterThan(0);
    });
  });
});
