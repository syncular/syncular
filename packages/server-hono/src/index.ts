/**
 * Hono adapter: a thin wrapper proving the embed boundary.
 * Hono is a dependency of this adapter only, never of the server core.
 * Mounts the §1.1 routes including sync, registered operations, segments, and
 * blobs. Realtime upgrades are runtime-specific and stay with the host.
 */
import {
  adapterSyncError,
  encodeSegmentBody,
  encodeSegmentStream,
  errorBody,
  handleBlobDownload,
  handleBlobUpload,
  handleBlobUploadGrant,
  openSegmentDownload,
  handleRemoteOperation,
  type RemoteOperationRegistry,
  handleSyncRequest,
  SEGMENT_STREAM_THRESHOLD_BYTES,
  SSP2_CONTENT_TYPE,
  SyncError,
  type SyncularErrorRoute,
  type SyncServerConfig,
} from '@syncular/server';
import { Hono, type Context } from 'hono';

export * from './admin';

export interface SyncularHonoOptions {
  readonly config: SyncServerConfig;
  readonly operations?: RemoteOperationRegistry;
  /** Host authentication (§1.1); `null` ⇒ 401 `sync.auth_required`. */
  readonly authenticate: (
    request: Request,
  ) => Promise<{ actorId: string; partition: string } | null>;
}

