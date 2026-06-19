/**
 * @syncular/server/hono - Console blob storage routes.
 *
 * Extracted from console/routes.ts without behavior changes.
 */

import { ErrorResponseSchema } from '@syncular/core';
import { resolver } from 'hono-openapi';
import { consoleValidator as zValidator } from '../../validation';
import { describeConsoleRoute } from '../route-descriptor';
import {
  ConsoleBlobDeleteResponseSchema,
  ConsoleBlobListQuerySchema,
  ConsoleBlobListResponseSchema,
} from '../schemas';
import type { ConsoleRoutesContext } from './context';
import { blobStorageNotConfigured, consoleRouteError } from './shared';

export function registerStorageRoutes(ctx: ConsoleRoutesContext): void {
  const { routes, options } = ctx;

  // Storage endpoints
  // -----------------------------------------------------------------------
  const bucket = options.blobBucket;

  routes.get(
    '/storage',
    describeConsoleRoute({
      summary: 'List storage items',
      responses: {
        200: {
          description: 'Paginated list of storage items',
          content: {
            'application/json': {
              schema: resolver(ConsoleBlobListResponseSchema),
            },
          },
        },
        401: {
          description: 'Unauthenticated',
          content: {
            'application/json': { schema: resolver(ErrorResponseSchema) },
          },
        },
      },
    }),
    zValidator('query', ConsoleBlobListQuerySchema),
    async (c) => {
      if (!bucket) {
        return blobStorageNotConfigured(c);
      }

      const { prefix, cursor, limit } = c.req.valid('query');
      const listed = await bucket.list({
        prefix: prefix || undefined,
        cursor: cursor || undefined,
        limit,
      });

      return c.json(
        {
          items: listed.objects.map((obj) => ({
            key: obj.key,
            size: obj.size,
            uploaded: obj.uploaded.toISOString(),
            httpMetadata: obj.httpMetadata?.contentType
              ? { contentType: obj.httpMetadata.contentType }
              : undefined,
          })),
          truncated: listed.truncated,
          cursor: listed.cursor ?? null,
        },
        200
      );
    }
  );

  routes.get(
    '/storage/:key{.+}/download',
    describeConsoleRoute({
      summary: 'Download a storage item',
      responses: {
        200: { description: 'Storage item contents' },
        401: {
          description: 'Unauthenticated',
          content: {
            'application/json': { schema: resolver(ErrorResponseSchema) },
          },
        },
        404: {
          description: 'Blob not found',
          content: {
            'application/json': { schema: resolver(ErrorResponseSchema) },
          },
        },
      },
    }),
    async (c) => {
      if (!bucket) {
        return blobStorageNotConfigured(c);
      }

      const key = decodeURIComponent(c.req.param('key'));
      const object = await bucket.get(key);
      if (!object) {
        return consoleRouteError(c, 404, 'blob.not_found');
      }

      const headers = new Headers();
      headers.set('Content-Length', String(object.size));
      headers.set(
        'Content-Type',
        object.httpMetadata?.contentType ?? 'application/octet-stream'
      );
      const filename = key.split('/').pop() || key;
      headers.set(
        'Content-Disposition',
        `attachment; filename="${filename.replace(/"/g, '\\"')}"`
      );

      return new Response(object.body as ReadableStream, {
        status: 200,
        headers,
      });
    }
  );

  routes.delete(
    '/storage/:key{.+}',
    describeConsoleRoute({
      summary: 'Delete a storage item',
      responses: {
        200: {
          description: 'Storage item deleted',
          content: {
            'application/json': {
              schema: resolver(ConsoleBlobDeleteResponseSchema),
            },
          },
        },
        401: {
          description: 'Unauthenticated',
          content: {
            'application/json': { schema: resolver(ErrorResponseSchema) },
          },
        },
      },
    }),
    async (c) => {
      if (!bucket) {
        return blobStorageNotConfigured(c);
      }

      const key = decodeURIComponent(c.req.param('key'));
      await bucket.delete(key);
      return c.json({ deleted: true }, 200);
    }
  );
}
