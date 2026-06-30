import { describe, expect, it } from 'bun:test';
import type {
  SyncularBootstrapStatus,
  SyncularDiagnosticEvent,
  SyncularLiveQueryEvent,
  SyncularSyncRequestOptions,
  SyncularSyncResult,
} from './types';
import type { SyncularWorkerEvent } from './worker-protocol';
import { SYNCULAR_WORKER_PROTOCOL_VERSION } from './worker-protocol';
import {
  isSyncularRealtimeSyncMessage,
  resolveSyncularRealtimeUrl,
  type SyncularWorkerRealtimeClient,
  SyncularWorkerRealtimeController,
  type SyncularWorkerRealtimeSocket,
} from './worker-realtime';

describe('Syncular worker realtime', () => {
  it('resolves the websocket URL from sync config and params', () => {
    expect(
      resolveSyncularRealtimeUrl(
        {
          baseUrl: '/sync',
          actorId: 'actor',
          clientId: 'client-1',
        },
        { params: { token: 'abc' } },
        'https://app.example'
      )
    ).toBe(
      'wss://app.example/sync/realtime?clientId=client-1&transportPath=direct&syncPackEncoding=binary-sync-pack-v1&token=abc'
    );

    expect(
      resolveSyncularRealtimeUrl(
        {
          baseUrl: '/sync',
          actorId: 'actor',
          clientId: 'client-1',
        },
        { wsUrl: 'ws://api.example/socket' },
        'https://app.example'
      )
    ).toBe(
      'ws://api.example/socket?clientId=client-1&transportPath=direct&syncPackEncoding=binary-sync-pack-v1'
    );
  });

  it('recognizes server sync wakeup messages', () => {
    expect(isSyncularRealtimeSyncMessage({ event: 'sync' })).toBe(true);
    expect(isSyncularRealtimeSyncMessage({ event: 'pong' })).toBe(false);
    expect(isSyncularRealtimeSyncMessage('sync')).toBe(false);
  });

  it('binds default timer globals before scheduling heartbeats', () => {
    const originalSetTimeout = globalThis.setTimeout;
    let timerThis: unknown;
    globalThis.setTimeout = function (
      this: unknown,
      handler: Parameters<typeof setTimeout>[0],
      timeout?: Parameters<typeof setTimeout>[1],
      ...args: unknown[]
    ): ReturnType<typeof setTimeout> {
      timerThis = this;
      return originalSetTimeout(handler, timeout, ...(args as []));
    } as typeof setTimeout;

    try {
      const client = new FakeRealtimeClient();
      const sockets: FakeRealtimeSocket[] = [];
      const controller = new SyncularWorkerRealtimeController({
        getClient: () => client,
        getConfig: () => ({
          baseUrl: '/sync',
          actorId: 'actor',
          clientId: 'client-1',
        }),
        getLocationOrigin: () => 'https://app.example',
        createWebSocket: (url) => {
          const socket = new FakeRealtimeSocket(url);
          sockets.push(socket);
          return socket;
        },
        postEvent: () => {},
      });

      controller.start({ heartbeatTimeoutMs: 1 });
      sockets[0]!.open();

      expect(timerThis).toBe(globalThis);
      controller.stop();
    } finally {
      globalThis.setTimeout = originalSetTimeout;
    }
  });

  it('records websocket hello diagnostics without triggering a pull', async () => {
    const client = new FakeRealtimeClient();
    const sockets: FakeRealtimeSocket[] = [];
    const diagnostics: SyncularDiagnosticEvent[] = [];
    const controller = new SyncularWorkerRealtimeController({
      getClient: () => client,
      getConfig: () => ({
        baseUrl: '/sync',
        actorId: 'actor',
        clientId: 'client-1',
      }),
      getLocationOrigin: () => 'https://app.example',
      createWebSocket: (url) => {
        const socket = new FakeRealtimeSocket(url);
        sockets.push(socket);
        return socket;
      },
      postEvent: () => {},
      postDiagnostic: (event) =>
        diagnostics.push({ ...event, at: event.at ?? Date.now() }),
    });

    controller.start({ heartbeatTimeoutMs: 0 });
    sockets[0]!.open();
    sockets[0]!.message({
      event: 'hello',
      data: {
        protocolVersion: 1,
        sessionId: 'session-1',
        shardKey: 'sync-realtime-v1:default:default:default',
        cursor: 3,
        latestCursor: 5,
        scopeCount: 2,
        requiresSync: false,
        syncPackEncoding: 'binary-sync-pack-v1',
      },
    });

    await waitFor(() =>
      diagnostics.some((event) => event.code === 'realtime.hello')
    );
    expect(client.syncPulls).toBe(0);
    expect(diagnostics).toContainEqual(
      expect.objectContaining({
        code: 'realtime.hello',
        details: expect.objectContaining({
          sessionId: 'session-1',
          shardKey: 'sync-realtime-v1:default:default:default',
          cursor: 3,
          latestCursor: 5,
          requiresSync: false,
        }),
      })
    );
  });

  it('uses hello requiresSync as a reconnect catch-up fallback', async () => {
    const client = new FakeRealtimeClient();
    const sockets: FakeRealtimeSocket[] = [];
    const diagnostics: SyncularDiagnosticEvent[] = [];
    const controller = new SyncularWorkerRealtimeController({
      getClient: () => client,
      getConfig: () => ({
        baseUrl: '/sync',
        actorId: 'actor',
        clientId: 'client-1',
      }),
      getLocationOrigin: () => 'https://app.example',
      createWebSocket: (url) => {
        const socket = new FakeRealtimeSocket(url);
        sockets.push(socket);
        return socket;
      },
      postEvent: () => {},
      postDiagnostic: (event) =>
        diagnostics.push({ ...event, at: event.at ?? Date.now() }),
    });

    controller.start({ heartbeatTimeoutMs: 0 });
    sockets[0]!.open();
    sockets[0]!.message({
      event: 'hello',
      data: {
        cursor: 3,
        latestCursor: 5,
        requiresSync: true,
      },
    });

    await waitFor(() => client.syncPulls === 1);
    expect(diagnostics).toContainEqual(
      expect.objectContaining({
        code: 'realtime.reconnect_catchup_scheduled',
        details: expect.objectContaining({
          cursor: 5,
        }),
      })
    );
    expect(diagnostics).toContainEqual(
      expect.objectContaining({
        code: 'realtime.pull_required',
        details: expect.objectContaining({
          cursor: 5,
          reason: 'reconnect-catchup',
        }),
      })
    );
    client.resolvePull();
  });

  it('sends and forwards websocket presence messages', async () => {
    const client = new FakeRealtimeClient();
    const sockets: FakeRealtimeSocket[] = [];
    const events: SyncularWorkerEvent[] = [];
    const controller = new SyncularWorkerRealtimeController({
      getClient: () => client,
      getConfig: () => ({
        baseUrl: '/sync',
        actorId: 'actor',
        clientId: 'client-1',
      }),
      getLocationOrigin: () => 'https://app.example',
      createWebSocket: (url) => {
        const socket = new FakeRealtimeSocket(url);
        sockets.push(socket);
        return socket;
      },
      postEvent: (event) => events.push(event),
    });

    controller.start({ heartbeatTimeoutMs: 0 });
    sockets[0]!.open();
    controller.sendPresence('join', 'tasks:user-1', { editing: 'task-1' });

    expect(JSON.parse(sockets[0]!.sent.at(-1)!)).toEqual({
      type: 'presence',
      action: 'join',
      scopeKey: 'tasks:user-1',
      metadata: { editing: 'task-1' },
    });

    sockets[0]!.message({
      event: 'presence',
      data: {
        presence: {
          action: 'snapshot',
          scopeKey: 'tasks:user-1',
          entries: [
            {
              clientId: 'client-2',
              actorId: 'actor-2',
              joinedAt: 123,
              metadata: { viewing: 'task-2' },
            },
          ],
        },
      },
    });

    await waitFor(() => events.some((event) => event.type === 'presenceEvent'));
    expect(events).toContainEqual(
      expect.objectContaining({
        protocolVersion: SYNCULAR_WORKER_PROTOCOL_VERSION,
        type: 'presenceEvent',
        action: 'snapshot',
        scopeKey: 'tasks:user-1',
        entries: [
          {
            clientId: 'client-2',
            actorId: 'actor-2',
            joinedAt: 123,
            metadata: { viewing: 'task-2' },
          },
        ],
      })
    );
  });

  it('accepts websocket text frames delivered as bytes', async () => {
    const client = new FakeRealtimeClient();
    const sockets: FakeRealtimeSocket[] = [];
    const controller = new SyncularWorkerRealtimeController({
      getClient: () => client,
      getConfig: () => ({
        baseUrl: '/sync',
        actorId: 'actor',
        clientId: 'client-1',
      }),
      getLocationOrigin: () => 'https://app.example',
      createWebSocket: (url) => {
        const socket = new FakeRealtimeSocket(url);
        sockets.push(socket);
        return socket;
      },
      postEvent: () => {},
    });

    controller.start({ heartbeatTimeoutMs: 0 });
    sockets[0]!.open();
    sockets[0]!.messageBytes({ event: 'sync' });

    await waitFor(() => client.syncPulls === 1);
    expect(client.syncPullOptions[0]?.syncAttempt).toMatchObject({
      syncAttemptId: expect.any(String),
      traceId: expect.any(String),
      spanId: expect.any(String),
      traceparent: expect.any(String),
    });
    client.resolvePull();
  });

  it('surfaces cursor-only recovery diagnostics before pulling', async () => {
    const client = new FakeRealtimeClient();
    const sockets: FakeRealtimeSocket[] = [];
    const diagnostics: SyncularDiagnosticEvent[] = [];
    const controller = new SyncularWorkerRealtimeController({
      getClient: () => client,
      getConfig: () => ({
        baseUrl: '/sync',
        actorId: 'actor',
        clientId: 'client-1',
      }),
      getLocationOrigin: () => 'https://app.example',
      createWebSocket: (url) => {
        const socket = new FakeRealtimeSocket(url);
        sockets.push(socket);
        return socket;
      },
      postEvent: () => {},
      postDiagnostic: (event) =>
        diagnostics.push({ ...event, at: event.at ?? Date.now() }),
    });

    controller.start({ heartbeatTimeoutMs: 0 });
    sockets[0]!.open();
    sockets[0]!.message({
      event: 'sync',
      data: {
        cursor: 55,
        reason: 'payload-too-large',
        requiresPull: true,
      },
    });

    await waitFor(() => client.syncPulls === 1);
    client.resolvePull();
    await waitFor(() => sockets[0]!.sent.length === 1);
    expect(JSON.parse(sockets[0]!.sent[0]!)).toEqual({
      type: 'ack',
      cursor: 55,
    });
    expect(diagnostics).toContainEqual(
      expect.objectContaining({
        code: 'realtime.sync_wakeup',
        cursor: 55,
        details: expect.objectContaining({
          cursor: 55,
          reason: 'payload-too-large',
          requiresPull: true,
        }),
      })
    );
  });

  it('surfaces resync-required diagnostics before pulling', async () => {
    const client = new FakeRealtimeClient();
    const sockets: FakeRealtimeSocket[] = [];
    const diagnostics: SyncularDiagnosticEvent[] = [];
    const controller = new SyncularWorkerRealtimeController({
      getClient: () => client,
      getConfig: () => ({
        baseUrl: '/sync',
        actorId: 'actor',
        clientId: 'client-1',
      }),
      getLocationOrigin: () => 'https://app.example',
      createWebSocket: (url) => {
        const socket = new FakeRealtimeSocket(url);
        sockets.push(socket);
        return socket;
      },
      postEvent: () => {},
      postDiagnostic: (event) =>
        diagnostics.push({ ...event, at: event.at ?? Date.now() }),
    });

    controller.start({ heartbeatTimeoutMs: 0 });
    sockets[0]!.open();
    sockets[0]!.message({
      event: 'sync',
      data: {
        cursor: 99,
        reason: 'resync-required',
        requiresPull: true,
        droppedCount: 2,
      },
    });

    await waitFor(() => client.syncPulls === 1);
    client.resolvePull();
    await waitFor(() => sockets[0]!.sent.length === 1);
    expect(JSON.parse(sockets[0]!.sent[0]!)).toEqual({
      type: 'ack',
      cursor: 99,
    });
    expect(diagnostics).toContainEqual(
      expect.objectContaining({
        code: 'realtime.sync_wakeup',
        cursor: 99,
        details: expect.objectContaining({
          cursor: 99,
          reason: 'resync-required',
          requiresPull: true,
          droppedCount: 2,
        }),
      })
    );
    expect(diagnostics).toContainEqual(
      expect.objectContaining({
        code: 'realtime.pull_required',
        cursor: 99,
        syncAttemptId: client.syncPullOptions[0]!.syncAttempt!.syncAttemptId,
      })
    );
  });

  it('uses HTTP pull recovery for cursor-only websocket sync wakeups', async () => {
    const client = new FakeRealtimeClient();
    const sockets: FakeRealtimeSocket[] = [];
    const events: SyncularWorkerEvent[] = [];
    const diagnostics: SyncularDiagnosticEvent[] = [];
    const controller = new SyncularWorkerRealtimeController({
      getClient: () => client,
      getConfig: () => ({
        baseUrl: '/sync',
        actorId: 'actor',
        clientId: 'client-1',
      }),
      getLocationOrigin: () => 'https://app.example',
      createWebSocket: (url) => {
        const socket = new FakeRealtimeSocket(url);
        sockets.push(socket);
        return socket;
      },
      postEvent: (event) => events.push(event),
      postDiagnostic: (event) =>
        diagnostics.push({ ...event, at: event.at ?? Date.now() }),
    });

    controller.start({ heartbeatTimeoutMs: 0 });
    sockets[0]!.open();
    client.queueDrain([
      {
        queryId: 'query-1',
        version: 1,
        changedRows: [],
        rows: [{ id: 'realtime' }],
      },
    ]);
    sockets[0]!.message({
      event: 'sync',
      data: {
        cursor: 12,
      },
    });

    await waitFor(() => client.syncPulls === 1);
    expect(sockets[0]!.sent).toHaveLength(0);
    client.resolvePull();
    await waitFor(() => sockets[0]!.sent.length === 1);
    expect(
      sockets[0]!.sent.map((message) => JSON.parse(message))
    ).toContainEqual({ type: 'ack', cursor: 12 });
    await waitFor(() => liveEventVersions(events).length === 1);
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'liveQueryEvents',
        events: [
          expect.objectContaining({
            queryId: 'query-1',
            rows: [{ id: 'realtime' }],
          }),
        ],
      })
    );
    expect(diagnostics.map((event) => event.code)).toContain(
      'realtime.sync_wakeup'
    );
  });

  it('uses HTTP pull when a websocket message requires recovery', async () => {
    const client = new FakeRealtimeClient();
    const sockets: FakeRealtimeSocket[] = [];
    const diagnostics: SyncularDiagnosticEvent[] = [];
    const controller = new SyncularWorkerRealtimeController({
      getClient: () => client,
      getConfig: () => ({
        baseUrl: '/sync',
        actorId: 'actor',
        clientId: 'client-1',
      }),
      getLocationOrigin: () => 'https://app.example',
      createWebSocket: (url) => {
        const socket = new FakeRealtimeSocket(url);
        sockets.push(socket);
        return socket;
      },
      postEvent: () => {},
      postDiagnostic: (event) =>
        diagnostics.push({ ...event, at: event.at ?? Date.now() }),
    });

    controller.start({ heartbeatTimeoutMs: 0 });
    sockets[0]!.open();
    sockets[0]!.message({
      event: 'sync',
      data: {
        cursor: 88,
        reason: 'resync-required',
        requiresPull: true,
        droppedCount: 1,
      },
    });

    await waitFor(() => client.syncPulls === 1);
    client.resolvePull();
    await waitFor(() => sockets[0]!.sent.length === 1);
    expect(JSON.parse(sockets[0]!.sent[0]!)).toEqual({
      type: 'ack',
      cursor: 88,
    });
    expect(diagnostics).toContainEqual(
      expect.objectContaining({
        code: 'realtime.pull_required',
        details: expect.objectContaining({
          cursor: 88,
          reason: 'resync-required',
          droppedCount: 1,
        }),
      })
    );
  });

  it('applies binary websocket sync packs without an HTTP pull', async () => {
    const client = new FakeRealtimeClient();
    const sockets: FakeRealtimeSocket[] = [];
    const diagnostics: SyncularDiagnosticEvent[] = [];
    const controller = new SyncularWorkerRealtimeController({
      getClient: () => client,
      getConfig: () => ({
        baseUrl: '/sync',
        actorId: 'actor',
        clientId: 'client-1',
      }),
      getLocationOrigin: () => 'https://app.example',
      createWebSocket: (url) => {
        const socket = new FakeRealtimeSocket(url);
        sockets.push(socket);
        return socket;
      },
      postEvent: () => {},
      postDiagnostic: (event) =>
        diagnostics.push({ ...event, at: event.at ?? Date.now() }),
    });

    controller.start({ heartbeatTimeoutMs: 0 });
    sockets[0]!.open();
    sockets[0]!.messageRaw(new Uint8Array([0x53, 0x53, 0x50, 0x31, 1, 2, 3]));

    await waitFor(() => client.realtimeSyncPacks.length === 1);
    expect(client.syncPulls).toBe(0);
    expect(
      sockets[0]!.sent.map((message) => JSON.parse(message))
    ).toContainEqual({ type: 'ack', cursor: 44 });
    expect(Array.from(client.realtimeSyncPacks[0]!)).toEqual([
      0x53, 0x53, 0x50, 0x31, 1, 2, 3,
    ]);
    expect(diagnostics.map((event) => event.code)).toContain(
      'realtime.binary_applied'
    );
  });

  it('emits structured diagnostics for reconnect scheduling', async () => {
    const client = new FakeRealtimeClient();
    const sockets: FakeRealtimeSocket[] = [];
    const diagnostics: SyncularDiagnosticEvent[] = [];
    let attempts = 0;
    const controller = new SyncularWorkerRealtimeController({
      getClient: () => client,
      getConfig: () => ({
        baseUrl: '/sync',
        actorId: 'actor',
        clientId: 'client-1',
      }),
      getLocationOrigin: () => 'https://app.example',
      createWebSocket: (url) => {
        attempts += 1;
        if (attempts === 1) throw new Error('socket unavailable');
        const socket = new FakeRealtimeSocket(url);
        sockets.push(socket);
        return socket;
      },
      postEvent: () => {},
      postDiagnostic: (event) =>
        diagnostics.push({ ...event, at: event.at ?? Date.now() }),
    });

    controller.start({
      heartbeatTimeoutMs: 0,
      initialReconnectDelayMs: 1,
      maxReconnectDelayMs: 1,
    });

    await waitFor(() => attempts === 2 && sockets.length === 1);
    expect(diagnostics.map((event) => event.code)).toEqual([
      'realtime.connect_failed',
      'realtime.reconnect_scheduled',
    ]);
    expect(diagnostics[0]).toMatchObject({
      level: 'warn',
      source: 'realtime',
    });
  });

  it('applies reconnect jitter to scheduled reconnect delay', () => {
    const client = new FakeRealtimeClient();
    const diagnostics: SyncularDiagnosticEvent[] = [];
    let scheduledDelay: number | undefined;
    const controller = new SyncularWorkerRealtimeController({
      getClient: () => client,
      getConfig: () => ({
        baseUrl: '/sync',
        actorId: 'actor',
        clientId: 'client-1',
      }),
      getLocationOrigin: () => 'https://app.example',
      createWebSocket: () => {
        throw new Error('socket unavailable');
      },
      postEvent: () => {},
      postDiagnostic: (event) =>
        diagnostics.push({ ...event, at: event.at ?? Date.now() }),
      random: () => 0.5,
      setTimeout: ((handler, timeout) => {
        scheduledDelay = Number(timeout);
        return setTimeout(handler, 1);
      }) as typeof setTimeout,
    });

    controller.start({
      heartbeatTimeoutMs: 0,
      initialReconnectDelayMs: 100,
      maxReconnectDelayMs: 200,
      reconnectJitterRatio: 0.5,
    });

    controller.stop();
    expect(scheduledDelay).toBe(125);
    expect(diagnostics[1]).toMatchObject({
      code: 'realtime.reconnect_scheduled',
      details: {
        baseDelayMs: 100,
        jitterMs: 25,
        delayMs: 125,
      },
    });
  });

  it('caps jittered reconnect delay at the configured maximum', () => {
    const client = new FakeRealtimeClient();
    const diagnostics: SyncularDiagnosticEvent[] = [];
    let scheduledDelay: number | undefined;
    const controller = new SyncularWorkerRealtimeController({
      getClient: () => client,
      getConfig: () => ({
        baseUrl: '/sync',
        actorId: 'actor',
        clientId: 'client-1',
      }),
      getLocationOrigin: () => 'https://app.example',
      createWebSocket: () => {
        throw new Error('socket unavailable');
      },
      postEvent: () => {},
      postDiagnostic: (event) =>
        diagnostics.push({ ...event, at: event.at ?? Date.now() }),
      random: () => 1,
      setTimeout: ((handler, timeout) => {
        scheduledDelay = Number(timeout);
        return setTimeout(handler, 1);
      }) as typeof setTimeout,
    });

    controller.start({
      heartbeatTimeoutMs: 0,
      initialReconnectDelayMs: 100,
      maxReconnectDelayMs: 120,
      reconnectJitterRatio: 10,
    });

    controller.stop();
    expect(scheduledDelay).toBe(120);
    expect(diagnostics[1]).toMatchObject({
      code: 'realtime.reconnect_scheduled',
      details: {
        baseDelayMs: 100,
        jitterMs: 1000,
        delayMs: 120,
      },
    });
  });

  it('can jitter realtime HTTP pull recovery wakeups', async () => {
    const client = new FakeRealtimeClient();
    const sockets: FakeRealtimeSocket[] = [];
    let scheduledDelay: number | undefined;
    let scheduledHandler: (() => void) | undefined;
    const controller = new SyncularWorkerRealtimeController({
      getClient: () => client,
      getConfig: () => ({
        baseUrl: '/sync',
        actorId: 'actor',
        clientId: 'client-1',
      }),
      getLocationOrigin: () => 'https://app.example',
      createWebSocket: (url) => {
        const socket = new FakeRealtimeSocket(url);
        sockets.push(socket);
        return socket;
      },
      postEvent: () => {},
      random: () => 0.5,
      setTimeout: ((handler, timeout) => {
        scheduledDelay = Number(timeout);
        scheduledHandler = handler as () => void;
        return 1 as ReturnType<typeof setTimeout>;
      }) as typeof setTimeout,
      clearTimeout: (() => {}) as typeof clearTimeout,
    });

    controller.start({
      heartbeatTimeoutMs: 0,
      pullRecoveryJitterMs: 100,
    });
    sockets[0]!.open();
    sockets[0]!.message({
      event: 'sync',
      data: { cursor: 10, requiresPull: true, reason: 'server-wakeup' },
    });

    expect(client.syncPulls).toBe(0);
    await waitFor(() => scheduledDelay !== undefined);
    expect(scheduledDelay).toBe(50);
    scheduledHandler?.();
    await waitFor(() => client.syncPulls === 1);
    controller.stop();
  });

  it('runs a follow-up pull when wakeups arrive during an active pull', async () => {
    const client = new FakeRealtimeClient();
    const sockets: FakeRealtimeSocket[] = [];
    const events: SyncularWorkerEvent[] = [];
    const controller = new SyncularWorkerRealtimeController({
      getClient: () => client,
      getConfig: () => ({
        baseUrl: '/sync',
        actorId: 'actor',
        clientId: 'client-1',
      }),
      getLocationOrigin: () => 'https://app.example',
      createWebSocket: (url) => {
        const socket = new FakeRealtimeSocket(url);
        sockets.push(socket);
        return socket;
      },
      postEvent: (event) => events.push(event),
    });

    controller.start({ heartbeatTimeoutMs: 0, params: { token: 'abc' } });
    expect(sockets[0]?.url).toBe(
      'wss://app.example/sync/realtime?clientId=client-1&transportPath=direct&syncPackEncoding=binary-sync-pack-v1&token=abc'
    );
    sockets[0]!.open();

    client.queueDrain([
      {
        queryId: 'query-1',
        version: 1,
        changedRows: [],
        rows: [{ id: 'first' }],
      },
    ]);
    sockets[0]!.message({ event: 'sync' });
    sockets[0]!.message({ event: 'sync' });
    await waitFor(() => client.syncPulls === 1);

    client.resolvePull();
    await waitFor(() => client.syncPulls === 2);
    expect(liveEventVersions(events)).toEqual([1]);

    client.queueDrain([
      {
        queryId: 'query-1',
        version: 2,
        changedRows: [],
        rows: [{ id: 'second' }],
      },
    ]);
    client.resolvePull();
    await waitFor(() => liveEventVersions(events).length === 2);

    expect(liveEventVersions(events)).toEqual([1, 2]);
  });

  it('skips queued wakeup pulls already covered by the active pull cursor', async () => {
    const client = new FakeRealtimeClient();
    const sockets: FakeRealtimeSocket[] = [];
    const controller = new SyncularWorkerRealtimeController({
      getClient: () => client,
      getConfig: () => ({
        baseUrl: '/sync',
        actorId: 'actor',
        clientId: 'client-1',
      }),
      getLocationOrigin: () => 'https://app.example',
      createWebSocket: (url) => {
        const socket = new FakeRealtimeSocket(url);
        sockets.push(socket);
        return socket;
      },
      postEvent: () => {},
    });

    controller.start({ heartbeatTimeoutMs: 0 });
    sockets[0]!.open();
    client.queuePullCursor(10);
    sockets[0]!.message({
      event: 'sync',
      data: { cursor: 10, requiresPull: true },
    });
    sockets[0]!.message({
      event: 'sync',
      data: { cursor: 8, requiresPull: true },
    });
    await waitFor(() => client.syncPulls === 1);

    client.resolvePull();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(client.syncPulls).toBe(1);
  });

  it('reconnects after close and ignores stale socket wakeups', async () => {
    const client = new FakeRealtimeClient();
    const sockets: FakeRealtimeSocket[] = [];
    const events: SyncularWorkerEvent[] = [];
    const controller = new SyncularWorkerRealtimeController({
      getClient: () => client,
      getConfig: () => ({
        baseUrl: '/sync',
        actorId: 'actor',
        clientId: 'client-1',
      }),
      getLocationOrigin: () => 'https://app.example',
      createWebSocket: (url) => {
        const socket = new FakeRealtimeSocket(url);
        sockets.push(socket);
        return socket;
      },
      postEvent: (event) => events.push(event),
    });

    controller.start({
      heartbeatTimeoutMs: 0,
      initialReconnectDelayMs: 1,
      maxReconnectDelayMs: 1,
    });
    sockets[0]!.open();
    sockets[0]!.serverClose();

    await waitFor(() => sockets.length === 2);
    sockets[0]!.message({ event: 'sync' });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(client.syncPulls).toBe(0);

    sockets[1]!.open();
    sockets[1]!.message({
      event: 'hello',
      data: { cursor: 3, latestCursor: 3, requiresSync: false },
    });
    await new Promise((resolve) => setTimeout(resolve, 15));
    expect(client.syncPulls).toBe(0);
    sockets[0]!.message({ event: 'sync' });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(client.syncPulls).toBe(0);
    sockets[1]!.message({ event: 'sync' });
    await waitFor(() => client.syncPulls === 1);
    client.resolvePull();

    expect(
      events
        .filter((event) => event.type === 'realtimeState')
        .map((event) => event.state)
    ).toEqual([
      'connecting',
      'connected',
      'disconnected',
      'connecting',
      'connected',
    ]);
  });

  it('does not emit stale live events after realtime stops', async () => {
    const client = new FakeRealtimeClient();
    const sockets: FakeRealtimeSocket[] = [];
    const events: SyncularWorkerEvent[] = [];
    const controller = new SyncularWorkerRealtimeController({
      getClient: () => client,
      getConfig: () => ({
        baseUrl: '/sync',
        actorId: 'actor',
        clientId: 'client-1',
      }),
      getLocationOrigin: () => 'https://app.example',
      createWebSocket: (url) => {
        const socket = new FakeRealtimeSocket(url);
        sockets.push(socket);
        return socket;
      },
      postEvent: (event) => events.push(event),
    });

    controller.start({ heartbeatTimeoutMs: 0 });
    sockets[0]!.open();
    client.queueDrain([
      {
        queryId: 'query-1',
        version: 1,
        changedRows: [],
        rows: [{ id: 'stale' }],
      },
    ]);
    sockets[0]!.message({ event: 'sync' });
    await waitFor(() => client.syncPulls === 1);
    controller.stop();
    client.resolvePull();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(events.filter((event) => event.type === 'liveQueryEvents')).toEqual(
      []
    );
  });
});

