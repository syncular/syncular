import type { Context } from 'hono';

function normalizeOrigin(origin: string): string | null {
  try {
    return new URL(origin).origin;
  } catch {
    return null;
  }
}

function defaultPortForProtocol(protocol: string): string {
  return protocol === 'https:' ? '443' : '80';
}

function matchesWildcardOriginPattern(
  origin: URL,
  pattern: string
): boolean {
  const match = pattern.match(
    /^(https?):\/\/(\*\.)?(\[[^\]]+\]|[^/:]+)(?::(\*|\d+))?$/i
  );
  if (!match) {
    return false;
  }

  const [, scheme, wildcardPrefix, rawHost, rawPort] = match;
  const protocol = `${scheme!.toLowerCase()}:`;
  if (origin.protocol !== protocol) {
    return false;
  }

  const patternHostname = rawHost!.replace(/^\[(.*)\]$/, '$1').toLowerCase();
  const originHostname = origin.hostname.toLowerCase();

  if (wildcardPrefix) {
    const suffix = `.${patternHostname}`;
    if (
      originHostname === patternHostname ||
      !originHostname.endsWith(suffix)
    ) {
      return false;
    }
  } else if (originHostname !== patternHostname) {
    return false;
  }

  if (rawPort === '*') {
    return true;
  }

  const originPort = origin.port || defaultPortForProtocol(origin.protocol);
  const patternPort = rawPort || defaultPortForProtocol(protocol);
  return originPort === patternPort;
}

function isAllowedOriginMatch(origin: URL, pattern: string): boolean {
  const exact = pattern.includes('*') ? null : normalizeOrigin(pattern);
  if (exact) {
    return origin.origin === exact;
  }
  return matchesWildcardOriginPattern(origin, pattern);
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
    let parsedOrigin: URL;
    try {
      parsedOrigin = new URL(origin);
    } catch {
      return false;
    }
    return args.allowedOrigins.some((pattern) =>
      isAllowedOriginMatch(parsedOrigin, pattern)
    );
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
    originHeader: c.req.raw.headers.get('origin') ?? c.req.header('origin'),
    allowedOrigins,
  });
}
