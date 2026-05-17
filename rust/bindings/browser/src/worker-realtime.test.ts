import { describe, expect, it } from 'bun:test';
import type {
  SyncularV2DiagnosticEvent,
  SyncularV2LiveQueryEvent,
  SyncularV2SyncResult,
} from './types';
import type { SyncularV2WorkerEvent } from './worker-protocol';
import {
  isSyncularV2RealtimeSyncMessage,
  resolveSyncularV2RealtimeUrl,
  type SyncularV2WorkerRealtimeClient,
  SyncularV2WorkerRealtimeController,
  type SyncularV2WorkerRealtimeSocket,
} from './worker-realtime';

describe('Syncular v2 worker realtime', () => {
  it('resolves the websocket URL from sync config and params', () => {
    expect(
      resolveSyncularV2RealtimeUrl(
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
      resolveSyncularV2RealtimeUrl(
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
    expect(isSyncularV2RealtimeSyncMessage({ event: 'sync' })).toBe(true);
    expect(isSyncularV2RealtimeSyncMessage({ event: 'pong' })).toBe(false);
    expect(isSyncularV2RealtimeSyncMessage('sync')).toBe(false);
  });

  it('accepts websocket text frames delivered as bytes', async () => {
    const client = new FakeRealtimeClient();
    const sockets: FakeRealtimeSocket[] = [];
    const controller = new SyncularV2WorkerRealtimeController({
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
    client.resolvePull();
  });

  it('applies inline websocket changes without an HTTP pull', async () => {
    const client = new FakeRealtimeClient();
    const sockets: FakeRealtimeSocket[] = [];
    const events: SyncularV2WorkerEvent[] = [];
    const diagnostics: SyncularV2DiagnosticEvent[] = [];
    const controller = new SyncularV2WorkerRealtimeController({
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
        rows: [{ id: 'inline' }],
      },
    ]);
    sockets[0]!.message({
      event: 'sync',
      data: {
        cursor: 12,
        actorId: 'server',
        createdAt: '2026-05-17T00:00:00.000Z',
        changes: [
          {
            table: 'tasks',
            row_id: 'task-inline',
            op: 'upsert',
            row_json: { id: 'task-inline', title: 'Inline' },
            row_version: 12,
            scopes: {},
          },
        ],
      },
    });

    await waitFor(() => client.realtimeApplies === 1);
    expect(client.syncPulls).toBe(0);
    expect(
      sockets[0]!.sent.map((message) => JSON.parse(message))
    ).toContainEqual({ type: 'ack', cursor: 12 });
    expect(client.appliedRealtime[0]).toMatchObject({
      cursor: 12,
      changes: [{ table: 'tasks', row_id: 'task-inline' }],
    });
    await waitFor(() => liveEventVersions(events).length === 1);
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'rowsChanged',
        source: 'remotePull',
        changedTables: ['tasks'],
      })
    );
    expect(diagnostics.map((event) => event.code)).toContain(
      'realtime.inline_applied'
    );
  });

  it('applies binary websocket sync packs without an HTTP pull', async () => {
    const client = new FakeRealtimeClient();
    const sockets: FakeRealtimeSocket[] = [];
    const diagnostics: SyncularV2DiagnosticEvent[] = [];
    const controller = new SyncularV2WorkerRealtimeController({
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
    const diagnostics: SyncularV2DiagnosticEvent[] = [];
    let attempts = 0;
    const controller = new SyncularV2WorkerRealtimeController({
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

  it('runs a follow-up pull when wakeups arrive during an active pull', async () => {
    const client = new FakeRealtimeClient();
    const sockets: FakeRealtimeSocket[] = [];
    const events: SyncularV2WorkerEvent[] = [];
    const controller = new SyncularV2WorkerRealtimeController({
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

  it('reconnects after close and ignores stale socket wakeups', async () => {
    const client = new FakeRealtimeClient();
    const sockets: FakeRealtimeSocket[] = [];
    const events: SyncularV2WorkerEvent[] = [];
    const controller = new SyncularV2WorkerRealtimeController({
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
    const events: SyncularV2WorkerEvent[] = [];
    const controller = new SyncularV2WorkerRealtimeController({
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

class FakeRealtimeClient implements SyncularV2WorkerRealtimeClient {
  syncPulls = 0;
  realtimeApplies = 0;
  realtimeSyncPacks: Uint8Array[] = [];
  appliedRealtime: Array<{
    cursor: number;
    changes: unknown[];
    actorId?: string | null;
    createdAt?: string | null;
  }> = [];
  #pullResolvers: Array<() => void> = [];
  #drains: Array<Array<SyncularV2LiveQueryEvent<Record<string, unknown>>>> = [];

  syncPull(): Promise<SyncularV2SyncResult> {
    this.syncPulls += 1;
    return new Promise((resolve) => {
      this.#pullResolvers.push(() =>
        resolve({
          changedTables: [],
          changedRows: [],
          subscriptions: [],
          pushedCommits: 0,
        })
      );
    });
  }

  async applyRealtimeChanges(request: {
    cursor: number;
    changes: unknown[];
    actorId?: string | null;
    createdAt?: string | null;
  }): Promise<SyncularV2SyncResult> {
    this.realtimeApplies += 1;
    this.appliedRealtime.push(request);
    return {
      changedTables: ['tasks'],
      changedRows: [],
      subscriptions: [],
      pushedCommits: 0,
    };
  }

  async applyRealtimeSyncPack(
    bytes: Uint8Array
  ): Promise<SyncularV2SyncResult> {
    this.realtimeSyncPacks.push(bytes);
    return {
      changedTables: ['tasks'],
      changedRows: [],
      subscriptions: [
        {
          id: '__syncular_realtime__',
          table: '__syncular_realtime__',
          status: 'active',
          scopes: {},
          nextCursor: 44,
          snapshotRows: [],
          commits: [],
        },
      ],
      pushedCommits: 0,
    };
  }

  drainLiveQueryEvents<
    Row extends Record<string, unknown> = Record<string, unknown>,
  >(): Array<SyncularV2LiveQueryEvent<Row>> {
    return (this.#drains.shift() ?? []) as Array<SyncularV2LiveQueryEvent<Row>>;
  }

  queueDrain(
    events: Array<SyncularV2LiveQueryEvent<Record<string, unknown>>>
  ): void {
    this.#drains.push(events);
  }

  resolvePull(): void {
    const resolve = this.#pullResolvers.shift();
    if (!resolve) throw new Error('No pending sync pull to resolve');
    resolve();
  }
}

class FakeRealtimeSocket implements SyncularV2WorkerRealtimeSocket {
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

function liveEventVersions(events: readonly SyncularV2WorkerEvent[]): number[] {
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