class FakeRealtimeClient implements SyncularWorkerRealtimeClient {
  syncPulls = 0;
  syncPullOptions: SyncularSyncRequestOptions[] = [];
  realtimeSyncPacks: Uint8Array[] = [];
  #pullResolvers: Array<() => void> = [];
  #drains: Array<Array<SyncularLiveQueryEvent<Record<string, unknown>>>> = [];
  #pullCursors: number[] = [];

  syncPull(
    options: SyncularSyncRequestOptions = {}
  ): Promise<SyncularSyncResult> {
    this.syncPulls += 1;
    this.syncPullOptions.push(options);
    return new Promise((resolve) => {
      this.#pullResolvers.push(() =>
        resolve({
          changedTables: [],
          changedRows: [],
          changedRowsTruncated: false,
          subscriptions: subscriptionResults(this.#pullCursors.shift()),
          bootstrap: zeroBootstrapStatus(),
          pushedCommits: 0,
          timings: zeroSyncTimings(),
        })
      );
    });
  }

  queuePullCursor(cursor: number): void {
    this.#pullCursors.push(cursor);
  }

  async applyRealtimeSyncPack(bytes: Uint8Array): Promise<SyncularSyncResult> {
    this.realtimeSyncPacks.push(bytes);
    return {
      changedTables: ['tasks'],
      changedRows: [],
      changedRowsTruncated: false,
      subscriptions: [
        {
          id: 'tasks-subscription',
          table: 'tasks',
          status: 'active',
          scopes: {},
          nextCursor: 44,
          bootstrapPhase: 0,
          bootstrapState: null,
          ready: true,
          phase: 'live',
          progressPercent: 100,
          snapshotRows: [],
          commits: [],
        },
      ],
      bootstrap: {
        ...zeroBootstrapStatus(),
        channelPhase: 'live',
        expectedSubscriptionIds: ['tasks-subscription'],
        readySubscriptionIds: ['tasks-subscription'],
        subscriptions: [
          {
            id: 'tasks-subscription',
            table: 'tasks',
            expected: true,
            ready: true,
            status: 'active',
            phase: 'live',
            progressPercent: 100,
            cursor: 44,
            bootstrapState: null,
            bootstrapPhase: 0,
          },
        ],
        phases: [
          {
            phase: 0,
            expectedSubscriptionIds: ['tasks-subscription'],
            readySubscriptionIds: ['tasks-subscription'],
            pendingSubscriptionIds: [],
            isReady: true,
            progressPercent: 100,
          },
        ],
      },
      pushedCommits: 0,
      timings: zeroSyncTimings(),
    };
  }

