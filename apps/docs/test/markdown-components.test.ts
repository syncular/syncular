import { createSatteriMarkdownProcessor } from '@astrojs/markdown-satteri';
import { describe, expect, test } from 'bun:test';
import {
  docsComponents,
  fileTree,
  githubSlug,
  parseMeta,
  specAnchor,
} from '../src/markdown-components';

// The same processor and options astro.config.mjs uses, with Shiki on so the
// tests also prove highlighting reaches code inside components.
const processor = await createSatteriMarkdownProcessor({
  syntaxHighlight: 'shiki',
  shikiConfig: { theme: 'css-variables' },
  features: { directive: true },
  mdastPlugins: [docsComponents],
});
const render = async (markdown: string) =>
  (
    await processor.render(markdown, {
      fileURL: new URL('file:///docs/test-page.md'),
    })
  ).code;

describe('callouts', () => {
  test('each type renders a labelled aside with markdown inside', async () => {
    const out = await render(
      ':::rule{title="Omission unsubscribes"}\nSee [Scopes](/concepts-scopes/).\n:::',
    );
    expect(out).toContain('<aside class="callout rule">');
    expect(out).toContain(
      '<p class="callout-label">■ Omission unsubscribes</p>',
    );
    expect(out).toContain('<a href="/concepts-scopes/">Scopes</a>');
    const labels = { note: '● Note', tip: '✓ Tip', warning: '▲ Warning' };
    for (const [type, label] of Object.entries(labels)) {
      expect(await render(`:::${type}\nx\n:::`)).toContain(label);
    }
  });
});

describe('steps', () => {
  const md = [
    '::::steps',
    ':::step{title="Scaffold the project" time="1 min"}',
    '```bash',
    'bun create syncular-app my-app',
    '```',
    '',
    '::checkpoint[The terminal prints `ok`.]',
    ':::',
    ':::step{title="Run it"}',
    'Run.',
    ':::',
    '::::',
  ].join('\n');

  test('render as an ordered list with h3 titles, time, and checkpoint', async () => {
    const out = await render(md);
    expect(out).toContain('<ol class="steps">');
    expect(out.match(/<li class="step">/g)?.length).toBe(2);
    expect(out).toMatch(
      /<h3 id="scaffold-the-project">Scaffold the project<\/h3>/,
    );
    expect(out).toContain('<p class="step-time">≈ 1 min</p>');
    expect(out).toContain(
      '<p class="checkpoint">The terminal prints <code>ok</code>.</p>',
    );
  });

  test('step titles reach the page headings used by the contents rail', async () => {
    const { metadata } = await processor.render(md, {});
    expect(metadata.headings.map((h) => h.text)).toEqual([
      'Scaffold the project',
      'Run it',
    ]);
  });

  test('a step holds callouts when its fence is longer than theirs', async () => {
    const out = await render(
      ':::::steps\n::::step{title="A"}\n:::rule\ninner\n:::\n::::\n:::::',
    );
    expect(out).toContain(
      '<li class="step"><h3 id="a">A</h3><aside class="callout rule">',
    );
    // Equal fences close the step early; the steps check reports it.
    await expect(
      render(
        '::::steps\n:::step{title="A"}\n:::rule\ninner\n:::\nafter\n:::\n::::',
      ),
    ).rejects.toThrow('docs.steps_child_not_step');
  });

  test('a step outside steps and a stray block inside steps fail the build', async () => {
    await expect(render(':::step{title="x"}\ny\n:::')).rejects.toThrow(
      'docs.step_outside_steps',
    );
    await expect(render('::::steps\nloose text\n::::')).rejects.toThrow(
      'docs.steps_child_not_step',
    );
  });
});

describe('figures', () => {
  test('number in document order, keep raw HTML, and take a caption', async () => {
    const out = await render(
      [
        ':::figure{title="Two lists" note="One round" ticks}',
        '<div class="node hot">Commit log</div>',
        '',
        '::caption[Pull rows down; push writes up.]',
        ':::',
        '',
        ':::figure{title="Second"}',
        '```',
        'a --> b',
        '```',
        ':::',
      ].join('\n'),
    );
    expect(out).toContain(
      '<figure class="fig ticks"><span class="tk-b"></span>',
    );
    expect(out).toContain(
      '<b>Fig. 1</b> · Two lists</span><span class="fig-note">One round</span>',
    );
    expect(out).toContain('<div class="node hot">Commit log</div>');
    expect(out).toContain(
      '<figcaption>Pull rows down; push writes up.</figcaption>',
    );
    expect(out).toContain('<b>Fig. 2</b> · Second');
    // A fence inside a figure is the diagram itself: no code frame or copy button.
    expect(out.split('Fig. 2')[1]).not.toContain('code-copy');
  });

  test('a figure needs a title', async () => {
    await expect(render(':::figure\nx\n:::')).rejects.toThrow(
      'docs.figure_missing_title',
    );
  });
});

