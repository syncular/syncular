/**
 * Tests for SyncEngine
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import {
  enqueueOutboxCommit,
  type SyncClientDb,
  SyncEngine,
  type SyncEngineConfig,
  type SyncPullSubscriptionResponse,
} from '@syncular/client';
import type { Kysely } from 'kysely';
import {
  createMockDb,
  createMockHandlerRegistry,
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
      handlers: createMockHandlerRegistry(),
      actorId: 'test-actor',
      clientId: 'test-client',
      subscriptions: [],
      dataChangeDebounceMs: false,
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

    it('should auto-detect realtime mode for realtime-capable transport', () => {
      type ConnState = 'disconnected' | 'connecting' | 'connected';

      let currentState: ConnState = 'disconnected';
      const base = createMockTransport();
      const realtimeTransport = {
        ...base,
        connect(
          _args: { clientId: string },
          _onEvent: (_event: unknown) => void,
          onStateChange?: (state: ConnState) => void
        ) {
          currentState = 'connected';
          onStateChange?.('connected');
          return () => {
            currentState = 'disconnected';
            onStateChange?.('disconnected');
          };
        },
        getConnectionState(): ConnState {
          return currentState;
        },
        reconnect() {
          currentState = 'connected';
        },
      };

      const engine = createEngine({ transport: realtimeTransport });
      const state = engine.getState();

      expect(state.transportMode).toBe('realtime');
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

    it('should run a catch-up sync after realtime reconnect', async () => {
      type ConnState = 'disconnected' | 'connecting' | 'connected';

      let currentState: ConnState = 'disconnected';
      let currentStateCallback: ((state: ConnState) => void) | null = null;
      let pullCount = 0;

      const base = createMockTransport({
        onPull: () => {
          pullCount += 1;
        },
      });

      const realtimeTransport = {
        ...base,
        connect(
          _args: { clientId: string },
          _onEvent: (_event: unknown) => void,
          onStateChange?: (state: ConnState) => void
        ) {
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
          currentState = 'connecting';
          currentStateCallback?.('connecting');
          queueMicrotask(() => {
            currentState = 'connected';
            currentStateCallback?.('connected');
          });
        },
      };

      const engine = createEngine({
        transport: realtimeTransport,
        realtimeEnabled: true,
      });
      await engine.start();
      await waitFor(
        () => engine.getState().connectionState === 'connected',
        500
      );

      pullCount = 0;

      engine.disconnect();
      engine.reconnect();

      await waitFor(() => pullCount >= 2, 2_000);
      expect(pullCount).toBeGreaterThanOrEqual(2);
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
      transport.sync = async () => {
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

    it('should emit push:result and conflict:new for rejected pushes', async () => {
      const transport = createMockTransport({
        pushResponse: {
          status: 'rejected',
          results: [
            {
              opIndex: 0,
              status: 'conflict',
              message: 'Version conflict',
              server_version: 2,
              server_row: { id: 'conflict-row', title: 'Server' },
            },
          ],
        },
      });

      const engine = createEngine({ transport });
      const pushStatuses: string[] = [];
      const conflictTables: string[] = [];
      engine.on('push:result', (payload) => {
        pushStatuses.push(payload.status);
      });
      engine.on('conflict:new', (payload) => {
        conflictTables.push(payload.table);
      });

      await engine.start();
      await enqueueOutboxCommit(db, {
        operations: [
          {
            table: 'tasks',
            row_id: 'conflict-row',
            op: 'upsert',
            payload: { title: 'Local' },
            base_version: 1,
          },
        ],
      });

      const result = await engine.sync();
      expect(result.success).toBe(true);
      expect(pushStatuses).toContain('rejected');
      expect(conflictTables).toEqual(['tasks']);
    });

    it('passes commit metadata to applyChange for WS inline deliveries', async () => {
      type ConnState = 'disconnected' | 'connecting' | 'connected';
      let currentState: ConnState = 'disconnected';
      let onRealtimeEvent:
        | ((event: { event: string; data: Record<string, unknown> }) => void)
        | null = null;
      const appliedContexts: Array<{
        commitSeq: number | null | undefined;
        actorId: string | null | undefined;
        createdAt: string | null | undefined;
      }> = [];

      const handlers = createMockHandlerRegistry();
      handlers.push({
        table: 'tasks',
        applySnapshot: async () => {},
        clearAll: async () => {},
        applyChange: async (ctx) => {
          appliedContexts.push({
            commitSeq: ctx.commitSeq,
            actorId: ctx.actorId,
            createdAt: ctx.createdAt,
          });
        },
      });

      const base = createMockTransport();
      const realtimeTransport = {
        ...base,
        connect(
          _args: { clientId: string },
          onEvent: (event: {
            event: string;
            data: Record<string, unknown>;
          }) => void,
          onStateChange?: (state: ConnState) => void
        ) {
          onRealtimeEvent = onEvent;
          currentState = 'connected';
          onStateChange?.('connected');
          return () => {
            currentState = 'disconnected';
            onStateChange?.('disconnected');
          };
        },
        getConnectionState(): ConnState {
          return currentState;
        },
        reconnect() {
          currentState = 'connected';
        },
      };

      const engine = createEngine({
        handlers,
        transport: realtimeTransport,
        realtimeEnabled: true,
      });

      await engine.start();
      expect(onRealtimeEvent).not.toBeNull();

      onRealtimeEvent?.({
        event: 'sync',
        data: {
          cursor: 11,
          actorId: 'peer-user',
          createdAt: '2026-02-28T12:00:00.000Z',
          changes: [
            {
              table: 'tasks',
              row_id: 'ws-row-1',
              op: 'upsert',
              row_json: { id: 'ws-row-1', title: 'Inline' },
              row_version: 11,
              scopes: {},
            },
          ],
          timestamp: Date.now(),
        },
      });

      await waitFor(() => appliedContexts.length === 1, 1_000);
      expect(appliedContexts[0]).toEqual({
        commitSeq: 11,
        actorId: 'peer-user',
        createdAt: '2026-02-28T12:00:00.000Z',
      });
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

    it('should preserve first pull round commits when additional rounds run', async () => {
      const handlers = createMockHandlerRegistry();
      handlers.push({
        table: 'sync_outbox_commits',
        applySnapshot: async () => {},
        clearAll: async () => {},
        applyChange: async () => {},
      });

      let pullCallCount = 0;
      const transport = createMockTransport();
      transport.sync = async (request) => {
        const result: {
          ok: true;
          pull?: { ok: true; subscriptions: SyncPullSubscriptionResponse[] };
        } = { ok: true };

        if (!request.pull) {
          return result;
        }

        pullCallCount += 1;

        if (pullCallCount === 2) {
          result.pull = {
            ok: true,
            subscriptions: [
              {
                id: 'sub-1',
                status: 'active',
                scopes: {},
                bootstrap: false,
                nextCursor: 1,
                commits: [
                  {
                    commitSeq: 1,
                    createdAt: new Date(1).toISOString(),
                    actorId: 'peer',
                    changes: [
                      {
                        table: 'sync_outbox_commits',
                        row_id: 'peer-row',
                        op: 'upsert',
                        row_json: { id: 'peer-row' },
                        row_version: 1,
                        scopes: {},
                      },
                    ],
                  },
                ],
                snapshots: [],
              },
            ],
          };
        } else {
          result.pull = {
            ok: true,
            subscriptions: [
              {
                id: 'sub-1',
                status: 'active',
                scopes: {},
                bootstrap: false,
                nextCursor: pullCallCount >= 2 ? 1 : -1,
                commits: [],
                snapshots: [],
              },
            ],
          };
        }

        return result;
      };

      const engine = createEngine({
        transport,
        handlers,
        subscriptions: [
          {
            id: 'sub-1',
            table: 'sync_outbox_commits',
            scopes: {},
            params: {},
          },
        ],
      });

      await engine.start();

      const result = await engine.sync();
      expect(result.success).toBe(true);
      expect(result.pullRounds).toBe(2);
      expect(result.pullResponse.subscriptions).toHaveLength(1);
      expect(result.pullResponse.subscriptions[0]?.commits).toHaveLength(1);
      expect(
        result.pullResponse.subscriptions[0]?.commits[0]?.changes
      ).toHaveLength(1);
    });

    it('should use WS push for the first outbox commit when available', async () => {
      const base = createMockTransport();
      const syncRequests: Array<{ hasPush: boolean; hasPull: boolean }> = [];
      let wsPushCount = 0;

      const transport = {
        ...base,
        async sync(request: Parameters<typeof base.sync>[0]) {
          syncRequests.push({
            hasPush: request.push !== undefined,
            hasPull: request.pull !== undefined,
          });
          return base.sync(request);
        },
        async pushViaWs(request: {
          clientId: string;
          clientCommitId: string;
          operations: Array<{ op: 'upsert' | 'delete' }>;
          schemaVersion: number;
        }) {
          wsPushCount += 1;
          return {
            ok: true as const,
            status: 'applied' as const,
            commitSeq: 101,
            results: request.operations.map((_, i) => ({
              opIndex: i,
              status: 'applied' as const,
            })),
          };
        },
      };

      const engine = createEngine({ transport });
      await engine.start();

      syncRequests.length = 0;
      wsPushCount = 0;

      await enqueueOutboxCommit(db, {
        operations: [
          {
            table: 'tasks',
            row_id: 'ws-first',
            op: 'upsert',
            payload: { title: 'WS first' },
            base_version: null,
          },
        ],
      });

      const result = await engine.sync();
      expect(result.success).toBe(true);
      expect(wsPushCount).toBe(1);
      expect(syncRequests.some((r) => r.hasPull)).toBe(true);
      expect(syncRequests.some((r) => r.hasPush)).toBe(false);

      const rows = await db
        .selectFrom('sync_outbox_commits')
        .select(['status', 'acked_commit_seq'])
        .execute();

      expect(rows).toHaveLength(1);
      expect(rows[0]?.status).toBe('acked');
      expect(rows[0]?.acked_commit_seq).toBe(101);
    });

    it('should fall back to HTTP push when WS push returns null', async () => {
      let httpPushCount = 0;
      const base = createMockTransport({
        onPush: () => {
          httpPushCount += 1;
        },
      });
      const syncRequests: Array<{ hasPush: boolean; hasPull: boolean }> = [];
      let wsPushCount = 0;

      const transport = {
        ...base,
        async sync(request: Parameters<typeof base.sync>[0]) {
          syncRequests.push({
            hasPush: request.push !== undefined,
            hasPull: request.pull !== undefined,
          });
          return base.sync(request);
        },
        async pushViaWs() {
          wsPushCount += 1;
          return null;
        },
      };

      const engine = createEngine({ transport });
      await engine.start();

      syncRequests.length = 0;
      wsPushCount = 0;
      httpPushCount = 0;

      await enqueueOutboxCommit(db, {
        operations: [
          {
            table: 'tasks',
            row_id: 'http-fallback',
            op: 'upsert',
            payload: { title: 'HTTP fallback' },
            base_version: null,
          },
        ],
      });

      const result = await engine.sync();
      expect(result.success).toBe(true);
      expect(wsPushCount).toBe(1);
      expect(httpPushCount).toBe(1);
      expect(syncRequests.some((r) => r.hasPull)).toBe(true);
      expect(syncRequests.some((r) => r.hasPush)).toBe(true);
    });

    it('should flush outbox commits enqueued during pull via queued sync', async () => {
      let enableInjection = false;
      let injected = false;
      const transport = createMockTransport({
        onPull: () => {},
      });

      // Delay pull part of sync so we can enqueue a new commit after push finished.
      const originalSync = transport.sync.bind(transport);
      transport.sync = async (request) => {
        if (request.pull) {
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
        }

        return originalSync(request);
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

  describe('await utilities', () => {
    it('awaitPhase resolves when phase is reached', async () => {
      const engine = createEngine();
      await engine.start();

      const progress = await engine.awaitPhase('live', { timeoutMs: 1000 });
      expect(progress.channelPhase).toBe('live');
    });

    it('awaitPhase times out when phase is not reached', async () => {
      const engine = createEngine();
      await expect(
        engine.awaitPhase('bootstrapping', { timeoutMs: 30 })
      ).rejects.toThrow('Timed out');
    });

    it('awaitBootstrapComplete resolves after bootstrap state clears', async () => {
      const engine = createEngine();
      await engine.start();

      const now = Date.now();
      await db
        .insertInto('sync_subscription_state')
        .values({
          state_id: 'default',
          subscription_id: 'team-members',
          table: 'tasks',
          scopes_json: '{}',
          params_json: '{}',
          cursor: -1,
          bootstrap_state_json: JSON.stringify({
            asOfCommitSeq: 0,
            tables: ['tasks'],
            tableIndex: 0,
            rowCursor: null,
          }),
          status: 'active',
          created_at: now,
          updated_at: now,
        })
        .execute();

      const awaiting = engine.awaitBootstrapComplete({
        subscriptionId: 'team-members',
        timeoutMs: 1000,
      });

      await db
        .updateTable('sync_subscription_state')
        .set({
          bootstrap_state_json: null,
          updated_at: Date.now(),
        })
        .where('state_id', '=', 'default')
        .where('subscription_id', '=', 'team-members')
        .execute();

      await engine.sync();

      const progress = await awaiting;
      expect(progress.channelPhase).not.toBe('error');
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
        { id: 'new-sub', table: 'test', scopes: {} },
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
      const handlers: SyncEngineConfig<TestDb>['handlers'] = [
        {
          table: 'tasks',
          applySnapshot: async () => {},
          clearAll: async () => {},
          applyChange: async () => {},
        },
      ];
      if (args.includeProjects) {
        handlers.push({
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
        handlers,
        actorId: 'test-actor',
        clientId: 'test-client',
        subscriptions: [],
        dataChangeDebounceMs: false,
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

  describe('WS delivery skip-HTTP', () => {
    type ConnState = 'disconnected' | 'connecting' | 'connected';

    function createRealtimeTransport(
      baseTransport: ReturnType<typeof createMockTransport>
    ) {
      let onEventCb:
        | ((event: {
            event: string;
            data: { cursor?: number; changes?: unknown[]; timestamp: number };
          }) => void)
        | null = null;
      let onStateCb: ((state: ConnState) => void) | null = null;

      const rt = {
        ...baseTransport,
        connect(
          _args: { clientId: string },
          onEvent: typeof onEventCb,
          onStateChange?: typeof onStateCb
        ) {
          onEventCb = onEvent;
          onStateCb = onStateChange ?? null;
          queueMicrotask(() => onStateCb?.('connected'));
          return () => {};
        },
        getConnectionState(): ConnState {
          return 'connected';
        },
        reconnect() {},
        // Helpers for tests
        simulateSyncEvent(data: {
          cursor?: number;
          changes?: unknown[];
          timestamp?: number;
        }) {
          onEventCb?.({
            event: 'sync',
            data: { timestamp: Date.now(), ...data },
          });
        },
      };
      return rt;
    }

    it('should skip HTTP sync when WS delivers changes with cursor', async () => {
      let syncCallCount = 0;
      const base = createMockTransport({
        onPull: () => {
          syncCallCount++;
        },
      });
      const rt = createRealtimeTransport(base);

      const handlers: SyncEngineConfig<SyncClientDb>['handlers'] = [
        {
          table: 'tasks',
          applySnapshot: async () => {},
          clearAll: async () => {},
          applyChange: async () => {},
        },
      ];

      const engine = createEngine({
        transport: rt,
        handlers,
        realtimeEnabled: true,
      });
      await engine.start();
      await waitFor(
        () => engine.getState().connectionState === 'connected',
        500
      );

      // Reset after initial sync
      syncCallCount = 0;

      let syncCompleteCount = 0;
      engine.on('sync:complete', () => {
        syncCompleteCount++;
      });

      // Simulate WS delivering inline changes with cursor
      rt.simulateSyncEvent({
        cursor: 100,
        changes: [
          {
            table: 'tasks',
            row_id: 'task-1',
            op: 'upsert',
            row_json: { id: 'task-1', title: 'Hello' },
            row_version: 1,
            scopes: {},
          },
        ],
      });

      // Wait for handleWsDelivery to complete
      await flushPromises();
      await new Promise((r) => setTimeout(r, 50));

      // Should NOT have called transport.sync (HTTP pull)
      expect(syncCallCount).toBe(0);
      // Should have emitted sync:complete
      expect(syncCompleteCount).toBeGreaterThanOrEqual(1);
    });

    it('should fall back to HTTP sync when no cursor in WS event', async () => {
      let syncCallCount = 0;
      const base = createMockTransport({
        onPull: () => {
          syncCallCount++;
        },
      });
      const rt = createRealtimeTransport(base);

      const engine = createEngine({
        transport: rt,
        realtimeEnabled: true,
      });
      await engine.start();
      await waitFor(
        () => engine.getState().connectionState === 'connected',
        500
      );

      syncCallCount = 0;

      // Simulate WS event with changes but no cursor
      rt.simulateSyncEvent({
        changes: [
          {
            table: 'tasks',
            row_id: 'task-1',
            op: 'upsert',
            row_json: {},
            row_version: 1,
            scopes: {},
          },
        ],
      });

      await flushPromises();
      await new Promise((r) => setTimeout(r, 50));

      // Should fall back to HTTP
      expect(syncCallCount).toBeGreaterThanOrEqual(1);
    });

    it('should fall back to HTTP sync when no changes in WS event (cursor-only)', async () => {
      let syncCallCount = 0;
      const base = createMockTransport({
        onPull: () => {
          syncCallCount++;
        },
      });
      const rt = createRealtimeTransport(base);

      const engine = createEngine({
        transport: rt,
        realtimeEnabled: true,
      });
      await engine.start();
      await waitFor(
        () => engine.getState().connectionState === 'connected',
        500
      );

      syncCallCount = 0;

      // Simulate cursor-only WS event (no inline changes)
      rt.simulateSyncEvent({ cursor: 100 });

      await flushPromises();
      await new Promise((r) => setTimeout(r, 50));

      // Should fall back to HTTP
      expect(syncCallCount).toBeGreaterThanOrEqual(1);
    });

    it('should fall back to HTTP sync when outbox has pending commits', async () => {
      let syncCallCount = 0;
      const base = createMockTransport({
        onPull: () => {
          syncCallCount++;
        },
      });
      const rt = createRealtimeTransport(base);

      const handlers: SyncEngineConfig<SyncClientDb>['handlers'] = [
        {
          table: 'tasks',
          applySnapshot: async () => {},
          clearAll: async () => {},
          applyChange: async () => {},
        },
      ];

      const engine = createEngine({
        transport: rt,
        handlers,
        realtimeEnabled: true,
      });
      await engine.start();
      await waitFor(
        () => engine.getState().connectionState === 'connected',
        500
      );

      // Enqueue a commit to create pending outbox state
      await enqueueOutboxCommit(db, {
        operations: [
          {
            table: 'tasks',
            row_id: 'task-1',
            op: 'upsert',
            payload: { title: 'Test' },
            base_version: null,
          },
        ],
      });
      await engine.refreshOutboxStats();

      syncCallCount = 0;

      // Simulate WS with inline changes
      rt.simulateSyncEvent({
        cursor: 100,
        changes: [
          {
            table: 'tasks',
            row_id: 'task-2',
            op: 'upsert',
            row_json: { id: 'task-2' },
            row_version: 1,
            scopes: {},
          },
        ],
      });

      await flushPromises();
      await new Promise((r) => setTimeout(r, 50));

      // Should fall back to HTTP to push outbox
      expect(syncCallCount).toBeGreaterThanOrEqual(1);
    });

    it('should fall back to HTTP sync when afterPull plugins exist', async () => {
      let syncCallCount = 0;
      let inlineApplyCount = 0;
      const base = createMockTransport({
        onPull: () => {
          syncCallCount++;
        },
      });
      const rt = createRealtimeTransport(base);

      const handlers: SyncEngineConfig<SyncClientDb>['handlers'] = [
        {
          table: 'tasks',
          applySnapshot: async () => {},
          clearAll: async () => {},
          applyChange: async () => {
            inlineApplyCount++;
          },
        },
      ];

      const engine = createEngine({
        transport: rt,
        handlers,
        realtimeEnabled: true,
        plugins: [
          {
            name: 'test-plugin',
            async afterPull(_ctx, args) {
              return args.response;
            },
          },
        ],
      });
      await engine.start();
      await waitFor(
        () => engine.getState().connectionState === 'connected',
        500
      );

      syncCallCount = 0;

      // Simulate WS with inline changes
      rt.simulateSyncEvent({
        cursor: 100,
        changes: [
          {
            table: 'tasks',
            row_id: 'task-1',
            op: 'upsert',
            row_json: { id: 'task-1' },
            row_version: 1,
            scopes: {},
          },
        ],
      });

      await flushPromises();
      await new Promise((r) => setTimeout(r, 50));

      // Should fall back to HTTP because afterPull plugin exists
      expect(syncCallCount).toBeGreaterThanOrEqual(1);
      // Should not apply inline WS payload when afterPull plugins are present.
      expect(inlineApplyCount).toBe(0);
    });

    it('should emit data:change when WS delivery skips HTTP', async () => {
      const base = createMockTransport();
      const rt = createRealtimeTransport(base);

      const handlers: SyncEngineConfig<SyncClientDb>['handlers'] = [
        {
          table: 'tasks',
          applySnapshot: async () => {},
          clearAll: async () => {},
          applyChange: async () => {},
        },
      ];

      const engine = createEngine({
        transport: rt,
        handlers,
        realtimeEnabled: true,
      });
      await engine.start();
      await waitFor(
        () => engine.getState().connectionState === 'connected',
        500
      );

      const dataChangeScopes: string[][] = [];
      engine.on('data:change', (payload) => {
        dataChangeScopes.push(payload.scopes);
      });

      rt.simulateSyncEvent({
        cursor: 100,
        changes: [
          {
            table: 'tasks',
            row_id: 'task-1',
            op: 'upsert',
            row_json: { id: 'task-1' },
            row_version: 1,
            scopes: {},
          },
        ],
      });

      await flushPromises();
      await new Promise((r) => setTimeout(r, 50));

      // Should have emitted data:change with 'tasks'
      expect(dataChangeScopes.some((s) => s.includes('tasks'))).toBe(true);
    });
  });
});