  drainLiveQueryEvents<
    Row extends Record<string, unknown> = Record<string, unknown>,
  >(): Array<SyncularLiveQueryEvent<Row>> {
    return (this.#drains.shift() ?? []) as Array<SyncularLiveQueryEvent<Row>>;
  }

  queueDrain(
    events: Array<SyncularLiveQueryEvent<Record<string, unknown>>>
  ): void {
    this.#drains.push(events);
  }

  resolvePull(): void {
    const resolve = this.#pullResolvers.shift();
    if (!resolve) throw new Error('No pending sync pull to resolve');
    resolve();
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
    snapshotChunkResetMs: 0,
    snapshotChunkBindMs: 0,
    snapshotChunkStepMs: 0,
    commitApplyMs: 0,
    subscriptionStateMs: 0,
    notifyMs: 0,
  };
}

function subscriptionResults(
  cursor: number | undefined
): SyncularSyncResult['subscriptions'] {
  if (cursor === undefined) return [];
  return [
    {
      id: 'tasks-subscription',
      table: 'tasks',
      status: 'active',
      scopes: {},
      nextCursor: cursor,
      bootstrapPhase: 0,
      bootstrapState: null,
      ready: true,
      phase: 'live',
      progressPercent: 100,
      snapshotRows: [],
      commits: [],
    },
  ];
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

class FakeRealtimeSocket implements SyncularWorkerRealtimeSocket {
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  sent: string[] = [];

  constructor(readonly url: string) {}

  open(): void {
    this.onopen?.({} as Event);
  }

  message(value: unknown): void {
    this.onmessage?.({
      data: typeof value === 'string' ? value : JSON.stringify(value),
    } as MessageEvent);
  }

  messageBytes(value: unknown): void {
    this.onmessage?.({
      data: new TextEncoder().encode(JSON.stringify(value)),
    } as MessageEvent);
  }

  messageRaw(data: MessageEvent['data']): void {
    this.onmessage?.({ data } as MessageEvent);
  }

  serverClose(): void {
    this.onclose?.({} as CloseEvent);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {}
}

function liveEventVersions(events: readonly SyncularWorkerEvent[]): number[] {
  return events
    .filter((event) => event.type === 'liveQueryEvents')
    .flatMap((event) => event.events.map((liveEvent) => liveEvent.version));
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error('Timed out waiting for realtime condition');
}
