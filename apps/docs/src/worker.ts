interface AssetFetcher {
  fetch(request: Request): Promise<Response>;
}

interface AnalyticsEngineDataset {
  writeDataPoint(point: {
    blobs?: string[];
    doubles?: number[];
    indexes?: string[];
  }): void;
}

interface Env {
  ASSETS: AssetFetcher;
  ANALYTICS: AnalyticsEngineDataset;
}

interface RequestCf {
  country?: string;
}

interface ArticleRead {
  path: string;
  activeSeconds: number;
  scrollDepth: number;
  referrer?: string | undefined;
  utmSource?: string | undefined;
  utmMedium?: string | undefined;
  utmCampaign?: string | undefined;
}

const analyticsDataset = 'syncular_docs_engagement';

const dimension = (value: string | null | undefined, fallback = 'none') => {
  const normalized = value
    ?.trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
  return normalized || fallback;
};

export const classifyDevice = (userAgent: string | null) => {
  if (!userAgent) return 'unknown';
  if (
    /bot|crawler|spider|slurp|preview|facebookexternalhit|linkedinbot|whatsapp/i.test(
      userAgent,
    )
  ) {
    return 'bot';
  }
  if (/ipad|tablet/i.test(userAgent)) return 'tablet';
  if (/mobile|android|iphone|ipod/i.test(userAgent)) return 'mobile';
  return 'desktop';
};

export const referrerHost = (value: string | null | undefined) => {
  if (!value) return 'direct';
  try {
    const hostname = new URL(value).hostname.toLowerCase();
    return hostname === 'syncular.dev' || hostname.endsWith('.syncular.dev')
      ? 'internal'
      : dimension(hostname, 'direct');
  } catch {
    return 'direct';
  }
};

const sectionFor = (pathname: string) => {
  if (pathname === '/') return 'landing';
  if (pathname === '/blog/' || pathname === '/blog') return 'blog_index';
  if (pathname.startsWith('/blog/')) return 'blog_article';
  return 'docs';
};

const privacyOptOut = (request: Request) =>
  request.headers.get('sec-gpc') === '1' || request.headers.get('dnt') === '1';

const requestCountry = (request: Request) => {
  const country = (request as Request & { cf?: RequestCf }).cf?.country;
  return /^[A-Z]{2}$/.test(country ?? '') ? (country ?? 'XX') : 'XX';
};

const campaign = (url: URL, key: string) =>
  dimension(url.searchParams.get(key));

const writeAnalytics = (
  env: Env,
  request: Request,
  event: 'page_view' | 'article_read',
  path: string,
  responseStatus: number,
  referrer: string,
  activeSeconds: number,
  scrollDepth: number,
  cacheStatus: string,
  campaignValues?: {
    source?: string | undefined;
    medium?: string | undefined;
    campaign?: string | undefined;
  },
) => {
  const url = new URL(request.url);
  env.ANALYTICS.writeDataPoint({
    // Dataset schema (also documented in README.md):
    // blob1 event, blob2 path, blob3 referrer host, blob4 country,
    // blob5 device class, blob6 status, blob7 section, blob8..10 campaign,
    // blob11 cache status; double1 count, double2 active seconds,
    // double3 scroll depth; index1 hostname.
    blobs: [
      event,
      path.slice(0, 512),
      referrer,
      requestCountry(request),
      classifyDevice(request.headers.get('user-agent')),
      String(responseStatus),
      sectionFor(path),
      dimension(campaignValues?.source ?? campaign(url, 'utm_source')),
      dimension(campaignValues?.medium ?? campaign(url, 'utm_medium')),
      dimension(campaignValues?.campaign ?? campaign(url, 'utm_campaign')),
      dimension(cacheStatus),
    ],
    doubles: [1, activeSeconds, scrollDepth],
    indexes: [url.hostname],
  });
};

const isArticlePath = (path: unknown): path is string =>
  typeof path === 'string' &&
  /^\/blog\/[a-z0-9][a-z0-9-]*\/?$/.test(path) &&
  path !== '/blog/';

