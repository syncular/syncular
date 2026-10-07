import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { articleHtml, chaptersOf, readingMinutes } from '../src/blog';

const blogDir = join(import.meta.dir, '../src/content/blog');

describe('blog helpers', () => {
  test('reading time counts prose words and skips code, HTML, and frontmatter', () => {
    const prose = Array.from({ length: 460 }, () => 'word').join(' ');
    const code = `\`\`\`ts\n${Array.from({ length: 2000 }, () => 'x').join(' ')}\n\`\`\``;
    expect(
      readingMinutes(
        `---\ntitle: t\n---\n${prose}\n\n${code}\n<img alt="a b c" />`,
      ),
    ).toBe(2);
    expect(readingMinutes('short')).toBe(1);
  });

  test('h2 headings become chapters with their h3 sections', () => {
    const chapters = chaptersOf([
      { depth: 1, slug: 'title', text: 'Title' },
      { depth: 3, slug: 'orphan', text: 'Orphan' },
      { depth: 2, slug: 'a', text: 'A' },
      { depth: 3, slug: 'a1', text: 'A1' },
      { depth: 2, slug: 'b', text: 'B' },
    ]);
    expect(chapters).toEqual([
      { slug: 'a', text: 'A', sections: [{ slug: 'a1', text: 'A1' }] },
      { slug: 'b', text: 'B', sections: [] },
    ]);
  });

  test('the article drops its h1 and gains heading anchors', () => {
    const html = articleHtml(
      '<h1 id="t">Title</h1>\n<p>x</p><h2 id="a">A <code>b</code></h2><h3 id="c">C</h3><h4 id="d">D</h4>',
    );
    expect(html).not.toContain('<h1');
    expect(html).toContain(
      '<h2 id="a">A <code>b</code><a class="heading-anchor" href="#a" aria-label="Link to this section">#</a></h2>',
    );
    expect(html).toContain('href="#c"');
    expect(html).toContain('<h4 id="d">D</h4>');
  });
});

describe('blog posts', () => {
  const posts = readdirSync(blogDir).filter((name) => name.endsWith('.md'));

  test('every post has the frontmatter the layout reads and an h1', () => {
    for (const name of posts) {
      const source = readFileSync(join(blogDir, name), 'utf8');
      for (const field of ['title', 'description', 'author', 'publishedAt']) {
        expect(source, `${name}: ${field}`).toMatch(
          new RegExp(`^${field}: `, 'm'),
        );
      }
      expect(source, `${name}: h1`).toMatch(/^# /m);
    }
  });

  test('posts longer than ten minutes are split into h2 chapters', () => {
    for (const name of posts) {
      const source = readFileSync(join(blogDir, name), 'utf8');
      if (readingMinutes(source) <= 10) continue;
      expect(source.match(/^## /gm)?.length ?? 0, name).toBeGreaterThanOrEqual(
        4,
      );
    }
  });
});
