import { describe, expect, it } from 'bun:test';
import {
  createProxyHandlerCollection,
  type ServerSyncDialect,
  type SyncCoreDb,
} from '@syncular/server';
import { defineWebSocketHelper } from 'hono/ws';
import type { Kysely } from 'kysely';
import { createProxyRoutes } from '../proxy';

function createRoutes(
  options: {
    allowedOrigins?: string[] | '*';
    authenticated?: boolean;
    maxConnections?: number;
  } = {}
) {
  const upgradeWebSocket = defineWebSocketHelper(async () => {
    return new Response(null, { status: 200 });
  });

  return createProxyRoutes<SyncCoreDb>({
    db: {} as Kysely<SyncCoreDb>,
    dialect: {} as ServerSyncDialect,
    handlers: createProxyHandlerCollection([]),
    authenticate: async () =>
      options.authenticated === false ? null : { actorId: 'actor-1' },
    upgradeWebSocket,
    allowedOrigins: options.allowedOrigins ?? '*',
    maxConnections: options.maxConnections,
  });
}

describe('proxy route error envelopes', () => {
  it('returns a stable forbidden-origin envelope', async () => {
    const app = createRoutes({
      allowedOrigins: ['https://allowed.example'],
    });

    const response = await app.request('http://localhost/', {
      headers: { origin: 'https://blocked.example' },
    });

    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({
      error: 'proxy.forbidden_origin',
      code: 'proxy.forbidden_origin',
      category: 'forbidden',
      retryable: false,
      recommendedAction: 'checkPermissions',
    });
  });

  it('returns a stable auth-required envelope', async () => {
    const app = createRoutes({ authenticated: false });

    const response = await app.request('http://localhost/');

    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({
      error: 'proxy.auth_required',
      code: 'proxy.auth_required',
      category: 'auth-required',
      retryable: true,
      recommendedAction: 'refreshAuth',
    });
  });

  it('returns a stable connection-limit envelope', async () => {
    const app = createRoutes({ maxConnections: 0 });

    const response = await app.request('http://localhost/');

    expect(response.status).toBe(429);
    expect(await response.json()).toMatchObject({
      error: 'proxy.connection_limit',
      code: 'proxy.connection_limit',
      category: 'rate-limited',
      retryable: true,
      recommendedAction: 'retryLater',
    });
  });
});
