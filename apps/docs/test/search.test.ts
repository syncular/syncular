import { describe, expect, test } from 'bun:test';
import { highlight, searchIndex, searchSections } from '../src/search';

const html = `<h1 id="authentication">Authentication</h1>
<p>Your server owns identity.</p>
<h2 id="what-authenticate-returns">What <code>authenticate</code> returns</h2>
<p>A <code>null</code> result answers HTTP 401 &amp; <code>sync.auth_required</code>.</p>
<h3 id="empty">Empty</h3>
<h2 id="browser-send-and-rotate-the-header">Browser: send and rotate the header</h2>
<pre><code><span>handle.setHeaders</span>(&#123; Authorization &#125;)</code></pre>`;

describe('searchSections', () => {
  test('splits a page at h1-h3 into anchored plain-text sections', () => {
    expect(searchSections('Authentication', 'guide-auth', html)).toEqual([
      {
        page: 'Authentication',
        heading: 'Authentication',
        href: '/guide-auth/',
        text: 'Your server owns identity.',
      },
      {
        page: 'Authentication',
        heading: 'What authenticate returns',
        href: '/guide-auth/#what-authenticate-returns',
        text: 'A null result answers HTTP 401 & sync.auth_required.',
      },
      {
        page: 'Authentication',
        heading: 'Browser: send and rotate the header',
        href: '/guide-auth/#browser-send-and-rotate-the-header',
        text: 'handle.setHeaders ({ Authorization })',
      },
    ]);
  });
});

describe('searchIndex', () => {
  const sections = [
    {
      page: 'Server setup',
      heading: 'Server setup',
      href: '/guide-server/',
      text: 'authenticate maps a request to an actor',
    },
    ...searchSections('Authentication', 'guide-auth', html),
  ];

  test('requires every term and ranks heading hits above body hits', () => {
    const hits = searchIndex(sections, 'authenticate');
    expect(hits.map((hit) => hit.section.href)).toEqual([
      '/guide-auth/#what-authenticate-returns',
      '/guide-server/',
    ]);
    expect(searchIndex(sections, 'authenticate teapot')).toEqual([]);
    expect(searchIndex(sections, '   ')).toEqual([]);
  });

  test('matches identifiers inside code and excerpts around the hit', () => {
    const [hit] = searchIndex(sections, 'setheaders');
    expect(hit?.section.href).toBe(
      '/guide-auth/#browser-send-and-rotate-the-header',
    );
    expect(hit?.excerpt).toContain('setHeaders');
  });
});

describe('highlight', () => {
  test('escapes markup and marks every term case-insensitively', () => {
    expect(highlight('<b> Auth and auth', 'auth')).toBe(
      '&lt;b&gt; <mark>Auth</mark> and <mark>auth</mark>',
    );
    expect(highlight('a.b', '.')).toBe('a<mark>.</mark>b');
  });
});
