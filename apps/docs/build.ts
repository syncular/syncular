/**
 * The docs generator — deliberately boring (REVISE.md thesis): ~zero
 * dependencies, no framework, no client-side JS. Markdown pages + one
 * manifest → static HTML with a sidebar. `bun run build.ts` writes `dist/`;
 * `bun run build.ts --serve` rebuilds and serves on :3100.
 *
 * The markdown subset is exactly what the pages use: headings, paragraphs,
 * lists, tables, fenced code, blockquotes, and inline code, bold, links.
 * If a page needs more, add it here — do not reach for a parser dependency.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { render } from './markdown';
import { nav } from './nav';

const ROOT = import.meta.dir;
const PAGES = join(ROOT, 'pages');
const DIST = join(ROOT, 'dist');

interface Page {
  readonly slug: string; // "" for index
  readonly title: string;
  readonly html: string;
}

/** First `# Heading` becomes the <title>; strip it from the body. */
function extractTitle(markdown: string): { title: string; body: string } {
  const match = markdown.match(/^#\s+(.+)$/m);
  const title = match?.[1]?.trim() ?? 'syncular';
  return { title, body: markdown };
}

function sidebar(activeSlug: string): string {
  const sections = nav
    .map((section) => {
      const items = section.items
        .map((item) => {
          const href = item.slug === '' ? '/' : `/${item.slug}/`;
          const active = item.slug === activeSlug ? ' class="active"' : '';
          return `<li><a href="${href}"${active}>${item.title}</a></li>`;
        })
        .join('');
      return `<div class="nav-section"><h4>${section.title}</h4><ul>${items}</ul></div>`;
    })
    .join('');
  return `<nav class="sidebar">
  <a class="brand" href="/">syncular <span>v2</span></a>
  ${sections}
</nav>`;
}

function layout(page: Page): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${page.title} — syncular v2</title>
<link rel="stylesheet" href="/style.css">
</head>
<body>
${sidebar(page.slug)}
<main><article>${page.html}</article></main>
</body>
</html>`;
}

function loadPages(): Page[] {
  const files = readdirSync(PAGES).filter((f) => f.endsWith('.md'));
  return files.map((file) => {
    const markdown = readFileSync(join(PAGES, file), 'utf8');
    const slug = file === 'index.md' ? '' : file.replace(/\.md$/, '');
    const { title, body } = extractTitle(markdown);
    return { slug, title, html: render(body) };
  });
}

async function build(): Promise<Page[]> {
  await rm(DIST, { recursive: true, force: true });
  await mkdir(DIST, { recursive: true });
  const pages = loadPages();
  for (const page of pages) {
    const dir = page.slug === '' ? DIST : join(DIST, page.slug);
    await mkdir(dir, { recursive: true });
    await Bun.write(join(dir, 'index.html'), layout(page));
  }
  await Bun.write(join(DIST, 'style.css'), Bun.file(join(ROOT, 'style.css')));
  return pages;
}

const pages = await build();
console.log(`docs: built ${pages.length} pages → dist/`);

if (process.argv.includes('--serve')) {
  const port = Number(process.env.PORT ?? 3100);
  const server = Bun.serve({
    port,
    async fetch(request) {
      const url = new URL(request.url);
      let path = url.pathname;
      // Rebuild on every request in dev so edits show up on refresh.
      await build();
      if (path === '/style.css') {
        return new Response(Bun.file(join(DIST, 'style.css')));
      }
      if (path.endsWith('/')) path += 'index.html';
      else if (!path.includes('.')) path += '/index.html';
      const file = Bun.file(join(DIST, path.replace(/^\//, '')));
      if (await file.exists()) return new Response(file);
      return new Response('not found', { status: 404 });
    },
  });
  console.log(`docs dev server: http://localhost:${server.port}`);
}
