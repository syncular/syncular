/**
 * Hono adapter (REVISE B2): a thin wrapper proving the embed boundary.
 * Hono is a dependency of this adapter only, never of the server core.
 * Mounts the §1.1 routes: POST /sync and GET /segments/:segmentId
 * (realtime upgrades are runtime-specific and stay with the host).
 */
import {
  encodeSegmentBody,
  errorBody,
  handleBlobDownload,
  handleBlobUpload,
  handleSegmentDownload,
  handleSyncRequest,
  SSP2_CONTENT_TYPE,
  SyncError,
  type SyncServerConfig,
} from '@syncular-v2/server';
import { Hono } from 'hono';

export interface SyncularHonoOptions {
  readonly config: SyncServerConfig;
  /** Host authentication (§1.1); `null` ⇒ 401 `sync.auth_required`. */
  readonly authenticate: (
    request: Request,
  ) => Promise<{ actorId: string; partition: string } | null>;
}

function errorResponse(error: unknown): Response {
  const sync =
    error instanceof SyncError
      ? error
      : new SyncError('sync.invalid_request', String(error));
  return Response.json(errorBody(sync), { status: sync.httpStatus });
}

export function createSyncularHono(options: SyncularHonoOptions): Hono {
  const app = new Hono();

  app.post('/sync', async (c) => {
    const contentType = c.req.header('content-type')?.split(';')[0]?.trim();
    if (contentType !== SSP2_CONTENT_TYPE) {
      // §1.1: any other content type is rejected with HTTP 415.
      return Response.json(
        errorBody(
          new SyncError('sync.invalid_request', 'unsupported content type'),
        ),
        { status: 415 },
      );
    }
    const auth = await options.authenticate(c.req.raw);
    if (auth === null)
      return errorResponse(new SyncError('sync.auth_required'));
    try {
      const bytes = new Uint8Array(await c.req.arrayBuffer());
      const out = await handleSyncRequest(bytes, {
        ...options.config,
        ...auth,
      });
      return c.body(out.slice().buffer as ArrayBuffer, 200, {
        'Content-Type': SSP2_CONTENT_TYPE,
      });
    } catch (error) {
      return errorResponse(error);
    }
  });

  app.get('/segments/:segmentId', async (c) => {
    const auth = await options.authenticate(c.req.raw);
    if (auth === null)
      return errorResponse(new SyncError('sync.auth_required'));
    try {
      const result = await handleSegmentDownload(
        { ...options.config, ...auth },
        {
          segmentId: c.req.param('segmentId'),
          scopesHeader: c.req.header('x-syncular-scopes') ?? '{}',
        },
      );
      if (c.req.header('if-none-match') === result.headers.ETag) {
        return c.body(null, 304, result.headers);
      }
      // §5.8 shipped default: compress the body per Accept-Encoding
      // (zstd preferred, gzip fallback, identity otherwise). Content
      // addresses are over the uncompressed bytes (§5.1) — fetch
      // decodes transparently on the client.
      const encoded = encodeSegmentBody(
        result.bytes,
        c.req.header('accept-encoding'),
      );
      return c.body(encoded.bytes.slice().buffer as ArrayBuffer, 200, {
        ...result.headers,
        ...(encoded.contentEncoding !== undefined
          ? { 'Content-Encoding': encoded.contentEncoding }
          : {}),
      });
    } catch (error) {
      return errorResponse(error);
    }
  });

  // §5.9.3: blob upload with server-side content-address verification.
  app.put('/blobs/:blobId', async (c) => {
    const auth = await options.authenticate(c.req.raw);
    if (auth === null)
      return errorResponse(new SyncError('sync.auth_required'));
    try {
      const bytes = new Uint8Array(await c.req.arrayBuffer());
      const contentType = c.req.header('content-type')?.split(';')[0]?.trim();
      await handleBlobUpload(
        { ...options.config, ...auth },
        {
          blobId: c.req.param('blobId'),
          bytes,
          ...(contentType !== undefined &&
          contentType !== 'application/octet-stream'
            ? { mediaType: contentType }
            : {}),
        },
      );
      return c.body(null, 200);
    } catch (error) {
      return errorResponse(error);
    }
  });

  // §5.9.5: blob download, re-authorized against referencing rows.
  app.get('/blobs/:blobId', async (c) => {
    const auth = await options.authenticate(c.req.raw);
    if (auth === null)
      return errorResponse(new SyncError('sync.auth_required'));
    try {
      const result = await handleBlobDownload(
        { ...options.config, ...auth },
        c.req.param('blobId'),
      );
      if (c.req.header('if-none-match') === result.headers.ETag) {
        return c.body(null, 304, result.headers);
      }
      return c.body(result.bytes.slice().buffer as ArrayBuffer, 200, {
        ...result.headers,
      });
    } catch (error) {
      return errorResponse(error);
    }
  });

  return app;
}
