import { createServer, type Server as NodeServer } from 'node:http';
import type { Hono } from 'hono';
import {
  type AsyncDisposableResource,
  createAsyncDisposableResource,
  type ResourceRunner,
  withAsyncDisposableFactory,
} from './disposable';

export interface NodeHonoServerOptions {
  cors?: boolean;
  corsAllowMethods?: string;
  corsAllowHeaders?: string;
  corsMaxAgeSeconds?: number;
}

export interface CreateNodeHonoServerResourceOptions
  extends NodeHonoServerOptions {
  listen?: boolean;
  host?: string;
  port?: number;
}

export function createNodeHonoServer(
  app: Hono,
  options?: NodeHonoServerOptions
): NodeServer {
  const corsEnabled = options?.cors ?? true;
  const corsAllowMethods =
    options?.corsAllowMethods ?? 'GET, POST, PUT, DELETE, OPTIONS';
  const corsAllowHeaders =
    options?.corsAllowHeaders ??
    'content-type, x-actor-id, x-syncular-transport-path, x-user-id';
  const corsMaxAgeSeconds = options?.corsMaxAgeSeconds ?? 86400;

  return createServer(async (req, res) => {
    const url = `http://localhost${req.url ?? '/'}`;

    const headers = new Headers();
    for (const [key, value] of Object.entries(req.headers)) {
      if (!value) {
        continue;
      }

      headers.set(key, Array.isArray(value) ? value.join(', ') : value);
    }

    if (corsEnabled && req.method === 'OPTIONS') {
      res.writeHead(204, {
        'access-control-allow-origin': '*',
        'access-control-allow-methods': corsAllowMethods,
        'access-control-allow-headers': corsAllowHeaders,
        'access-control-max-age': String(corsMaxAgeSeconds),
      });
      res.end();
      return;
    }

    const hasBody = req.method !== 'GET' && req.method !== 'HEAD';
    const body = hasBody
      ? await new Promise<Uint8Array>((resolve) => {
          const chunks: Uint8Array[] = [];
          req.on('data', (chunk: Uint8Array) => chunks.push(chunk));
          req.on('end', () => {
            const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
            const merged = new Uint8Array(total);
            let offset = 0;
            for (const chunk of chunks) {
              merged.set(chunk, offset);
              offset += chunk.length;
            }
            resolve(merged);
          });
        })
      : undefined;

    const requestBody = body ? Uint8Array.from(body) : undefined;

    const request = new Request(url, {
      method: req.method,
      headers,
      body: requestBody,
    });

    const response = await app.fetch(request);
    const responseHeaders: Record<string, string> = {};
    response.headers.forEach((value, key) => {
      responseHeaders[key] = value;
    });

    if (corsEnabled) {
      responseHeaders['access-control-allow-origin'] = '*';
    }

    res.writeHead(response.status, responseHeaders);
    const bytes = Buffer.from(await response.arrayBuffer());
    res.end(bytes);
  });
}

export async function closeNodeServer(server: NodeServer): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }

      resolve();
    });
  });
}

export function createNodeServerResource(
  server: NodeServer
): AsyncDisposableResource<NodeServer> {
  return createAsyncDisposableResource(server, () => closeNodeServer(server));
}

export async function createNodeHonoServerResource(
  app: Hono,
  options: CreateNodeHonoServerResourceOptions = {}
): Promise<AsyncDisposableResource<NodeServer>> {
  const server = createNodeHonoServer(app, options);

  if (options.listen ?? true) {
    await new Promise<void>((resolve) => {
      server.listen(options.port ?? 0, options.host ?? '127.0.0.1', resolve);
    });
  }

  return createNodeServerResource(server);
}

export async function withNodeHonoServer<TResult>(
  app: Hono,
  run: ResourceRunner<NodeServer, TResult>,
  options: CreateNodeHonoServerResourceOptions = {}
): Promise<TResult> {
  return withAsyncDisposableFactory(
    () => createNodeHonoServerResource(app, options),
    run
  );
}
