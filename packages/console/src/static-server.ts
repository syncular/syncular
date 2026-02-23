import { existsSync, readFileSync, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CONSOLE_BASEPATH_META,
  CONSOLE_SERVER_URL_META,
  CONSOLE_TOKEN_META,
  normalizeBasePath,
} from './runtime-config';

const DEFAULT_MOUNT_PATH = '/console';
const DEFAULT_INDEX_CACHE_CONTROL = 'no-store';
const DEFAULT_ASSET_CACHE_CONTROL = 'public, max-age=31536000, immutable';

const CONTENT_TYPES: Record<string, string> = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.manifest': 'application/manifest+json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.txt': 'text/plain; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
};

export interface ConsoleUiPrefill {
  basePath?: string;
  serverUrl?: string;
  token?: string;
}

export interface CreateConsoleStaticResponderOptions {
  mountPath?: string;
  staticDir?: string;
  defaultPrefill?: ConsoleUiPrefill;
  indexCacheControl?: string;
  assetCacheControl?: string;
}

export interface ServeConsoleStaticRequestOptions {
  prefill?: ConsoleUiPrefill;
}

export type ConsoleStaticResponder = (
  request: Request,
  options?: ServeConsoleStaticRequestOptions
) => Promise<Response | null>;

function normalizeMountPath(mountPath: string | undefined): string {
  const value = mountPath?.trim() ?? '';
  if (!value || value === '/') return '/';
  const withLeadingSlash = value.startsWith('/') ? value : `/${value}`;
  return withLeadingSlash.replace(/\/+$/g, '') || '/';
}

function normalizeRequestPath(pathname: string): string {
  const decodedPathname = decodeURIComponent(pathname);
  return decodedPathname === '' ? '/' : decodedPathname;
}

function matchesMountPath(pathname: string, mountPath: string): boolean {
  if (mountPath === '/') return pathname.startsWith('/');
  return pathname === mountPath || pathname.startsWith(`${mountPath}/`);
}

function relativePathForMount(pathname: string, mountPath: string): string {
  if (mountPath === '/') return pathname;
  const withoutPrefix = pathname.slice(mountPath.length);
  return withoutPrefix === '' ? '/' : withoutPrefix;
}

function escapeHtmlAttribute(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

function withMetaTag(html: string, name: string, value: string): string {
  const escapedValue = escapeHtmlAttribute(value);
  const pattern = new RegExp(`<meta name="${name}" content="[^"]*"\\s*/?>`);
  if (pattern.test(html)) {
    return html.replace(
      pattern,
      `<meta name="${name}" content="${escapedValue}" />`
    );
  }

  return html.replace(
    '</head>',
    `  <meta name="${name}" content="${escapedValue}" />\n  </head>`
  );
}

function isWithinDirectory(baseDir: string, targetPath: string): boolean {
  return (
    targetPath === baseDir || targetPath.startsWith(`${baseDir}${path.sep}`)
  );
}

function contentTypeFor(pathname: string): string {
  const extension = path.extname(pathname).toLowerCase();
  return CONTENT_TYPES[extension] ?? 'application/octet-stream';
}

function resolveConsoleStaticDir(): string {
  const staticDirFromModule = fileURLToPath(
    new URL('../web-dist', import.meta.url)
  );
  return path.resolve(staticDirFromModule);
}

function renderIndexHtml(args: {
  template: string;
  mountPath: string;
  prefill?: ConsoleUiPrefill;
}): string {
  const resolvedBasePath = normalizeBasePath(
    args.prefill?.basePath ?? args.mountPath
  );
  const resolvedServerUrl = args.prefill?.serverUrl ?? '';
  const resolvedToken = args.prefill?.token ?? '';

  const withMeta = withMetaTag(
    withMetaTag(
      withMetaTag(args.template, CONSOLE_BASEPATH_META, resolvedBasePath),
      CONSOLE_SERVER_URL_META,
      resolvedServerUrl
    ),
    CONSOLE_TOKEN_META,
    resolvedToken
  );

  if (resolvedBasePath === '/') {
    return withMeta;
  }

  const mountPrefix = resolvedBasePath.replace(/\/+$/g, '');
  return withMeta.replace(
    /(src|href)=("|')\/assets\/([^"']+)("|')/g,
    (_match, attribute, openQuote, assetPath, closeQuote) =>
      `${attribute}=${openQuote}${mountPrefix}/assets/${assetPath}${closeQuote}`
  );
}

export function createConsoleStaticResponder(
  options: CreateConsoleStaticResponderOptions = {}
): ConsoleStaticResponder {
  const mountPath = normalizeMountPath(options.mountPath ?? DEFAULT_MOUNT_PATH);
  const staticDir = path.resolve(
    options.staticDir ?? resolveConsoleStaticDir()
  );
  const indexPath = path.join(staticDir, 'index.html');

  if (!existsSync(indexPath)) {
    throw new Error(
      `Console distributable missing: ${indexPath}. Build @syncular/console before serving static assets.`
    );
  }

  const indexTemplate = readFileSync(indexPath, 'utf8');
  const indexCacheControl =
    options.indexCacheControl ?? DEFAULT_INDEX_CACHE_CONTROL;
  const assetCacheControl =
    options.assetCacheControl ?? DEFAULT_ASSET_CACHE_CONTROL;
  const defaultPrefill = options.defaultPrefill;

  return async (request, requestOptions = {}) => {
    const method = request.method.toUpperCase();
    if (method !== 'GET' && method !== 'HEAD') {
      return null;
    }

    const url = new URL(request.url);
    const pathname = normalizeRequestPath(url.pathname);
    if (!matchesMountPath(pathname, mountPath)) {
      return null;
    }

    const relativePath = relativePathForMount(pathname, mountPath);
    const effectivePrefill = {
      ...defaultPrefill,
      ...requestOptions.prefill,
    };
    const sendIndex = () => {
      const html = renderIndexHtml({
        template: indexTemplate,
        mountPath,
        prefill: effectivePrefill,
      });
      return new Response(method === 'HEAD' ? undefined : html, {
        status: 200,
        headers: {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': indexCacheControl,
        },
      });
    };

    if (
      relativePath === '/' ||
      relativePath === '/index.html' ||
      path.extname(relativePath).length === 0
    ) {
      return sendIndex();
    }

    const candidatePath = path.resolve(staticDir, `.${relativePath}`);
    if (!isWithinDirectory(staticDir, candidatePath)) {
      return new Response('Forbidden', { status: 403 });
    }

    if (!existsSync(candidatePath) || !statSync(candidatePath).isFile()) {
      return new Response('Not Found', { status: 404 });
    }

    const body = method === 'HEAD' ? undefined : await readFile(candidatePath);
    return new Response(body, {
      status: 200,
      headers: {
        'Content-Type': contentTypeFor(candidatePath),
        'Cache-Control': assetCacheControl,
      },
    });
  };
}
