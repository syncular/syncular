import { createHash } from 'node:crypto';
import {
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  reflectReleaseVersion,
  releaseVersion,
} from './release-version.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const contentDir = join(root, 'src/content');
const distDir = join(root, 'dist');
const site = 'https://syncular.dev';

const ensureWrite = (path, body) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, body.endsWith('\n') ? body : `${body}\n`);
};

const json = (value) => `${JSON.stringify(value, null, 2)}\n`;
const sha256 = (body) =>
  `sha256:${createHash('sha256').update(body).digest('hex')}`;
const xmlEscape = (value) =>
  value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');

const readTitle = (body, fallback) => {
  const match = body.match(/^#\s+(.+)$/m);
  return match?.[1]?.trim() ?? fallback;
};

const navSource = readFileSync(join(root, 'src/nav.ts'), 'utf8');
const navItems = [...navSource.matchAll(/slug: '([^']+)', title: '([^']+)'/g)]
  .map((match) => ({ slug: match[1], title: match[2] }))
  .filter((item) => item.slug && item.title);

const contentFiles = readdirSync(contentDir)
  .filter((name) => name.endsWith('.md'))
  .map((name) => {
    const path = join(contentDir, name);
    const slug = basename(name, '.md');
    const body = reflectReleaseVersion(readFileSync(path, 'utf8'));
    return {
      slug,
      path,
      body,
      title: readTitle(body, slug),
      lastmod: statSync(path).mtime.toISOString().slice(0, 10),
    };
  });

const bySlug = new Map(contentFiles.map((page) => [page.slug, page]));
const orderedPages = [
  ...navItems.flatMap((item) => {
    const page = bySlug.get(item.slug);
    return page ? [{ ...page, title: item.title }] : [];
  }),
  ...contentFiles
    .filter((page) => !navItems.some((item) => item.slug === page.slug))
    .sort((a, b) => a.slug.localeCompare(b.slug)),
];

const landingMarkdown = `# syncular

syncular is offline-first SQL sync: local SQLite on every client, a
server-authoritative commit log at the center, and scope-based authorization on
every read and write.

Published release: **v${releaseVersion}**.

## Start

- [Quickstart](${site}/quickstart/)
- [What is syncular](${site}/what-is/)
- [Live demos](${site}/demos/)
- [Spec and package map](${site}/reference/)

## Core ideas

- Offline writes queue locally and replay in order on reconnect.
- The server commit log orders, validates, scopes, and fans out every change.
- TypeScript and Rust cores are held together by golden vectors and the same
  conformance scenarios.
- Web, React, Swift, Kotlin, Flutter, React Native, Tauri, Rust, and C FFI
  bindings share one protocol.
`;

ensureWrite(join(distDir, 'index.md'), landingMarkdown);

for (const page of orderedPages) {
  ensureWrite(
    join(distDir, `${page.slug}.md`),
    `<!-- Canonical: ${site}/${page.slug}/ -->\n\n${page.body}`,
  );
}

const latestLastmod = orderedPages
  .map((page) => page.lastmod)
  .sort()
  .at(-1);

const sitemapUrls = [
  { loc: `${site}/`, lastmod: latestLastmod },
  ...orderedPages.map((page) => ({
    loc: `${site}/${page.slug}/`,
    lastmod: page.lastmod,
  })),
];

ensureWrite(
  join(distDir, 'sitemap.xml'),
  `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${sitemapUrls
  .map(
    (entry) => `  <url>
    <loc>${xmlEscape(entry.loc)}</loc>
    <lastmod>${entry.lastmod}</lastmod>
  </url>`,
  )
  .join('\n')}
</urlset>`,
);

ensureWrite(
  join(distDir, 'robots.txt'),
  `User-agent: *
Allow: /
Sitemap: ${site}/sitemap.xml`,
);

const docsIndex = {
  site,
  pages: [
    {
      title: 'syncular',
      path: '/',
      markdown: `${site}/index.md`,
    },
    ...orderedPages.map((page) => ({
      title: page.title,
      path: `/${page.slug}/`,
      markdown: `${site}/${page.slug}.md`,
    })),
  ],
};

ensureWrite(join(distDir, '.well-known/docs-index.json'), json(docsIndex));

ensureWrite(
  join(distDir, 'llms.txt'),
  `# syncular docs

> Offline-first SQL sync for local SQLite on every client.

Canonical site: ${site}
Markdown negotiation: send Accept: text/markdown to any public HTML page.

## Pages

${docsIndex.pages
  .map((page) => `- [${page.title}](${site}${page.path}) - ${page.markdown}`)
  .join('\n')}
`,
);

const apiCatalog = {
  linkset: [
    {
      anchor: `${site}/`,
      'service-desc': [
        {
          href: `${site}/.well-known/openapi.json`,
          type: 'application/vnd.oai.openapi+json',
          title: 'Syncular public discovery OpenAPI',
        },
      ],
      'service-doc': [
        {
          href: `${site}/reference/`,
          type: 'text/html',
          title: 'Syncular spec and package map',
        },
      ],
      status: [
        {
          href: `${site}/health`,
          type: 'application/json',
          title: 'Syncular docs health',
        },
      ],
    },
  ],
};

ensureWrite(join(distDir, '.well-known/api-catalog'), json(apiCatalog));

const openapi = {
  openapi: '3.1.0',
  info: {
    title: 'Syncular public discovery API',
    version: releaseVersion,
    description:
      'Machine-readable discovery endpoints for the public syncular documentation site.',
  },
  servers: [{ url: site }],
  paths: {
    '/health': {
      get: {
        summary: 'Health check for the static docs deployment',
        responses: {
          200: {
            description: 'The docs deployment is reachable.',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    ok: { type: 'boolean' },
                    service: { type: 'string' },
                    version: { type: 'string' },
                  },
                  required: ['ok', 'service', 'version'],
                },
              },
            },
          },
        },
      },
    },
    '/llms.txt': {
      get: {
        summary: 'Markdown documentation index',
        responses: { 200: { description: 'Markdown index.' } },
      },
    },
    '/sitemap.xml': {
      get: {
        summary: 'XML sitemap',
        responses: { 200: { description: 'Sitemaps.org XML sitemap.' } },
      },
    },
    '/robots.txt': {
      get: {
        summary: 'Robots policy',
        responses: { 200: { description: 'Robots.txt with sitemap link.' } },
      },
    },
    '/.well-known/api-catalog': {
      get: {
        summary: 'RFC 9727 API catalog',
        responses: {
          200: { description: 'Linkset JSON API catalog.' },
        },
      },
    },
    '/.well-known/agent-skills/index.json': {
      get: {
        summary: 'Agent skills discovery index',
        responses: {
          200: { description: 'Agent Skills Discovery index.' },
        },
      },
    },
    '/.well-known/oauth-authorization-server': {
      get: {
        summary: 'OAuth Authorization Server metadata',
        responses: {
          200: { description: 'RFC 8414 OAuth metadata.' },
        },
      },
    },
    '/.well-known/oauth-protected-resource': {
      get: {
        summary: 'OAuth Protected Resource metadata',
        responses: {
          200: { description: 'RFC 9728 protected resource metadata.' },
        },
      },
    },
    '/auth.md': {
      get: {
        summary: 'Agent registration and auth notes',
        responses: {
          200: { description: 'Markdown auth metadata.' },
        },
      },
    },
    '/agent/auth/register': {
      get: {
        summary: 'Anonymous agent registration metadata',
        responses: {
          200: { description: 'Registration instructions.' },
        },
      },
      post: {
        summary: 'Register an anonymous docs-reading agent',
        responses: {
          201: { description: 'Anonymous client registration accepted.' },
        },
      },
    },
    '/agent/auth/claim': {
      get: {
        summary: 'Anonymous credential claim metadata',
        responses: {
          200: { description: 'Claim instructions for public docs access.' },
        },
      },
    },
    '/oauth/token': {
      post: {
        summary: 'Issue a public docs-read bearer token',
        responses: {
          200: { description: 'Bearer token for public docs discovery.' },
        },
      },
    },
  },
};

