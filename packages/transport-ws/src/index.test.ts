import { describe, expect, test } from 'bun:test';
import { createWebSocketTransport } from './index';

class MockWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  static instances: MockWebSocket[] = [];

  readonly url: string;
  readonly sent: string[] = [];
  readyState = MockWebSocket.CONNECTING;
  onopen: ((ev: Event) => unknown) | null = null;
  onmessage: ((ev: MessageEvent<string>) => unknown) | null = null;
  onerror: ((ev: Event) => unknown) | null = null;
  onclose: ((ev: Event) => unknown) | null = null;

  constructor(url: string | URL, _protocols?: string | string[]) {
    this.url = String(url);
    MockWebSocket.instances.push(this);
  }

  send(data: string): void {
    if (this.readyState !== MockWebSocket.OPEN) {
      throw new Error('Socket is not open');
    }
    this.sent.push(data);
  }

  close(): void {
    this.readyState = MockWebSocket.CLOSED;
  }

  async triggerOpen(): Promise<void> {
    this.readyState = MockWebSocket.OPEN;
    const handler = this.onopen;
    if (!handler) return;
    await handler(new Event('open'));
  }

  triggerClose(): void {
    this.readyState = MockWebSocket.CLOSED;
    const handler = this.onclose;
    if (!handler) return;
    handler(new Event('close'));
  }
}

function clearMockSockets(): void {
  MockWebSocket.instances.length = 0;
}

async function waitForSocket(): Promise<MockWebSocket> {
  for (let i = 0; i < 10; i++) {
    const socket = MockWebSocket.instances[0];
    if (socket) return socket;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error('Expected a websocket instance to be created');
}

function createDeferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe('createWebSocketTransport auth flow', () => {
  test('derives default wsUrl from baseUrl as /sync/realtime', async () => {
    clearMockSockets();
    const transport = createWebSocketTransport({
      baseUrl: 'http://localhost:3000/api',
      WebSocketImpl: MockWebSocket as typeof WebSocket,
      reconnectJitter: 0,
    });

    const disconnect = transport.connect(
      { clientId: 'client-default-url' },
      () => {}
    );
    const socket = await waitForSocket();

    const url = new URL(socket.url);
    expect(url.protocol).toBe('ws:');
    expect(url.pathname).toBe('/api/sync/realtime');
    expect(url.searchParams.get('clientId')).toBe('client-default-url');
    expect(url.searchParams.get('transportPath')).toBe('relay');

    disconnect();
  });

  test('sends first-message auth token after open', async () => {
    clearMockSockets();
    const transport = createWebSocketTransport({
      baseUrl: 'http://localhost:3000/api',
      WebSocketImpl: MockWebSocket as typeof WebSocket,
      authToken: 'token-1',
      reconnectJitter: 0,
    });

    const disconnect = transport.connect({ clientId: 'client-1' }, () => {});
    const socket = await waitForSocket();

    await socket.triggerOpen();

    expect(transport.getConnectionState()).toBe('connected');
    expect(socket.sent).toContain(
      JSON.stringify({ type: 'auth', token: 'token-1' })
    );

    disconnect();
  });

  test('does not become connected when socket closes while waiting for auth token', async () => {
    clearMockSockets();
    const token = createDeferred<string>();
    const transport = createWebSocketTransport({
      baseUrl: 'http://localhost:3000/api',
      WebSocketImpl: MockWebSocket as typeof WebSocket,
      authToken: () => token.promise,
      reconnectJitter: 0,
      initialReconnectDelay: 1_000_000,
      maxReconnectDelay: 1_000_000,
    });

    const disconnect = transport.connect({ clientId: 'client-2' }, () => {});
    const socket = await waitForSocket();

    const openPromise = socket.triggerOpen();
    expect(transport.getConnectionState()).toBe('connecting');

    socket.triggerClose();
    expect(transport.getConnectionState()).toBe('disconnected');

    token.resolve('token-2');
    await openPromise;

    expect(transport.getConnectionState()).toBe('disconnected');
    expect(socket.sent).toEqual([]);

    disconnect();
  });

  test('times out ws push quickly when configured', async () => {
    clearMockSockets();
    const transport = createWebSocketTransport({
      baseUrl: 'http://localhost:3000/api',
      WebSocketImpl: MockWebSocket as typeof WebSocket,
      reconnectJitter: 0,
      wsPushTimeoutMs: 20,
    });

    const disconnect = transport.connect({ clientId: 'client-3' }, () => {});
    const socket = await waitForSocket();
    await socket.triggerOpen();

    const startedAt = Date.now();
    const response = await transport.pushViaWs({
      clientId: 'client-3',
      clientCommitId: 'commit-1',
      operations: [],
      schemaVersion: 1,
    });
    const elapsedMs = Date.now() - startedAt;

    expect(response).toBeNull();
    expect(elapsedMs).toBeGreaterThanOrEqual(15);
    expect(elapsedMs).toBeLessThan(500);

    const pushMessage = socket.sent.find((msg) =>
      msg.includes('"type":"push"')
    );
    expect(pushMessage).toBeDefined();

    disconnect();
  });
});
