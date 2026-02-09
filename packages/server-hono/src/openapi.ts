/**
 * @syncular/server-hono - OpenAPI Spec Export
 *
 * Provides utilities for generating and serving OpenAPI specifications.
 */

import type { Hono } from 'hono';
import { generateSpecs, openAPIRouteHandler } from 'hono-openapi';

interface OpenAPIConfig {
  title?: string;
  version?: string;
  description?: string;
  servers?: Array<{ url: string; description?: string }>;
}

/**
 * Create an OpenAPI spec handler that can be used with Hono routes.
 *
 * @example
 * ```typescript
 * import { Hono } from 'hono';
 * import { createSyncRoutes, createConsoleRoutes, createOpenAPIHandler } from '@syncular/server-hono';
 *
 * const app = new Hono();
 * const syncRoutes = createSyncRoutes({ ... });
 * const consoleRoutes = createConsoleRoutes({ ... });
 *
 * app.route('/sync', syncRoutes);
 * app.route('/console', consoleRoutes);
 *
 * // Add OpenAPI spec endpoint
 * app.get('/openapi.json', createOpenAPIHandler(app, {
 *   title: 'Syncular API',
 *   version: '1.0.0',
 * }));
 * ```
 */
export function createOpenAPIHandler(app: Hono, config: OpenAPIConfig = {}) {
  return openAPIRouteHandler(app, {
    documentation: {
      info: {
        title: config.title ?? 'Syncular API',
        version: config.version ?? '1.0.0',
        description:
          config.description ??
          'Sync infrastructure API for real-time data synchronization',
      },
      servers: config.servers,
    },
  });
}

/**
 * Generate OpenAPI document from a Hono app instance.
 * This is useful for build-time spec generation.
 */
export async function generateOpenAPIDocument(
  app: Hono,
  config: OpenAPIConfig = {}
): Promise<unknown> {
  return generateSpecs(app, {
    documentation: {
      info: {
        title: config.title ?? 'Syncular API',
        version: config.version ?? '1.0.0',
        description:
          config.description ??
          'Sync infrastructure API for real-time data synchronization',
      },
      servers: config.servers,
    },
  });
}