ensureWrite(join(distDir, '.well-known/openapi.json'), json(openapi));

ensureWrite(
  join(distDir, 'health'),
  json({ ok: true, service: 'syncular-docs', version: releaseVersion }),
);

ensureWrite(
  join(distDir, '.well-known/oauth-protected-resource'),
  json({
    resource: `${site}/`,
    resource_name: 'syncular public documentation',
    resource_documentation: `${site}/auth.md`,
    authorization_servers: [site],
    scopes_supported: ['docs:read'],
    bearer_methods_supported: ['header'],
  }),
);

ensureWrite(
  join(distDir, '.well-known/oauth-authorization-server'),
  json({
    issuer: site,
    authorization_endpoint: `${site}/oauth/authorize`,
    token_endpoint: `${site}/oauth/token`,
    jwks_uri: `${site}/oauth/jwks.json`,
    registration_endpoint: `${site}/agent/auth/register`,
    grant_types_supported: ['client_credentials'],
    response_types_supported: ['none'],
    token_endpoint_auth_methods_supported: ['none'],
    scopes_supported: ['docs:read'],
    service_documentation: `${site}/auth.md`,
    agent_auth: {
      skill: `${site}/auth.md`,
      register_uri: `${site}/agent/auth/register`,
      claim_uri: `${site}/agent/auth/claim`,
      identity_types_supported: ['anonymous'],
      credential_types_supported: ['bearer'],
      anonymous: {
        credential_types_supported: ['bearer'],
        claim_uri: `${site}/agent/auth/claim`,
      },
    },
  }),
);

