# @syncular/docs

The documentation site — an **Astro** static site. Markdown pages in
`src/content/` plus the `src/nav.ts` manifest render through
`src/pages/[slug].astro` into the teletype layout; the landing page is
`src/pages/index.astro`. Syntax highlighting is Shiki at build time
(`css-variables` theme, colored by the palette in `public/style.css`), so the
published site ships no highlighter JavaScript. The only client-side script on
the whole site is the landing hero's ASCII black-hole simulation, inline in
`index.astro` — it is the design language, not a framework.

## Local build / dev

```sh
bun run build     # astro build + scripts/rebase.mjs → dist/
bun run dev       # astro dev at http://localhost:3100
```

`dist/` is a plain static bundle: one directory per page, `style.css`, and
self-hosted `fonts/` (IBM Plex Mono woff2 — no CDN at runtime). Nothing about
it is host-specific. Internal links are authored root-absolute and rewritten
to `DOCS_BASE` by the post-build rebase step (the Pages workflow sets
`DOCS_BASE=/syncular/`; a custom domain uses the default `/`).

## Deploy — Cloudflare Pages

`.github/workflows/docs.yml` builds this package and publishes `dist/` to
**Cloudflare Pages** (project `syncular-docs`, Syncular account) on every push
to `main` that touches `apps/docs/**` or the workflow itself. Production URL:
https://syncular-docs.pages.dev — Pages serves at the domain root, so
`DOCS_BASE` stays unset.

### One-time repo setting (must be done once, by hand)

The workflow authenticates with a Cloudflare API token:

1. Cloudflare dash → My Profile → API Tokens → Create Token → template
   **"Cloudflare Pages — Edit"**, scoped to the **Syncular** account.
2. `gh secret set CLOUDFLARE_API_TOKEN` (paste the token at the prompt).

Until the secret exists, the deploy step fails with an auth error; the build
step still proves the site compiles.

### Custom domain

Add it in the Pages dashboard (syncular-docs → Custom domains). No workflow or
generator change needed — links are root-absolute and the domain serves at
root. (`DOCS_BASE` + `scripts/rebase.mjs` remain for any future subpath host.)

### Manual deploy (locally authed wrangler)

```sh
bun run build
CLOUDFLARE_ACCOUNT_ID=336bfd20ccb2f56e24ac0afeca6b4837 \
  bunx wrangler pages deploy dist --project-name syncular-docs --branch main
```
