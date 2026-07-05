# @syncular-v2/docs

The documentation site — a deliberately boring static generator (REVISE.md
thesis): ~zero dependencies, no framework, no client-side JS. Markdown pages in
`pages/` plus a `nav.ts` manifest render to static HTML with a sidebar.

## Local build / dev

```sh
bun run build     # writes dist/ (15 pages today)
bun run dev       # rebuild-on-request server at http://localhost:3100
```

`dist/` is a plain static bundle: `index.html` + one directory per page + a
single `style.css`. Nothing about it is host-specific.

## Deploy — GitHub Pages

`.github/workflows/docs.yml` builds this package and publishes `dist/` to
**GitHub Pages** on every push to `main` that touches `apps/docs/**` (or the
workflow itself). It uses `actions/upload-pages-artifact` + `actions/deploy-pages`
— the zero-external-service default, nothing to provision beyond the repo.

### One-time repo setting (must be done once, by hand)

The workflow deploys via **GitHub Actions**, which requires the Pages source to
be set to Actions. This is a repository setting, not something a workflow can (or
should) flip for you:

> **Settings → Pages → Build and deployment → Source → "GitHub Actions"**

Until that is set, the `deploy` job fails with a "Pages not enabled / not
configured for Actions" error — the build still succeeds, so the artifact is
produced, but nothing publishes. Set it once and every subsequent push deploys.

This repo setting is intentionally NOT assumed or enabled by any code here.

### Swapping the host (custom domain / Cloudflare Pages)

The generator and the workflow's `build` job are host-agnostic; only the
`deploy` job is Pages-specific. To move:

- **Custom domain on GitHub Pages** — add a `CNAME` file to `dist/` (e.g. emit
  it from `build.ts`, or add a copy step) and set the domain under Settings →
  Pages. No workflow change beyond that.
- **Cloudflare Pages (or any other static host)** — keep the `build` job, drop
  the `upload-pages-artifact`/`deploy-pages` steps and the Pages
  `permissions`/`environment`, and add that host's publish step (e.g.
  `cloudflare/wrangler-action` with a `CLOUDFLARE_API_TOKEN` secret pointing at
  `apps/docs/dist`). The built `dist/` is the same static bundle either way.
