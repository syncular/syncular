interface AssetFetcher {
  fetch(request: Request): Promise<Response>;
}

interface Env {
  ASSETS: AssetFetcher;
}

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
    return respondWithHeaders(response, url.pathname, true);
  },
};
