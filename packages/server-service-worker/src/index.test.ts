import { afterEach, describe, expect, mock, test } from 'bun:test';
import {
  configureServiceWorkerServer,
  createServiceWorkerServer,
  createSyncWakeMessageResolver,
  isServiceWorkerWakeMessage,
  SERVICE_WORKER_WAKE_MESSAGE_TYPE,
  unregisterServiceWorkerRegistrations,
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
          commits: [
            {
              clientCommitId: 'commit-1',
              operations: [{ table: 'tasks', op: 'upsert' }],
              schemaVersion: 1,
            },
          ],
        },
      }),
    });

    const response = new Response(
      JSON.stringify({
        push: {
          ok: true,
          commits: [
            {
              clientCommitId: 'commit-1',
              status: 'applied',
              commitSeq: 42,
              results: [],
            },
          ],
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

  test('supports legacy single-commit push payloads for wake messages', async () => {
    const resolver = createSyncWakeMessageResolver();
    const request = new Request('https://demo.local/api/sync', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        clientId: 'client-a',
        push: {
          clientCommitId: 'commit-legacy',
          operations: [{ table: 'tasks', op: 'upsert' }],
          schemaVersion: 1,
        },
      }),
    });

    const response = new Response(
      JSON.stringify({
        push: {
          status: 'applied',
          commitSeq: 43,
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

    expect(wakeMessage?.cursor).toBe(43);
    expect(wakeMessage?.sourceClientId).toBe('client-a');
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
          commits: [
            {
              clientCommitId: 'commit-1',
              operations: [{ table: 'tasks', op: 'upsert' }],
              schemaVersion: 1,
            },
          ],
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

describe('service worker registration helpers', () => {
  const originalWindow = globalThis.window;
  const originalNavigator = globalThis.navigator;

  afterEach(() => {
    if (originalWindow) {
      Object.defineProperty(globalThis, 'window', {
        configurable: true,
        value: originalWindow,
      });
    } else {
      // @ts-expect-error test cleanup
      delete globalThis.window;
    }

    if (originalNavigator) {
      Object.defineProperty(globalThis, 'navigator', {
        configurable: true,
        value: originalNavigator,
      });
    } else {
      // @ts-expect-error test cleanup
      delete globalThis.navigator;
    }
  });

  test('unregisters versioned service worker registrations by pathname', async () => {
    const unregister = mock(async () => true);
    const registrations = [
      {
        active: {
          scriptURL: 'https://demo.local/__demo/sw-server.js?v=old-release',
        },
        unregister,
      },
      {
        active: {
          scriptURL: 'https://demo.local/__demo/other-worker.js?v=old-release',
        },
        unregister: mock(async () => true),
      },
    ];

    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: { location: { origin: 'https://demo.local' } },
    });
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      value: {
        serviceWorker: {
          getRegistrations: async () => registrations,
        },
      },
    });

    await unregisterServiceWorkerRegistrations(
      '/__demo/sw-server.js?v=current-release'
    );

    expect(unregister).toHaveBeenCalledTimes(1);
  });

  test('waits for controller takeover when a pending update exists', async () => {
    const listeners = new Map<string, Set<() => void>>();
    const previousController = {
      scriptURL: 'https://demo.local/__demo/sw-server.js?v=old',
    };
    const nextController = {
      scriptURL: 'https://demo.local/__demo/sw-server.js?v=new',
    };
    let controller: typeof previousController | null = previousController;
    const registration = {
      installing: { scriptURL: nextController.scriptURL },
      waiting: null,
      update: async () => undefined,
    };

    const serviceWorker = {
      controller,
      ready: Promise.resolve(registration),
      register: async () => registration,
      addEventListener: (type: string, listener: () => void) => {
        const set = listeners.get(type) ?? new Set();
        set.add(listener);
        listeners.set(type, set);
      },
      removeEventListener: (type: string, listener: () => void) => {
        listeners.get(type)?.delete(listener);
      },
    };

    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: { location: { origin: 'https://demo.local' } },
    });
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      value: {
        serviceWorker,
      },
    });

    const fetchCalls: string[] = [];
    const configurePromise = configureServiceWorkerServer({
      scriptPath: '/__demo/sw-server.js',
      scriptVersion: 'next-release',
      fetchImpl: async (input) => {
        fetchCalls.push(String(input));
        return new Response(null, {
          status: 200,
          headers: { 'x-syncular-sw-server': '1' },
        });
      },
      healthCheck: (response) =>
        response.headers.get('x-syncular-sw-server') === '1',
      logger: {},
    });

    await Promise.resolve();
    controller = nextController;
    serviceWorker.controller = nextController;
    registration.installing = null;
    listeners.get('controllerchange')?.forEach((listener) => {
      listener();
    });

    await expect(configurePromise).resolves.toBe(true);
    expect(fetchCalls).toContain('/api/health');
  });
});