export function createSyncularHono(options: SyncularHonoOptions): Hono {
  const app = new Hono();
  // A `SyncError` answers with its catalog status. Any other exception goes
  // to `config.onError` and answers 500 `sync.internal_error` (§10.2).
  const errorResponse = (
    c: Context,
    error: unknown,
    route: SyncularErrorRoute = 'sync',
  ): Response => {
    const sync = adapterSyncError(
      error,
      (error, context) => options.config.onError?.(error, context),
      route,
      (error, context) => options.config.mapError?.(error, context),
    );
    const response = Response.json(errorBody(sync), {
      status: sync.httpStatus,
    });
    return c.newResponse(response.body, response);
  };
  // Throws outside a route's own try, such as from `authenticate`.
  app.onError((error, c) => {
    const segment = c.req.path.split('/')[1];
    return errorResponse(
      c,
      error,
      segment === 'operations' || segment === 'segments' || segment === 'blobs'
        ? segment
        : 'sync',
    );
  });

  app.post('/sync', async (c) => {
    const contentType = c.req.header('content-type')?.split(';')[0]?.trim();
    if (contentType !== SSP2_CONTENT_TYPE) {
      // §1.1: any other content type is rejected with HTTP 415.
      return c.json(
        errorBody(
          new SyncError('sync.invalid_request', 'unsupported content type'),
        ),
        415,
      );
    }
    const auth = await options.authenticate(c.req.raw);
    if (auth === null)
      return errorResponse(c, new SyncError('sync.auth_required'));
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
      return errorResponse(c, error);
    }
  });

  app.post('/operations', async (c) => {
    const contentType = c.req.header('content-type')?.split(';')[0]?.trim();
    if (contentType !== 'application/vnd.syncular.operations.v1+json') {
      return c.json(errorBody(new SyncError('operation.invalid_request')), 415);
    }
    if (options.operations === undefined) {
      return errorResponse(c, new SyncError('operation.unknown'));
    }
    const auth = await options.authenticate(c.req.raw);
    if (auth === null)
      return errorResponse(c, new SyncError('sync.auth_required'));
    try {
      const bytes = new Uint8Array(await c.req.arrayBuffer());
      const out = await handleRemoteOperation(
        bytes,
        { ...options.config, ...auth },
        options.operations,
      );
      return c.body(out.slice().buffer as ArrayBuffer, 200, {
        'Content-Type': 'application/vnd.syncular.operations.v1+json',
      });
    } catch (error) {
      return errorResponse(c, error, 'operations');
    }
  });

  app.get('/segments/:segmentId', async (c) => {
    const auth = await options.authenticate(c.req.raw);
    if (auth === null)
      return errorResponse(c, new SyncError('sync.auth_required'));
    try {
      const result = await openSegmentDownload(
        { ...options.config, ...auth },
        {
          segmentId: c.req.param('segmentId'),
          scopesHeader: c.req.header('x-syncular-scopes') ?? '{}',
        },
      );
      if (c.req.header('if-none-match') === result.headers.ETag) {
        await result.body.cancel();
        return c.body(null, 304, result.headers);
      }
      const acceptEncoding = c.req.header('accept-encoding');
      if (result.byteLength > SEGMENT_STREAM_THRESHOLD_BYTES) {
        // A large segment (a sqlite image) is relayed without buffering;
        // only a streaming codec applies (§5.8).
        const encoded = encodeSegmentStream(result.body, acceptEncoding);
        return new Response(encoded.body, {
          status: 200,
          headers: c.newResponse(null, 200, {
            ...result.headers,
            ...(encoded.contentEncoding !== undefined
              ? { 'Content-Encoding': encoded.contentEncoding }
              : { 'Content-Length': String(result.byteLength) }),
          }).headers,
          ...ALREADY_ENCODED,
        });
      }
      // §5.8 shipped default: compress the body per Accept-Encoding
      // (zstd preferred, gzip fallback, identity otherwise). Content
      // addresses are over the uncompressed bytes (§5.1) — fetch
      // decodes transparently on the client.
      const bytes = new Uint8Array(
        await new Response(result.body).arrayBuffer(),
      );
      const encoded = encodeSegmentBody(bytes, acceptEncoding);
      return new Response(encoded.bytes.slice().buffer as ArrayBuffer, {
        status: 200,
        headers: c.newResponse(null, 200, {
          ...result.headers,
          ...(encoded.contentEncoding !== undefined
            ? { 'Content-Encoding': encoded.contentEncoding }
            : {}),
        }).headers,
        ...ALREADY_ENCODED,
      });
    } catch (error) {
      return errorResponse(c, error, 'segments');
    }
  });

  // §5.9.3: blob upload with server-side content-address verification.
  app.put('/blobs/:blobId', async (c) => {
    const auth = await options.authenticate(c.req.raw);
    if (auth === null)
      return errorResponse(c, new SyncError('sync.auth_required'));
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
      return errorResponse(c, error, 'blobs');
    }
  });

  // §5.9.3: presigned-upload grant — mint a direct-to-storage PUT URL.
  app.post('/blobs/:blobId/upload-grant', async (c) => {
    const auth = await options.authenticate(c.req.raw);
    if (auth === null)
      return errorResponse(c, new SyncError('sync.auth_required'));
    try {
      const body = (await c.req.json().catch(() => ({}))) as {
        byteLength?: number;
        mediaType?: string;
      };
      const grant = await handleBlobUploadGrant(
        { ...options.config, ...auth },
        {
          blobId: c.req.param('blobId'),
          byteLength: Number(body.byteLength ?? 0),
          ...(typeof body.mediaType === 'string'
            ? { mediaType: body.mediaType }
            : {}),
        },
      );
      return c.json(grant, 200);
    } catch (error) {
      return errorResponse(c, error, 'blobs');
    }
  });

  // §5.9.5: blob download, re-authorized against referencing rows. When the
  // host configured presigned URLs, the result carries `url` (no bytes) and
  // the client fetches it directly (§5.9.5 always-issue).
  app.get('/blobs/:blobId', async (c) => {
    const auth = await options.authenticate(c.req.raw);
    if (auth === null)
      return errorResponse(c, new SyncError('sync.auth_required'));
    try {
      const result = await handleBlobDownload(
        { ...options.config, ...auth },
        c.req.param('blobId'),
      );
      if (result.url !== undefined) {
        return c.json(
          { url: result.url, urlExpiresAtMs: result.urlExpiresAtMs },
          200,
        );
      }
      if (c.req.header('if-none-match') === result.headers.ETag) {
        return c.body(null, 304, result.headers);
      }
      const bytes = result.bytes ?? new Uint8Array(0);
      return c.body(bytes.slice().buffer as ArrayBuffer, 200, {
        ...result.headers,
      });
    } catch (error) {
      return errorResponse(c, error, 'blobs');
    }
  });

  return app;
}
/**
 * The segment route encodes its own body (§5.8) and declares
 * `Content-Encoding`. workerd encodes every response that declares one again
 * unless `encodeBody: 'manual'` marks the body as encoded, so a Workers client
 * would decode gzip inside gzip and fail §5.1 verification
 * (SYNCULAR-WORKERS-SEGMENT-ENCODING-001). Other runtimes ignore the member.
 */
// Build segment headers through the Hono context, then keep this runtime-specific
// Response init. Hono newResponse/body discard encodeBody from their init.
const ALREADY_ENCODED: { readonly encodeBody: 'manual' } = {
  encodeBody: 'manual',
};
