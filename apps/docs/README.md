# @syncular/docs

The documentation site — an **Astro** static site. Documentation Markdown in
`src/content/` plus the `src/nav.ts` manifest renders through
`src/pages/[slug].astro` into the teletype layout. Blog Markdown lives in
`src/content/blog/`, with an index at `/blog/` and one static page per post;
the landing page is `src/pages/index.astro`. Syntax highlighting is Shiki at
build time (`css-variables` theme, colored by the palette in
`public/style.css`), so the published site ships no highlighter JavaScript.

The build also generates agent-discovery assets from the complete docs and blog
tree: `sitemap.xml`, `robots.txt`, `llms.txt`, Markdown page copies, an RFC 9727
API catalog, an OpenAPI description for public discovery endpoints, Auth.md
notes, OAuth authorization-server and protected-resource metadata for anonymous
public docs access, and an Agent Skills index. `src/worker.ts` fronts the static
assets on Workers so homepage responses get discovery `Link` headers, `Accept:
text/markdown` returns the generated Markdown variant, and the public docs auth
endpoints can answer simple POST requests. `public/webmcp.js` registers browser
WebMCP tools when `navigator.modelContext` is available.

## Local build / dev

```sh
bun run build     # astro build + agent assets + scripts/rebase.mjs -> dist/
bun run dev       # astro dev at http://localhost:3100
```

`dist/` is a plain static bundle: one directory per page, `style.css`, and
self-hosted `fonts/` (IBM Plex Mono woff2 — no CDN at runtime). Nothing about
it is host-specific. Internal links are authored root-absolute and rewritten
to an optional `DOCS_BASE` by the post-build rebase step. The production custom
domain uses the default `/`.

The repository root `package.json` is the release-version authority. Source
install snippets use `0.0.0`; the Markdown processor, landing page, and agent
asset generator reflect the root version into `dist/` during the build.

## Deploy — Cloudflare Workers (static assets)

The site is a **Workers static-assets** deployment (worker `syncular-docs`,
Syncular account), served at the apex **https://syncular.dev** via a zone
route (`syncular.dev/*`) over the apex's existing proxied DNS record.
`wrangler.jsonc` holds the config. `.github/workflows/docs.yml` builds and
deploys documentation changes from `main`; `.github/workflows/release.yml`
also deploys the tagged version after npm and crates.io publication succeeds.
Both use the same concurrency group so deployments cannot race. The domain
serves at root, so `DOCS_BASE` stays unset.

The deployment uses a small Worker script with a static assets binding. Static
files still come from `dist/`; the Worker adds request-dependent behavior that
plain assets cannot express, such as Markdown content negotiation.

Why Workers and not Pages: the deploy identity (a wrangler API token) manages
the worker + its route but not DNS, and Pages needs a manually-created apex
DNS record. A worker zone route reuses the record that already exists, so
deploys never touch DNS.

### One-time repo setting (must be done once, by hand)

The workflow authenticates with a Cloudflare API token:

1. Cloudflare dash → My Profile → API Tokens → Create Token → template
   **"Edit Cloudflare Workers"**, scoped to the **Syncular** account (grants
   Workers Scripts:Edit + Workers Routes:Edit + Account/Zone read).
2. `gh secret set CLOUDFLARE_API_TOKEN` (paste the token at the prompt).

Until the secret exists, the deploy step fails with an auth error; the build
step still proves the site compiles.

### The apex route + DNS (set up out-of-band, deploys don't touch it)

`syncular.dev` has a proxied DNS record and a worker route `syncular.dev/*` →
`syncular-docs`. `wrangler deploy` reconciles the route from `wrangler.jsonc`
but never creates/edits DNS. To move to a clean worker **custom domain**
instead (auto-managed DNS), delete the apex A/AAAA record and re-add the
hostname as a custom domain — that step needs DNS:Edit (dashboard or a
DNS-scoped token), which the deploy token intentionally lacks.

DNS for AI Discovery (DNS-AID) is also out-of-band because it is published in
Cloudflare DNS, not in the Worker bundle. The organizational entrypoint is:

```dns
_index._agents.syncular.dev. 3600 IN SVCB 1 syncular.dev. mandatory=alpn,port alpn=h2 port=443
```

Keep DNSSEC enabled for authenticated answers.

### Manual deploy (locally authed wrangler)

```sh
bun run build
CLOUDFLARE_ACCOUNT_ID=336bfd20ccb2f56e24ac0afeca6b4837 bunx wrangler deploy
```

## Privacy-conscious engagement analytics

The docs Worker writes aggregate page and article-reading events to the
Cloudflare Workers Analytics Engine dataset `syncular_docs_engagement`. The
binding in `wrangler.jsonc` creates the dataset on first write; no JavaScript is
needed for page views. Individual blog articles load `public/engagement.js`,
which records one `article_read` after 30 visible seconds and 60% scroll depth.

The schema is deliberately stable and non-identifying:

- `blob1..11`: event, path, referrer hostname, country, broad device class,
  response status, site section, UTM source/medium/campaign, cache status.
- `double1..3`: count (`1`), active seconds, scroll depth.
- `index1`: hostname (the Analytics Engine sampling key).

No IP address, cookie, full referrer, full user agent, or stable visitor ID is
written. Requests with Global Privacy Control or Do Not Track enabled are
excluded. The public disclosure is at `/privacy/`.

Query the last seven days using the locally authenticated Wrangler identity
(it needs Account Analytics Read), or pass a token explicitly:

```sh
bun run analytics
bun run analytics -- --days 30
bun run analytics -- --days 7 --json
```

The report shows page views, qualified article reads and read rate, acquisition
sources/campaigns, and countries. Analytics Engine also appears in Cloudflare's
Analytics dashboard; data retention is three months. Requests tagged with
`utm_medium=verification` are retained for deployment diagnostics but omitted
from the CLI report.