describe('code', () => {
  test('every fence gets a frame, an optional title, and a copy button', async () => {
    const out = await render('```ts title="src/server.ts"\nconst a = 1;\n```');
    expect(out).toMatch(
      /<div class="code">\s*<div class="code-bar"><span class="code-file">src\/server\.ts<\/span>/,
    );
    expect(out).toContain('class="code-copy"');
    expect(out).toContain('astro-code');
  });

  test('tabs render one panel per SDK, highlighted, with the pick map', async () => {
    const out = await render(
      [
        ':::tabs',
        '```ts sdk=web title="src/sync.ts"',
        "client.subscribe({ id: 'todos' });",
        '```',
        '```swift sdk=swift',
        'try client.subscribe(id: "todos")',
        '```',
        ':::',
      ].join('\n'),
    );
    expect(out).toContain('class="code tabs" data-sync="sdk"');
    expect(out).toContain(
      '<button type="button" role="tab" data-tab="web" aria-selected="true">Browser</button>',
    );
    expect(out).toContain(
      'data-tab="swift" aria-selected="false">Swift</button>',
    );
    expect(out.match(/class="tab-panel"/g)?.length).toBe(2);
    expect(out).toMatch(/data-tab="swift"[^>]*hidden/);
    expect(out.match(/<pre class="astro-code/g)?.length).toBe(2);
    const pick = JSON.parse(
      (/data-pick="([^"]+)"/.exec(out)?.[1] ?? '{}')
        .replaceAll('&#x22;', '"')
        .replaceAll('&quot;', '"'),
    ) as Record<string, string>;
    // React and Tauri fall back to the Browser sample; Kotlin has none and opens the first.
    expect(pick).toMatchObject({
      web: 'web',
      swift: 'swift',
      react: 'web',
      tauri: 'web',
      kotlin: 'web',
    });
  });

  test('tabs reject unknown SDKs and non-code children', async () => {
    await expect(
      render(':::tabs\n```ts sdk=java\nx\n```\n:::'),
    ).rejects.toThrow('docs.tabs_unknown_sdk');
    await expect(render(':::tabs\nprose\n:::')).rejects.toThrow(
      'docs.tabs_child_not_code',
    );
  });

  test('labelled tabs are not SDK-synced', async () => {
    const out = await render(
      ':::tabs\n```sh label=bun\nbun x\n```\n```sh label=npm\nnpx x\n```\n:::',
    );
    expect(out).toContain('class="code tabs"');
    expect(out).not.toContain('data-sync');
  });

  test('output and tree fences', async () => {
    const output = await render('```output\n✓ converged\n```');
    expect(output).toContain('<div class="code output">');
    expect(output).toContain('Expected output');
    const tree = await render(
      '```tree title="my-app/"\nsrc/\n  server.ts   # the server\n```',
    );
    expect(tree).toContain(
      '<li style="--level:1"><span class="file">server.ts</span><span class="note">the server</span></li>',
    );
    expect(tree).not.toContain('code-copy');
  });
});

describe('terms, meta, and text directives', () => {
  test('terms become an open details block the page script can move', async () => {
    const out = await render(
      ':::terms\n- **Cursor**: The last commit applied.\n- **Outbox**: Pending writes.\n:::',
    );
    expect(out).toContain(
      '<details class="terms" data-terms><summary>Terms on this page · 2</summary>',
    );
    expect(out).toContain('<strong>Cursor</strong>The last commit applied.');
    await expect(render(':::terms\n- plain item\n:::')).rejects.toThrow(
      'docs.terms_item_shape',
    );
  });

  test('meta resolves page titles and SPEC anchors, and rejects unknown values', async () => {
    const out = await render(
      '::meta{for="App developers" time="8 min" first="quickstart" spec="4 7"}',
    );
    expect(out).toContain('<dt>For</dt><dd>App developers</dd>');
    expect(out).toContain('<a href="/quickstart/">Quickstart</a>');
    expect(out).toContain('SPEC.md#4-subscriptions-cursors-pull">§4</a>');
    await expect(render('::meta{first="nope"}')).rejects.toThrow(
      'docs.meta_unknown_page',
    );
    await expect(render('::meta{spec="99"}')).rejects.toThrow(
      'docs.meta_unknown_spec_section',
    );
    await expect(render('::meta{audience="x"}')).rejects.toThrow(
      'docs.meta_unknown_field',
    );
  });

  test('prose colons survive; unknown directives fail', async () => {
    const out = await render(
      'It runs on bun:sqlite at 12:30, scope list:{list_id}.',
    );
    expect(out).toContain('bun:sqlite at 12:30, scope list:{list_id}.');
    await expect(render(':::sidebar\nx\n:::')).rejects.toThrow(
      'docs.unknown_directive: :::sidebar',
    );
    await expect(render('::video{src=x}')).rejects.toThrow(
      'docs.unknown_directive: ::video',
    );
  });
});

describe('helpers', () => {
  test('parseMeta reads bare and quoted values', () => {
    expect(parseMeta('sdk=web title="src/a b.ts" flag')).toEqual({
      sdk: 'web',
      title: 'src/a b.ts',
      flag: '',
    });
  });
  test('githubSlug and specAnchor match the anchors GitHub renders', () => {
    expect(githubSlug('4.2 `PULL_HEADER` frame')).toBe('42-pull_header-frame');
    expect(specAnchor('3.3')).toEndWith(
      '#33-revocation-and-the-purge-contract',
    );
  });
  test('fileTree marks directories and indentation', () => {
    expect(fileTree('a/\n  b.ts')).toBe(
      '<ul class="tree"><li style="--level:0"><span class="dir">a/</span></li><li style="--level:1"><span class="file">b.ts</span></li></ul>',
    );
  });
});
