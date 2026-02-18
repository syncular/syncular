import {
  type ConsoleStaticResponder,
  type ConsoleUiPrefill,
  type CreateConsoleStaticResponderOptions,
  createConsoleStaticResponder,
  type ServeConsoleStaticRequestOptions,
} from '@syncular/console/server';
import type { Context, Hono } from 'hono';

type MaybePromise<T> = T | Promise<T>;

export interface MountConsoleUiOptions {
  /**
   * Browser mount path for the console UI. Defaults to `/console`.
   */
  mountPath?: string;
  /**
   * API base path used to prefill the console server URL.
   * Defaults to `/api`.
   */
  apiBasePath?: string;
  /**
   * Resolve prefill values per request.
   * Return `null`/`undefined` to keep defaults.
   */
  resolvePrefill?: (
    c: Context
  ) => MaybePromise<ConsoleUiPrefill | null | undefined>;
  /**
   * Convenience callback for prefilled token.
   */
  resolveToken?: (c: Context) => MaybePromise<string | undefined>;
  /**
   * Override distributable directory.
   */
  staticDir?: string;
  /**
   * Cache-Control header for index responses.
   */
  indexCacheControl?: string;
  /**
   * Cache-Control header for static asset responses.
   */
  assetCacheControl?: string;
}

type StaticResponderConfig = Pick<
  CreateConsoleStaticResponderOptions,
  'mountPath' | 'staticDir' | 'indexCacheControl' | 'assetCacheControl'
>;

function normalizePath(pathname: string | undefined, fallback: string): string {
  const value = pathname?.trim() ?? '';
  if (!value) return fallback;
  if (value === '/') return '/';
  const withLeadingSlash = value.startsWith('/') ? value : `/${value}`;
  return withLeadingSlash.replace(/\/+$/g, '') || '/';
}

export function mountConsoleUi(
  app: Hono,
  options: MountConsoleUiOptions = {}
): void {
  const mountPath = normalizePath(options.mountPath, '/console');
  const apiBasePath = normalizePath(options.apiBasePath, '/api');

  const staticResponderConfig: StaticResponderConfig = {
    mountPath,
    staticDir: options.staticDir,
    indexCacheControl: options.indexCacheControl,
    assetCacheControl: options.assetCacheControl,
  };
  const serveConsoleStatic: ConsoleStaticResponder =
    createConsoleStaticResponder(staticResponderConfig);

  const handler = async (c: Context) => {
    const prefillFromResolver = await options.resolvePrefill?.(c);
    const token = await options.resolveToken?.(c);
    const origin = new URL(c.req.url).origin;

    const prefill: ConsoleUiPrefill = {
      basePath: mountPath,
      serverUrl: `${origin}${apiBasePath}`,
      ...prefillFromResolver,
    };

    if (token !== undefined) {
      prefill.token = token;
    }

    const requestOptions: ServeConsoleStaticRequestOptions = { prefill };
    const response = await serveConsoleStatic(c.req.raw, requestOptions);
    if (!response) return c.notFound();
    return response;
  };

  const wildcardPath = mountPath === '/' ? '/*' : `${mountPath}/*`;
  app.get(mountPath, handler);
  app.get(wildcardPath, handler);
}
