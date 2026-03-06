import type { Context } from 'hono';

function normalizeOrigin(origin: string): string | null {
  try {
    return new URL(origin).origin;
  } catch {
    return null;
  }
}

export function isRequestOriginAllowed(args: {
  requestUrl: string;
  originHeader?: string | null;
  allowedOrigins?: string[] | '*';
}): boolean {
  if (args.allowedOrigins === '*') {
    return true;
  }

  const origin = args.originHeader;
  if (Array.isArray(args.allowedOrigins)) {
    if (!origin) return false;
    const normalizedOrigin = normalizeOrigin(origin);
    return normalizedOrigin
      ? args.allowedOrigins.includes(normalizedOrigin)
      : false;
  }

  if (!origin) {
    return true;
  }

  const normalizedOrigin = normalizeOrigin(origin);
  if (!normalizedOrigin) {
    return false;
  }

  try {
    return normalizedOrigin === new URL(args.requestUrl).origin;
  } catch {
    return false;
  }
}

export function isWebSocketOriginAllowed(
  c: Context,
  allowedOrigins?: string[] | '*'
): boolean {
  return isRequestOriginAllowed({
    requestUrl: c.req.url,
    originHeader: c.req.header('origin'),
    allowedOrigins,
  });
}
