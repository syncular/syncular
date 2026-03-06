import { afterEach, describe, expect, it } from 'bun:test';
import { Hono } from 'hono';
import { closeNodeServer, createNodeHonoServer } from './hono-node-server';

const servers: Array<ReturnType<typeof createNodeHonoServer>> = [];

afterEach(async () => {
  while (servers.length > 0) {
    const server = servers.pop();
    if (!server) continue;
    await closeNodeServer(server);
  }
});

describe('createNodeHonoServer', () => {
  it('allows snapshot scope headers in CORS preflight responses', async () => {
    const app = new Hono();
    app.get('/sync/snapshot-chunks/:chunkId', (c) =>
      c.body(new Uint8Array([1, 2, 3]))
    );

    const server = createNodeHonoServer(app);
    servers.push(server);

    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', resolve);
    });

    const address = server.address();
    if (typeof address !== 'object' || !address) {
      throw new Error('Failed to resolve test server address');
    }

    const response = await fetch(
      `http://127.0.0.1:${address.port}/sync/snapshot-chunks/chunk-1`,
      {
        method: 'OPTIONS',
        headers: {
          origin: 'http://127.0.0.1:4173',
          'access-control-request-method': 'GET',
          'access-control-request-headers':
            'x-actor-id, x-syncular-snapshot-scopes',
        },
      }
    );

    expect(response.status).toBe(204);
    expect(response.headers.get('access-control-allow-origin')).toBe('*');
    expect(response.headers.get('access-control-allow-headers')).toContain(
      'x-syncular-snapshot-scopes'
    );
  });
});