export const parseArticleRead = (value: unknown): ArticleRead | null => {
  if (!value || typeof value !== 'object') return null;
  const candidate = value as Record<string, unknown>;
  if (
    !isArticlePath(candidate.path) ||
    typeof candidate.activeSeconds !== 'number' ||
    !Number.isFinite(candidate.activeSeconds) ||
    candidate.activeSeconds < 30 ||
    candidate.activeSeconds > 3600 ||
    typeof candidate.scrollDepth !== 'number' ||
    !Number.isFinite(candidate.scrollDepth) ||
    candidate.scrollDepth < 0.6 ||
    candidate.scrollDepth > 1
  ) {
    return null;
  }

  return {
    path: candidate.path,
    activeSeconds: Math.round(candidate.activeSeconds),
    scrollDepth: Math.round(candidate.scrollDepth * 100) / 100,
    referrer:
      typeof candidate.referrer === 'string' ? candidate.referrer : undefined,
    utmSource:
      typeof candidate.utmSource === 'string'
        ? dimension(candidate.utmSource)
        : undefined,
    utmMedium:
      typeof candidate.utmMedium === 'string'
        ? dimension(candidate.utmMedium)
        : undefined,
    utmCampaign:
      typeof candidate.utmCampaign === 'string'
        ? dimension(candidate.utmCampaign)
        : undefined,
  };
};

const articleReadResponse = async (request: Request, env: Env) => {
  const url = new URL(request.url);
  const origin = request.headers.get('origin');
  const sameOrigin =
    origin === url.origin &&
    request.headers.get('sec-fetch-site') === 'same-origin';
  const contentLength = Number(request.headers.get('content-length') ?? '0');

  if (!sameOrigin || contentLength > 2048) {
    return new Response(null, { status: 400 });
  }

  let payload: ArticleRead | null = null;
  try {
    payload = parseArticleRead(await request.json());
  } catch {
    // Invalid engagement reports are deliberately ignored.
  }

  if (payload && !privacyOptOut(request)) {
    writeAnalytics(
      env,
      request,
      'article_read',
      payload.path,
      204,
      referrerHost(payload.referrer),
      payload.activeSeconds,
      payload.scrollDepth,
      'none',
      {
        source: payload.utmSource,
        medium: payload.utmMedium,
        campaign: payload.utmCampaign,
      },
    );
  }

  return new Response(null, {
    status: payload ? 204 : 400,
    headers: { 'cache-control': 'no-store' },
  });
};

const linkHeader = [
  '</.well-known/api-catalog>; rel="api-catalog"; type="application/linkset+json"',
  '</.well-known/openapi.json>; rel="service-desc"; type="application/vnd.oai.openapi+json"',
  '</reference/>; rel="service-doc"; type="text/html"',
  '</sitemap.xml>; rel="describedby"; type="application/xml"',
  '</llms.txt>; rel="describedby"; type="text/plain"',
  '</.well-known/agent-skills/index.json>; rel="describedby"; type="application/json"',
].join(', ');

const contentTypes = new Map([
  ['/.well-known/api-catalog', 'application/linkset+json; charset=utf-8'],
  ['/.well-known/oauth-protected-resource', 'application/json; charset=utf-8'],
  [
    '/.well-known/oauth-authorization-server',
    'application/json; charset=utf-8',
  ],
  [
    '/.well-known/openapi.json',
    'application/vnd.oai.openapi+json; charset=utf-8',
  ],
  ['/.well-known/docs-index.json', 'application/json; charset=utf-8'],
  ['/.well-known/agent-skills/index.json', 'application/json; charset=utf-8'],
  ['/.well-known/mcp/server-card.json', 'application/json; charset=utf-8'],
  [
    '/.well-known/agent-skills/syncular-docs/SKILL.md',
    'text/markdown; charset=utf-8',
  ],
  ['/auth.md', 'text/markdown; charset=utf-8'],
  ['/agent/auth/register', 'application/json; charset=utf-8'],
  ['/agent/auth/claim', 'application/json; charset=utf-8'],
  ['/oauth/authorize', 'application/json; charset=utf-8'],
  ['/oauth/token', 'application/json; charset=utf-8'],
  ['/oauth/jwks.json', 'application/json; charset=utf-8'],
  ['/health', 'application/json; charset=utf-8'],
  ['/llms.txt', 'text/plain; charset=utf-8'],
  ['/robots.txt', 'text/plain; charset=utf-8'],
  ['/sitemap.xml', 'application/xml; charset=utf-8'],
]);

const markdownPathFor = (pathname: string) => {
  if (pathname === '/' || pathname === '/index.html') return '/index.md';
  if (pathname.startsWith('/_astro/') || pathname.includes('.')) return null;

  const normalized = pathname.endsWith('/') ? pathname.slice(0, -1) : pathname;
  if (!normalized || normalized === '/') return '/index.md';

  return `${normalized}.md`;
};

