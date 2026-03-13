/**
 * @syncular/server-hono - OpenAPI Spec Export
 *
 * Provides utilities for generating and serving OpenAPI specifications.
 */

import { Scalar } from '@scalar/hono-api-reference';
import { type Handler, Hono } from 'hono';
import { generateSpecs, openAPIRouteHandler } from 'hono-openapi';

const DEFAULT_SCALAR_CDN =
  'https://cdn.jsdelivr.net/npm/@scalar/api-reference@latest';

export interface OpenAPIConfig {
  title?: string;
  version?: string;
  description?: string;
  servers?: Array<{ url: string; description?: string }>;
}

export interface ScalarReferenceConfig {
  url?: string;
  cdn?: string;
}

export interface OpenAPIDocsRoutesConfig extends OpenAPIConfig {
  openAPIPath?: string;
  scalarPath?: string;
  scalar?: ScalarReferenceConfig;
}

function normalizeRoutePath(path: string): string {
  return path.startsWith('/') ? path : `/${path}`;
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
 * Create a Scalar API reference handler that points at an OpenAPI document.
 */
export function createScalarReferenceHandler(
  config: ScalarReferenceConfig = {}
): Handler {
  return Scalar({
    url: config.url ?? '/openapi.json',
    cdn: config.cdn ?? DEFAULT_SCALAR_CDN,
  });
}

/**
 * Create a small Hono app that serves both `/openapi.json` and `/spec`.
 *
 * @example
 * ```typescript
 * import { Hono } from 'hono';
 * import { createOpenAPIDocsRoutes } from '@syncular/server-hono';
 *
 * const app = new Hono();
 * app.route('/', createOpenAPIDocsRoutes(app, {
 *   title: 'Syncular API',
 * }));
 * ```
 */
export function createOpenAPIDocsRoutes(
  app: Hono,
  config: OpenAPIDocsRoutesConfig = {}
) {
  const docsApp = new Hono();
  const openAPIPath = normalizeRoutePath(config.openAPIPath ?? '/openapi.json');
  const scalarPath = normalizeRoutePath(config.scalarPath ?? '/spec');

  docsApp.get(openAPIPath, createOpenAPIHandler(app, config));
  docsApp.get(
    scalarPath,
    createScalarReferenceHandler({
      url: config.scalar?.url ?? openAPIPath,
      cdn: config.scalar?.cdn,
    })
  );

  return docsApp;
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
