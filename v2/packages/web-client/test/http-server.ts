/**
 * Serve a loopback `TestServer` over real HTTP + WebSocket for the worker
 * RPC tests: the worker constructs its own fetch/WS transports from
 * endpoint URLs (the production default path), so it needs a real port.
 * Routes mirror the demo server: POST /sync, GET /segments/:id,
 * WS /realtime.
 */
import {
  handleSegmentDownload,
  handleSyncRequest,
  type RealtimeSession,
  SyncError,
} from '@syncular-v2/server';
import { SSP2_CONTENT_TYPE } from '@syncular-v2/web-client';
import { PARTITION, type TestServer } from './helpers';

export interface HttpTestServer {
  readonly syncUrl: string;
  readonly segmentsUrl: string;
  readonly realtimeUrl: string;
  stop(): Promise<void>;
}

interface SocketData {
  clientId: string;
  session?: RealtimeSession;
}

function errorResponse(error: unknown): Response {
  if (error instanceof SyncError) {
    return Response.json(
      {
        code: error.code,
        message: error.message,
        retryable: error.retryable,
      },
      { status: error.httpStatus },
    );
  }
  return Response.json(
    { code: 'sync.invalid_request', message: String(error), retryable: false },
    { status: 500 },
  );
}

export function serveOverHttp(
  server: TestServer,
  actorId = 'actor-1',
): HttpTestServer {
  const bunServer = Bun.serve<SocketData>({
    port: 0,
    async fetch(request, s) {
      const url = new URL(request.url);
      if (url.pathname === '/sync' && request.method === 'POST') {
        try {
          const bytes = new Uint8Array(await request.arrayBuffer());
          const response = await handleSyncRequest(
            bytes,
            server.ctxFor(actorId),
          );
          return new Response(response as unknown as BodyInit, {
            headers: { 'Content-Type': SSP2_CONTENT_TYPE },
          });
        } catch (error) {
          return errorResponse(error);
        }
      }
      if (url.pathname.startsWith('/segments/')) {
        try {
          const segmentId = decodeURIComponent(
            url.pathname.slice('/segments/'.length),
          );
          const result = await handleSegmentDownload(server.ctxFor(actorId), {
            segmentId,
            scopesHeader: request.headers.get('X-Syncular-Scopes') ?? '',
          });
          return new Response(result.bytes as unknown as BodyInit);
        } catch (error) {
          return errorResponse(error);
        }
      }
      if (url.pathname === '/realtime') {
        const clientId =
          url.searchParams.get('clientId') ?? crypto.randomUUID();
        if (s.upgrade(request, { data: { clientId } })) {
          return undefined as unknown as Response;
        }
        return new Response('expected a websocket upgrade', { status: 426 });
      }
      return new Response('not found', { status: 404 });
    },
    websocket: {
      open(ws) {
        server.hub
          .connect({
            partition: PARTITION,
            actorId,
            clientId: ws.data.clientId,
            send: (data) => {
              ws.send(data);
            },
          })
          .then((session) => {
            ws.data.session = session;
          })
          .catch(() => ws.close(1011, 'realtime connect failed'));
      },
      message(ws, message) {
        if (typeof message === 'string') {
          ws.data.session?.handleMessage(message);
        }
      },
      close(ws) {
        ws.data.session?.close();
      },
    },
  });
  const base = `http://localhost:${bunServer.port}`;
  return {
    syncUrl: `${base}/sync`,
    segmentsUrl: `${base}/segments`,
    realtimeUrl: `ws://localhost:${bunServer.port}/realtime?clientId={clientId}`,
    stop: async () => {
      await bunServer.stop(true);
    },
  };
}
