import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const srcDir = join(import.meta.dir, '../src');
const read = (path: string) =>
  readFileSync(join(import.meta.dir, '..', path), 'utf8');

const astroFiles = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return astroFiles(path);
    return path.endsWith('.astro') ? [path] : [];
  });
const files = astroFiles(srcDir).map((path) => ({
  path: path.slice(srcDir.length + 1),
  text: readFileSync(path, 'utf8'),
}));

describe('one client-routed app', () => {
  test('PageMeta mounts the router and the site-wide scripts', () => {
    const meta = read('src/components/PageMeta.astro');
    expect(meta).toContain('<ClientRouter fallback="swap" />');
    expect(meta).toContain('<script src="/webmcp.js" defer>');
    expect(meta).toContain('<script src="/engagement.js" defer>');
  });

  test('every full document renders PageMeta, so no navigation reloads the page', () => {
    const documents = files.filter(({ text }) => /<html[\s>]/.test(text));
    expect(documents.map(({ path }) => path).sort()).toEqual([
      'layouts/Blog.astro',
      'layouts/Docs.astro',
      'pages/index.astro',
    ]);
    for (const { path, text } of documents) {
      expect({ path, meta: text.includes('<PageMeta') }).toEqual({
        path,
        meta: true,
      });
    }
  });

  test('every page type renders through a layout or PageMeta', () => {
    const pages = files.filter(
      ({ path }) => path.startsWith('pages/') && path.endsWith('.astro'),
    );
    for (const { path, text } of pages) {
      expect({
        path,
        shell:
          /<(Docs|Blog|PageMeta)[\s>]/.test(text) || text.includes('<html'),
      }).toEqual({
        path,
        shell: true,
      });
    }
  });

  test('prefetch is configured', () => {
    expect(read('astro.config.mjs')).toMatch(
      /prefetch:\s*\{[^}]*prefetchAll:\s*true/,
    );
  });

  test('inline scripts rerun on every swap or live in the shared head', () => {
    for (const { path, text } of files) {
      for (const match of text.matchAll(/<script\s+is:inline([^>]*)>/g)) {
        const rerun = (match[1] ?? '').includes('data-astro-rerun');
        expect({
          path,
          ok: rerun || path === 'components/PageMeta.astro',
        }).toEqual({ path, ok: true });
      }
    }
  });

  test('same-origin links to non-HTML files do a full load', () => {
    for (const { path, text } of files) {
      for (const match of text.matchAll(
        /<a\s[^>]*href=\{?[`"']\/[^>]*\.(?:md|txt|xml)[`"'][^>]*>/g,
      )) {
        expect({
          path,
          tag: match[0],
          reload: match[0].includes('data-astro-reload'),
        }).toEqual({
          path,
          tag: match[0],
          reload: true,
        });
      }
    }
  });
});
