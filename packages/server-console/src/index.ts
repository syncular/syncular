import { join, normalize, sep } from 'node:path';
import type { MiddlewareHandler } from 'hono';

export interface CreateConsoleUiMiddlewareOptions {
  /**
   * Filesystem directory containing the built console (Vite `dist` output).
   *
   * When omitted, uses the bundled `console-dist` directory inside this package
   * (populated at publish time via `prepack`).
   */
  distDir?: string;

  /**
   * Mount path in your Hono app.
   *
   * Example: `/console` (will serve `/console/*`)
   */
  basePath: string;

  /**
   * SPA entry file name (default: `index.html`).
   */
  indexFile?: string;

  /**
   * Cache control header for immutable build assets (default: 1 year).
   */
  assetsCacheControl?: string;

  /**
   * Cache control header for `index.html` (default: no-cache).
   */
  indexCacheControl?: string;

  /**
   * Inject `<base href>` and a basepath meta tag into `index.html` responses
   * based on `basePath`. Defaults to true.
   *
   * If you provide a custom `distDir` that already has a correct base, you can
   * set this to false.
   */
  injectBaseTags?: boolean;
}

export function getBundledConsoleDistDir(): string {
  return new URL('../console-dist', import.meta.url).pathname;
}

function escapeHtmlAttr(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll("'", '&#39;');
}