const wantsMarkdown = (request: Request) =>
  (request.headers.get('accept') ?? '')
    .split(',')
    .map((part) => part.trim().split(';')[0]?.toLowerCase())
    .includes('text/markdown');

const withPath = (request: Request, pathname: string) => {
  const url = new URL(request.url);
  url.pathname = pathname;
  url.search = '';
  return new Request(url, request);
};

const isHtmlPage = (pathname: string, response: Response) => {
  const contentType = response.headers.get('content-type') ?? '';
  return (
    contentType.includes('text/html') ||
    pathname === '/' ||
    pathname.endsWith('/')
  );
};

const addVary = (headers: Headers, value: string) => {
  const current = headers.get('vary');
  if (!current) {
    headers.set('vary', value);
    return;
  }

  const parts = current.split(',').map((part) => part.trim().toLowerCase());
  if (!parts.includes(value.toLowerCase())) {
    headers.set('vary', `${current}, ${value}`);
  }
};

const markdownTokens = (body: string) => {
  const words = body.trim().match(/\S+/g);
  return String(words?.length ?? 0);
};

const respondWithHeaders = (
  response: Response,
  pathname: string,
  includeDiscoveryLinks: boolean,
) => {
  const headers = new Headers(response.headers);
  const contentType = contentTypes.get(pathname);
  if (contentType) headers.set('content-type', contentType);
  if (includeDiscoveryLinks && isHtmlPage(pathname, response)) {
    headers.set('link', linkHeader);
  }

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
};

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/_analytics/read' && request.method === 'POST') {
      return articleReadResponse(request, env);
    }

    if (url.pathname === '/oauth/token' && request.method === 'POST') {
      return new Response(
        JSON.stringify(
          {
            access_token: 'public-docs',
            token_type: 'Bearer',
            expires_in: 3600,
            scope: 'docs:read',
          },
          null,
          2,
        ),
        {
          status: 200,
          headers: {
            'content-type': 'application/json; charset=utf-8',
            'cache-control': 'no-store',
          },
        },
      );
    }

    if (url.pathname === '/oauth/authorize') {
      return new Response(
        JSON.stringify(
          {
            issuer: 'https://syncular.dev',
            supported_grants: ['client_credentials'],
            token_endpoint: 'https://syncular.dev/oauth/token',
            note: 'syncular.dev public docs auth uses anonymous client_credentials; no browser authorization step is required.',
          },
          null,
          2,
        ),
        {
          status: 200,
          headers: {
            'content-type': 'application/json; charset=utf-8',
            'cache-control': 'public, max-age=0, must-revalidate',
          },
        },
      );
    }

    if (url.pathname === '/agent/auth/register' && request.method === 'POST') {
      return new Response(
        JSON.stringify(
          {
            client_id: 'syncular-docs-anonymous',
            client_name: 'Anonymous syncular docs agent',
            token_endpoint_auth_method: 'none',
            grant_types: ['client_credentials'],
            scope: 'docs:read',
          },
          null,
          2,
        ),
        {
          status: 201,
          headers: {
            'content-type': 'application/json; charset=utf-8',
            'cache-control': 'no-store',
          },
        },
      );
    }

    if (wantsMarkdown(request)) {
      const markdownPath = markdownPathFor(url.pathname);
      if (markdownPath) {
        const markdownResponse = await env.ASSETS.fetch(
          withPath(request, markdownPath),
        );
        if (markdownResponse.ok) {
          const body = await markdownResponse.text();
          const headers = new Headers(markdownResponse.headers);
          headers.set('content-type', 'text/markdown; charset=utf-8');
          headers.set('x-markdown-tokens', markdownTokens(body));
          addVary(headers, 'Accept');
          return new Response(body, {
            status: markdownResponse.status,
            statusText: markdownResponse.statusText,
            headers,
          });
        }
      }
    }

    const response = await env.ASSETS.fetch(request);
    const finalResponse = respondWithHeaders(response, url.pathname, true);
    const contentType = finalResponse.headers.get('content-type') ?? '';
    if (
      request.method === 'GET' &&
      contentType.includes('text/html') &&
      !privacyOptOut(request)
    ) {
      writeAnalytics(
        env,
        request,
        'page_view',
        url.pathname,
        finalResponse.status,
        referrerHost(request.headers.get('referer')),
        0,
        0,
        finalResponse.headers.get('cf-cache-status') ?? 'none',
      );
    }

    return finalResponse;
  },
};

export { analyticsDataset };
