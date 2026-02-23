import { describe, expect, it } from 'bun:test';
import { Hono } from 'hono';
import { defineWebSocketHelper, WSContext, type WSEvents } from 'hono/ws';
import { createConsoleGatewayRoutes } from '../console';

const CONSOLE_TOKEN = 'gateway-token';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

class MockDownstreamSocket {
  url: string;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  closeCalls = 0;

  constructor(url: string) {
    this.url = url;
  }

  emitJson(payload: Record<string, unknown>) {
    this.onmessage?.(
      new MessageEvent('message', { data: JSON.stringify(payload) })
    );
  }

  emitError() {
    this.onerror?.(new Event('error'));
  }

  close() {
    this.closeCalls += 1;
  }
}

function createGatewayLiveHarness() {
  const downstreamSockets: MockDownstreamSocket[] = [];
  let capturedEvents: WSEvents | null = null;

  const app = new Hono();
  const upgradeWebSocket = defineWebSocketHelper(async (_c, events) => {
    capturedEvents = events;
    return new Response(null, { status: 200 });
  });

  app.route(
    '/console',
    createConsoleGatewayRoutes({
      instances: [
        {
          instanceId: 'alpha',
          label: 'Alpha',
          baseUrl: 'https://alpha.example.test/api/alpha',
        },
        {
          instanceId: 'beta',
          label: 'Beta',
          baseUrl: 'https://beta.example.test/api/beta',
        },
      ],
      authenticate: async (c) => {
        const authHeader = c.req.header('Authorization');
        if (authHeader === `Bearer ${CONSOLE_TOKEN}`) {
          return { consoleUserId: 'gateway-user' };
        }
        return null;
      },
      websocket: {
        enabled: true,
        upgradeWebSocket,
        heartbeatIntervalMs: 60000,
        createWebSocket: (url) => {
          const socket = new MockDownstreamSocket(url);
          downstreamSockets.push(socket);
          return socket;
        },
      },
    })
  );

  return {
    app,
    downstreamSockets,
    getEvents: () => capturedEvents,
  };
}

function createUpstreamSocketHarness() {
  const messages: Array<Record<string, unknown>> = [];
  const closes: Array<{ code?: number; reason?: string }> = [];

  const ws = new WSContext({
    readyState: 1,
    send(data) {
      if (typeof data !== 'string') {
        return;
      }

      const parsed = JSON.parse(data);
      if (isRecord(parsed)) {
        messages.push(parsed);
      }
    },
    close(code, reason) {
      closes.push({ code, reason });
    },
  });

  return {
    ws,
    messages,
    closes,
  };
}

describe('createConsoleGatewayRoutes live fan-in', () => {
  it('fans in downstream websocket events and emits instance degradation markers', async () => {
    const { app, downstreamSockets, getEvents } = createGatewayLiveHarness();

    const response = await app.request(
      'http://localhost/console/events/live?instanceIds=alpha,beta&partitionId=tenant-a&replayLimit=42',
      {
        headers: { Authorization: `Bearer ${CONSOLE_TOKEN}` },
      }
    );
    expect(response.status).toBe(200);

    const events = getEvents();
    if (!events?.onOpen || !events.onError) {
      throw new Error('Expected websocket lifecycle handlers to be captured.');
    }

    const upstream = createUpstreamSocketHarness();
    events.onOpen(new Event('open'), upstream.ws);

    expect(downstreamSockets).toHaveLength(2);

    const alphaSocket = downstreamSockets.find((socket) =>
      socket.url.includes('alpha.example.test')
    );
    const betaSocket = downstreamSockets.find((socket) =>
      socket.url.includes('beta.example.test')
    );

    if (!alphaSocket || !betaSocket) {
      throw new Error(
        'Expected both alpha and beta downstream websocket links.'
      );
    }

    const alphaUrl = new URL(alphaSocket.url);
    expect(alphaUrl.pathname).toBe('/api/alpha/console/events/live');
    expect(alphaUrl.searchParams.get('token')).toBe(CONSOLE_TOKEN);
    expect(alphaUrl.searchParams.get('partitionId')).toBe('tenant-a');
    expect(alphaUrl.searchParams.get('replayLimit')).toBe('42');

    const connectedEvent = upstream.messages.find(
      (message) => message.type === 'connected'
    );
    expect(connectedEvent?.instanceCount).toBe(2);

    alphaSocket.emitJson({
      type: 'push',
      timestamp: '2026-02-17T11:00:00.000Z',
      data: {
        partitionId: 'tenant-a',
        requestId: 'alpha-req-1',
      },
    });

    const pushEvent = upstream.messages.find(
      (message) => message.type === 'push'
    );
    expect(pushEvent?.instanceId).toBe('alpha');
    if (!isRecord(pushEvent?.data)) {
      throw new Error('Expected push event to include object data payload.');
    }
    expect(pushEvent.data.instanceId).toBe('alpha');
    expect(pushEvent.data.partitionId).toBe('tenant-a');

    betaSocket.emitError();
    const degradedEvent = upstream.messages.find(
      (message) => message.type === 'instance_error'
    );
    expect(degradedEvent?.instanceId).toBe('beta');

    events.onError(new Event('error'), upstream.ws);
    expect(downstreamSockets.every((socket) => socket.closeCalls === 1)).toBe(
      true
    );
  });

  it('closes the upstream socket when auth is missing', async () => {
    const { app, downstreamSockets, getEvents } = createGatewayLiveHarness();

    const response = await app.request('http://localhost/console/events/live');
    expect(response.status).toBe(200);

    const events = getEvents();
    if (!events?.onOpen) {
      throw new Error('Expected websocket onOpen handler to be captured.');
    }

    const upstream = createUpstreamSocketHarness();
    events.onOpen(new Event('open'), upstream.ws);

    const errorEvent = upstream.messages[0];
    expect(errorEvent?.type).toBe('error');
    expect(errorEvent?.message).toBe('UNAUTHENTICATED');
    expect(upstream.closes).toEqual([
      { code: 4001, reason: 'Unauthenticated' },
    ]);
    expect(downstreamSockets).toHaveLength(0);
  });

  it('closes the upstream socket when no instances match the filter', async () => {
    const { app, downstreamSockets, getEvents } = createGatewayLiveHarness();

    const response = await app.request(
      'http://localhost/console/events/live?instanceId=missing',
      {
        headers: { Authorization: `Bearer ${CONSOLE_TOKEN}` },
      }
    );
    expect(response.status).toBe(200);

    const events = getEvents();
    if (!events?.onOpen) {
      throw new Error('Expected websocket onOpen handler to be captured.');
    }

    const upstream = createUpstreamSocketHarness();
    events.onOpen(new Event('open'), upstream.ws);

    const errorEvent = upstream.messages[0];
    expect(errorEvent?.type).toBe('error');
    expect(errorEvent?.message).toBe(
      'No enabled instances matched the provided instance filter.'
    );
    expect(upstream.closes).toEqual([
      { code: 4004, reason: 'No instances selected' },
    ]);
    expect(downstreamSockets).toHaveLength(0);
  });
});
