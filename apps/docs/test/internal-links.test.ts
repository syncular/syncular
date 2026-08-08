import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

// Every internal link in reader-facing sources must resolve to a page the
// build produces, and every anchored link must resolve to a real heading.
// Docs pages move; this test is what makes moving them safe.

const docsRoot = join(import.meta.dir, '..');
const contentDir = join(docsRoot, 'src/content');

const walk = (dir: string, ext: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return walk(path, ext);
    return entry.isFile() && entry.name.endsWith(ext) ? [path] : [];
  });

const contentFiles = walk(contentDir, '.md');

// Pages the build produces: one per content markdown file, plus the
// non-markdown routes (landing, playground, changelog, blog index).
const knownPaths = new Set<string>([
  '/',
  '/playground/',
  '/changelog/',
  '/blog/',
]);
for (const file of contentFiles) {
  const slug = relative(contentDir, file)
    .replaceAll('\\', '/')
    .replace(/\.md$/, '');
  knownPaths.add(`/${slug}/`);
}

// GitHub-slugger shape, matching Astro's markdown heading ids.
const slugify = (heading: string): string =>
  heading
    .toLowerCase()
    .replaceAll(/`/g, '')
    .replaceAll(/[^\p{L}\p{N}\s-]/gu, '')
    .trim()
    .replaceAll(/\s+/g, '-');

const anchorsBySlug = new Map<string, Set<string>>();
for (const file of contentFiles) {
  const slug = relative(contentDir, file)
    .replaceAll('\\', '/')
    .replace(/\.md$/, '');
  const anchors = new Set<string>();
  for (const match of readFileSync(file, 'utf8').matchAll(
    /^#{1,6}\s+(.+)$/gm,
  )) {
    const heading = match[1];
    if (heading === undefined) continue;
    anchors.add(slugify(heading.replaceAll(/\[([^\]]*)\]\([^)]*\)/g, '$1')));
  }
  anchorsBySlug.set(slug, anchors);
}

interface InternalLink {
  readonly source: string;
  readonly href: string;
}

const links: InternalLink[] = [];
const sources = [
  ...contentFiles,
  ...walk(join(docsRoot, 'src/pages'), '.astro'),
  ...walk(join(docsRoot, 'src/layouts'), '.astro'),
];
for (const file of sources) {
  const body = readFileSync(file, 'utf8');
  const source = relative(docsRoot, file);
  // Markdown links and HTML/JSX hrefs to site-internal paths.
  for (const match of body.matchAll(/\]\((\/[^)\s]*)\)|href="(\/[^"]*)"/g)) {
    const href = match[1] ?? match[2];
    if (href !== undefined) links.push({ source, href });
  }
  // Relative markdown-file links are always wrong in this build: the page
  // URL is /<slug>/, so `](concepts-x.md)` resolves to a 404.
  for (const match of body.matchAll(/\]\(([^)/:\s]+\.md[^)]*)\)/g)) {
    links.push({ source, href: `RELATIVE:${match[1]}` });
  }
}

describe('internal links', () => {
  test('found a plausible number of links', () => {
    expect(links.length).toBeGreaterThan(100);
  });

  test('every internal link resolves to a built page', () => {
    const broken: string[] = [];
    for (const { source, href } of links) {
      if (href.startsWith('RELATIVE:')) {
        broken.push(
          `${source}: ${href.slice('RELATIVE:'.length)} (relative .md link)`,
        );
        continue;
      }
      const path = href.split(/[#?]/)[0] ?? href;
      // Non-page assets served from public/ or generated at build time.
      if (/\.(md|css|js|svg|png|txt|json|xml)$/.test(path)) continue;
      if (path.startsWith('/.well-known/')) continue;
      if (path.startsWith('/blog/') && path !== '/blog/') {
        const slug = `blog/${path.slice('/blog/'.length).replace(/\/$/, '')}`;
        if (!anchorsBySlug.has(slug)) broken.push(`${source}: ${href}`);
        continue;
      }
      if (!knownPaths.has(path)) broken.push(`${source}: ${href}`);
    }
    expect(broken).toEqual([]);
  });

  test('every anchored link resolves to a heading on the target page', () => {
    const broken: string[] = [];
    for (const { source, href } of links) {
      if (href.startsWith('RELATIVE:') || !href.includes('#')) continue;
      const [path = '', anchor] = (href.split('?')[0] ?? href).split('#');
      const slug = path.replaceAll(/^\/|\/$/g, '');
      const anchors = anchorsBySlug.get(slug);
      // Pages outside src/content (playground, changelog) have no markdown
      // headings to check against.
      if (anchors === undefined) continue;
      if (anchor !== undefined && anchor !== '' && !anchors.has(anchor)) {
        broken.push(`${source}: ${href}`);
      }
    }
    expect(broken).toEqual([]);
  });
});