function injectBaseTagsIntoHtml(html: string, basePath: string): string {
  const baseHref = basePath === '/' ? '/' : `${basePath}/`;
  const escapedBaseHref = escapeHtmlAttr(baseHref);
  const escapedBasePath = escapeHtmlAttr(basePath);

  // Replace any previously injected tags.
  let out = html.replace(
    /<base\s+[^>]*data-syncular-console-base\s*=\s*["']true["'][^>]*>\s*/i,
    ''
  );
  out = out.replace(
    /<meta\s+[^>]*name\s*=\s*["']syncular-console-basepath["'][^>]*>\s*/i,
    ''
  );

  const injection = `<base href="${escapedBaseHref}" data-syncular-console-base="true">\n<meta name="syncular-console-basepath" content="${escapedBasePath}">\n`;

  const headOpenIndex = out.search(/<head[^>]*>/i);
  if (headOpenIndex === -1) return injection + out;

  const headOpenTag = out.match(/<head[^>]*>/i)?.[0];
  if (!headOpenTag) return injection + out;

  const insertAt = headOpenIndex + headOpenTag.length;
  return `${out.slice(0, insertAt)}\n${injection}${out.slice(insertAt)}`;
}

function normalizeBasePath(basePath: string): string {
  if (!basePath.startsWith('/')) return `/${basePath.replace(/\/+/g, '/')}`;
  return basePath.replace(/\/+/g, '/').replace(/\/$/, '');
}

function hasFileExtension(pathname: string): boolean {
  const lastSegment = pathname.split('/').at(-1) ?? '';
  return lastSegment.includes('.');
}

function mimeFromPath(pathname: string): string {
  const ext = pathname.split('.').at(-1)?.toLowerCase();
  switch (ext) {
    case 'html':
      return 'text/html; charset=utf-8';
    case 'js':
      return 'text/javascript; charset=utf-8';
    case 'css':
      return 'text/css; charset=utf-8';
    case 'json':
      return 'application/json; charset=utf-8';
    case 'svg':
      return 'image/svg+xml';
    case 'png':
      return 'image/png';
    case 'jpg':
    case 'jpeg':
      return 'image/jpeg';
    case 'gif':
      return 'image/gif';
    case 'webp':
      return 'image/webp';
    case 'ico':
      return 'image/x-icon';
    case 'txt':
      return 'text/plain; charset=utf-8';
    case 'woff2':
      return 'font/woff2';
    case 'woff':
      return 'font/woff';
    case 'ttf':
      return 'font/ttf';
    case 'eot':
      return 'application/vnd.ms-fontobject';
    case 'map':
      return 'application/json; charset=utf-8';
    default:
      return 'application/octet-stream';
  }
}

function safeJoinUnderRoot(
  rootDir: string,
  relativePath: string
): string | null {
  const rootNormalized = normalize(rootDir);
  const candidate = normalize(join(rootDir, relativePath));
  const rootWithSep = rootNormalized.endsWith(sep)
    ? rootNormalized
    : `${rootNormalized}${sep}`;
  if (candidate === rootNormalized) return null;
  if (!candidate.startsWith(rootWithSep)) return null;
  return candidate;
}

async function tryServeFile(
  absolutePath: string,
  options: {
    cacheControl: string;
    contentType: string;
    method: string;
  }
): Promise<Response | null> {
  // Bun-only. We keep this package Bun-targeted (tsconfig.bun.json) to match the repo.
  if (typeof Bun === 'undefined') {
    throw new Error('@syncular/server-console requires Bun runtime (Bun.file)');
  }

  const file = Bun.file(absolutePath);
  const exists = await file.exists();
  if (!exists) return null;

  const headers = new Headers({
    'content-type': options.contentType,
    'cache-control': options.cacheControl,
  });

  if (options.method === 'HEAD') {
    // We intentionally omit Content-Length since Bun.file size may be lazy.
    return new Response(null, { status: 200, headers });
  }

  return new Response(file.stream(), { status: 200, headers });
}

async function tryServeIndexHtml(
  absolutePath: string,
  options: {
    cacheControl: string;
    method: string;
    transform?: (html: string) => string;
  }
): Promise<Response | null> {
  if (typeof Bun === 'undefined') {
    throw new Error('@syncular/server-console requires Bun runtime (Bun.file)');
  }

  const file = Bun.file(absolutePath);
  const exists = await file.exists();
  if (!exists) return null;

  const headers = new Headers({
    'content-type': 'text/html; charset=utf-8',
    'cache-control': options.cacheControl,
  });

  if (options.method === 'HEAD') {
    return new Response(null, { status: 200, headers });
  }

  const html = await file.text();
  const body = options.transform ? options.transform(html) : html;
  return new Response(body, { status: 200, headers });
}

/**
 * Creates a Hono middleware that serves the `@syncular/console` Vite build output.
 *
 * - Serves static assets from `distDir`
 * - Provides SPA fallback (client-side routes -> `index.html`)
 *
 * Usage:
 * ```ts
 * import { Hono } from 'hono'
 * import { createConsoleUiMiddleware } from '@syncular/server-console'
 *
 * const app = new Hono()
 * app.use(
 *   '/console/*',
 *   createConsoleUiMiddleware({
 *     basePath: '/console',
 *     distDir: new URL('../../../console/dist', import.meta.url).pathname,
 *   })
 * )
 * ```
 */
export function createConsoleUiMiddleware(
  options: CreateConsoleUiMiddlewareOptions
): MiddlewareHandler {
  const basePath = normalizeBasePath(options.basePath);
  const distDir = options.distDir ?? getBundledConsoleDistDir();
  const indexFile = options.indexFile ?? 'index.html';
  const assetsCacheControl =
    options.assetsCacheControl ?? 'public, max-age=31536000, immutable';
  const indexCacheControl =
    options.indexCacheControl ?? 'no-cache, no-store, must-revalidate';
  const injectBaseTags = options.injectBaseTags ?? true;

  return async (c, next) => {
    const method = c.req.method;
    if (method !== 'GET' && method !== 'HEAD') return next();

    const requestPath = c.req.path;
    if (!requestPath.startsWith(basePath)) return next();

    let relative = requestPath.slice(basePath.length);
    if (relative.startsWith('/')) relative = relative.slice(1);

    // `/console` or `/console/` -> index
    if (relative === '' || requestPath.endsWith('/')) {
      const indexPath = safeJoinUnderRoot(distDir, indexFile);
      if (!indexPath) return c.text('Not found', 404);

      const res = await tryServeIndexHtml(indexPath, {
        cacheControl: indexCacheControl,
        method,
        ...(injectBaseTags && {
          transform: (html) => injectBaseTagsIntoHtml(html, basePath),
        }),
      });
      if (!res) return c.text('Console UI not built', 500);
      return res;
    }

    // First try to serve the exact file path (assets, public files, etc.)
    const candidatePath = safeJoinUnderRoot(distDir, relative);
    if (!candidatePath) return c.text('Not found', 404);

    const isAssetRequest = hasFileExtension(relative);
    const res = await tryServeFile(candidatePath, {
      cacheControl: isAssetRequest ? assetsCacheControl : indexCacheControl,
      contentType: mimeFromPath(relative),
      method,
    });
    if (res) return res;

    // If it looks like a file request, don't SPA-fallback.
    if (isAssetRequest) return c.text('Not found', 404);

    // SPA fallback to index.html for client routes
    const indexPath = safeJoinUnderRoot(distDir, indexFile);
    if (!indexPath) return c.text('Not found', 404);
    const indexRes = await tryServeIndexHtml(indexPath, {
      cacheControl: indexCacheControl,
      method,
      ...(injectBaseTags && {
        transform: (html) => injectBaseTagsIntoHtml(html, basePath),
      }),
    });
    if (!indexRes) return c.text('Console UI not built', 500);
    return indexRes;
  };
}
