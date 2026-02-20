import { describe, expect, test } from 'bun:test';
import {
  createServiceWorkerServer,
  createSyncWakeMessageResolver,
  isServiceWorkerWakeMessage,
  SERVICE_WORKER_WAKE_MESSAGE_TYPE,
} from './index';

describe('isServiceWorkerWakeMessage', () => {
  test('accepts valid wake message', () => {
    expect(
      isServiceWorkerWakeMessage({
        type: SERVICE_WORKER_WAKE_MESSAGE_TYPE,
        timestamp: Date.now(),
        cursor: 10,
        sourceClientId: 'client-a',
      })
    ).toBe(true);
  });

  test('rejects invalid wake message', () => {
    expect(isServiceWorkerWakeMessage(null)).toBe(false);
    expect(
      isServiceWorkerWakeMessage({
        type: SERVICE_WORKER_WAKE_MESSAGE_TYPE,
        timestamp: 'x',
      })
    ).toBe(false);
    expect(
      isServiceWorkerWakeMessage({
        type: 'other',
        timestamp: Date.now(),
      })
    ).toBe(false);
  });
});

describe('createSyncWakeMessageResolver', () => {
  test('captures push context and emits wake message for applied sync push', async () => {
    const resolver = createSyncWakeMessageResolver();
    const request = new Request('https://demo.local/api/sync', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        clientId: 'client-a',
        push: {
          operations: [{ table: 'tasks', op: 'upsert' }],
        },
      }),
    });

    const response = new Response(
      JSON.stringify({
        push: {
          status: 'applied',
          commitSeq: 42,
        },
      }),
      {
        status: 200,
        headers: {
          'content-type': 'application/json',
        },
      }
    );

    const wakeContext = await resolver.captureContext(request);
    const wakeMessage = await resolver.resolveMessage({
      request,
      response,
      wakeContext,
    });

    expect(wakeMessage?.type).toBe(SERVICE_WORKER_WAKE_MESSAGE_TYPE);
    expect(wakeMessage?.cursor).toBe(42);
    expect(wakeMessage?.sourceClientId).toBe('client-a');
    expect(typeof wakeMessage?.timestamp).toBe('number');
  });
});

describe('createServiceWorkerServer', () => {
  test('checks request scope using local origin + api prefix', async () => {
    const server = createServiceWorkerServer({
      apiPrefix: '/api',
      handleRequest: async () => new Response('ok'),
    });

    const localRequest = new Request('https://demo.local/api/health');
    const remoteRequest = new Request('https://other.local/api/health');
    const wrongPrefixRequest = new Request('https://demo.local/not-api');

    expect(server.shouldHandleRequest(localRequest, 'https://demo.local')).toBe(
      true
    );
    expect(
      server.shouldHandleRequest(remoteRequest, 'https://demo.local')
    ).toBe(false);
    expect(
      server.shouldHandleRequest(wrongPrefixRequest, 'https://demo.local')
    ).toBe(false);
  });

  test('supports wake resolution when handleRequest consumes request body', async () => {
    const server = createServiceWorkerServer({
      handleRequest: async (request) => {
        await request.json();
        return new Response(
          JSON.stringify({
            push: {
              status: 'applied',
              commitSeq: 7,
            },
          }),
          {
            status: 200,
            headers: {
              'content-type': 'application/json',
            },
          }
        );
      },
    });

    const request = new Request('https://demo.local/api/sync', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        clientId: 'client-x',
        push: {
          operations: [{ table: 'tasks', op: 'upsert' }],
        },
      }),
    });

    const wakeContext = await server.captureWakeContext(request);
    const response = await server.handleRequest(request);
    const wakeMessage = await server.resolveWakeMessage({
      request,
      response,
      wakeContext,
    });

    expect(wakeMessage?.cursor).toBe(7);
    expect(wakeMessage?.sourceClientId).toBe('client-x');
  });
});
