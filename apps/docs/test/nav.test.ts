import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { nav, navPages, neighbors, redirects, sdks } from '../src/nav';
import worker from '../src/worker';
import { headingAnchors } from './anchors';

const contentDir = join(import.meta.dir, '../src/content');
const contentSlugs = readdirSync(contentDir)
  .filter((name) => name.endsWith('.md'))
  .map((name) => name.replace(/\.md$/, ''));
// Routes that are not markdown content files.
const routeSlugs = ['playground', 'changelog', 'blog'];

describe('nav manifest', () => {
  test('lists every content page exactly once', () => {
    const listed = navPages.map((entry) => entry.slug);
    expect(new Set(listed).size).toBe(listed.length);
    expect(
      [...listed].filter((slug) => !routeSlugs.includes(slug)).sort(),
    ).toEqual([...contentSlugs].sort());
  });

  test('groups appear in the documented order', () => {
    expect(nav.map((group) => group.title)).toEqual([
      'Start',
      'Core model',
      'Build your app',
      'Run your server',
      'Optional features',
      'Reference',
      'Project',
    ]);
  });

  test('SDK pages read between the Core model and the task guides', () => {
    const web = sdks.find((sdk) => sdk.id === 'web');
    const slug = web?.pages[0]?.slug ?? '';
    expect(neighbors(slug).prev?.slug).toBe('concepts-schema-upgrades');
    expect(neighbors(slug).next?.slug).toBe('platform-web-install');
    expect(neighbors('platform-web-troubleshooting').next?.slug).toBe(
      'guide-schema',
    );
    expect(neighbors('guide-schema').prev?.slug).toBe(
      'concepts-schema-upgrades',
    );
    expect(neighbors('what-is').prev).toBeUndefined();
    expect(neighbors('privacy').next).toBeUndefined();
  });
});

describe('redirects', () => {
  test('old slugs are gone and targets resolve to a page and heading', () => {
    for (const [old, target] of Object.entries(redirects)) {
      expect(contentSlugs).not.toContain(old);
      const [path = '', anchor] = target.split('#');
      const slug = path.replaceAll('/', '');
      expect(contentSlugs).toContain(slug);
      if (anchor === undefined) continue;
      const headings = headingAnchors(
        readFileSync(join(contentDir, `${slug}.md`), 'utf8'),
      );
      expect([...headings]).toContain(anchor);
    }
  });

  test('the Worker answers 301 for pages, bare paths, and Markdown copies', async () => {
    const env = {
      ASSETS: { fetch: async () => new Response('missing', { status: 404 }) },
      ANALYTICS: { writeDataPoint: () => undefined },
    };
    const location = async (path: string) => {
      const response = await worker.fetch(
        new Request(`https://syncular.dev${path}`),
        env,
      );
      expect(response.status).toBe(301);
      return response.headers.get('location');
    };
    expect(await location('/guide-vite/')).toBe(
      'https://syncular.dev/platform-web-install/',
    );
    expect(await location('/server-backup-restore')).toBe(
      'https://syncular.dev/server-operations/#backup-and-restore',
    );
    expect(await location('/guide-conformance.md')).toBe(
      'https://syncular.dev/reference.md',
    );
    expect(await location('/guide-client/')).toBe(
      'https://syncular.dev/platform-web/',
    );
  });
});