ensureWrite(join(distDir, 'oauth/jwks.json'), json({ keys: [] }));

ensureWrite(
  join(distDir, 'agent/auth/register'),
  json({
    registration: 'anonymous',
    register_uri: `${site}/agent/auth/register`,
    token_endpoint: `${site}/oauth/token`,
    scopes_supported: ['docs:read'],
    token_endpoint_auth_method: 'none',
    note: 'POST to register for a public docs-reading client identifier. No user account or secret is required.',
  }),
);

ensureWrite(
  join(distDir, 'agent/auth/claim'),
  json({
    identity_type: 'anonymous',
    credential_type: 'bearer',
    token_endpoint: `${site}/oauth/token`,
    scope: 'docs:read',
    note: 'The bearer token grants access only to public syncular documentation and discovery metadata.',
  }),
);

ensureWrite(
  join(distDir, 'auth.md'),
  `# auth.md

syncular.dev serves public documentation and public discovery metadata. Agents
can read the docs without credentials, and can also register as anonymous
docs-reading agents when an OAuth-style discovery flow is required.

## Agent audience

Use these public resources when discovering syncular docs or preparing examples
for applications that embed syncular.

## Registration

Anonymous agent registration is available at:

- Register URI: ${site}/agent/auth/register
- Authorization server metadata: ${site}/.well-known/oauth-authorization-server
- Protected resource metadata: ${site}/.well-known/oauth-protected-resource

Registration does not create a user account and does not grant access to
private data. It identifies an agent as a public docs reader.

## Supported method

- Identity type: anonymous
- Credential type: bearer
- Scope: docs:read
- Token endpoint: ${site}/oauth/token
- Claim URI: ${site}/agent/auth/claim

## Credential use

Send an Authorization header only when your agent policy requires an explicit
bearer credential:

\`\`\`http
Authorization: Bearer public-docs
\`\`\`

The token grants access only to public documentation and discovery metadata.
Application-specific Syncular deployments define their own authentication and
authorization in the application server, typically by implementing scope
resolution as described in the server and scopes documentation.
`,
);

const skillBody = `# Syncular docs

Use this skill when you need to navigate, summarize, or cite the public
syncular documentation.

## Entry points

- Documentation index: ${site}/llms.txt
- API catalog: ${site}/.well-known/api-catalog
- Spec and package map: ${site}/reference/
- Source repository: https://github.com/syncular/syncular

## Agent use

- Request public HTML pages with Accept: text/markdown when you want compact
  Markdown instead of browser HTML.
- Use ${site}/.well-known/docs-index.json to enumerate canonical doc pages.
- Prefer the reference page and SPEC.md for protocol-level claims.
`;

const skillPath = '.well-known/agent-skills/syncular-docs/SKILL.md';
ensureWrite(join(distDir, skillPath), skillBody);

ensureWrite(
  join(distDir, '.well-known/agent-skills/index.json'),
  json({
    $schema: 'https://schemas.agentskills.io/discovery/0.2.0/schema.json',
    skills: [
      {
        name: 'syncular-docs',
        type: 'skill-md',
        description:
          'Navigate and consume the public syncular documentation and protocol references.',
        url: `${site}/${skillPath}`,
        digest: sha256(skillBody),
      },
    ],
  }),
);

ensureWrite(
  join(distDir, '.well-known/mcp/server-card.json'),
  json({
    serverInfo: {
      name: 'syncular-docs',
      version: releaseVersion,
    },
    transport: {
      type: 'webmcp',
      endpoint: `${site}/`,
    },
    capabilities: {
      tools: [
        'syncular_list_docs',
        'syncular_search_docs',
        'syncular_get_page_markdown',
        'syncular_open_doc',
      ],
      resources: [
        `${site}/llms.txt`,
        `${site}/.well-known/docs-index.json`,
        `${site}/.well-known/api-catalog`,
      ],
    },
    notes:
      'Browser WebMCP tools are registered on page load when navigator.modelContext is available.',
  }),
);

for (const path of [
  'index.html',
  'platform-rust/index.html',
  'platform-rust.md',
  'health',
  '.well-known/mcp/server-card.json',
]) {
  const body = readFileSync(join(distDir, path), 'utf8');
  if (body.includes('0.0.0') || !body.includes(releaseVersion)) {
    throw new Error(`${path}: release version was not reflected into dist`);
  }
}

console.log(
  `generated agent discovery assets for ${orderedPages.length + 1} pages`,
);
