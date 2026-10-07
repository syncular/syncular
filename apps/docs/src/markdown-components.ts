/**
 * Content components for `src/content/*.md`, as one Sätteri mdast plugin.
 * Authors write CommonMark plus `:::` directives and two fenced-block
 * languages; this plugin turns them into the classed HTML that src/docs.css
 * styles and the Docs.astro script wires up. The authoring guide is the
 * "Docs authoring" section of content/contributing.md.
 *
 *   :::note / :::tip / :::rule / :::warning{title="…"}   callouts
 *   ::::steps + :::step{title="…" time="…"}               numbered steps
 *   ::checkpoint[…]                                        step result
 *   :::figure{title="…" note="…" ticks}  + ::caption[…]   numbered figures
 *   :::tabs  + ```lang sdk=<id> title="…"                 SDK code tabs
 *   :::terms + a `- **Term**: definition` list             page glossary
 *   ::meta{for="…" time="…" first="<slug>" spec="4 7"}     page meta strip
 *   ```tree / ```output                                    file tree, output
 *
 * Every fenced code block gets a frame with an optional `title="…"` and a
 * copy button. Unknown directives fail the build; text directives (which
 * the parser also produces for prose like `bun:sqlite`) are restored to
 * their source text, because the docs define none.
 */
import type { SatteriProcessorOptions } from '@astrojs/markdown-satteri';
import { readFileSync } from 'node:fs';
import { navPages, sampleFallback, sdks } from './nav';

type PluginEntry = NonNullable<SatteriProcessorOptions['mdastPlugins']>[number];
// The entry union also admits factories and arrays; keep the definition.
type MdastPlugin = Exclude<
  PluginEntry,
  | null
  | undefined
  | false
  | readonly unknown[]
  | ((...args: never[]) => unknown)
>;
type Visitor<K extends keyof MdastPlugin> = NonNullable<MdastPlugin[K]>;
type Context = Parameters<Visitor<'code'>>[1];
type ContainerNode = Parameters<Visitor<'containerDirective'>>[0];
type LeafNode = Parameters<Visitor<'leafDirective'>>[0];
type CodeNode = Parameters<Visitor<'code'>>[0];
type HtmlNode = Parameters<Visitor<'html'>>[0];
type BoxNode = Parameters<Visitor<'blockquote'>>[0];

const escapeHtml = (value: string): string =>
  value.replace(
    /[&<>"]/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] ?? c,
  );

const html = (value: string): HtmlNode => ({ type: 'html', value });

/**
 * A plain parent rendered as `<div>` (or another tag) with classes. mdast has
 * no generic container, so a blockquote carries the `hName` override.
 */
const box = (
  className: string,
  children: BoxNode['children'],
  properties: Record<string, string | boolean> = {},
  tag = 'div',
): BoxNode => {
  const data = {
    hName: tag,
    hProperties: { className: className.split(' '), ...properties },
  };
  return { type: 'blockquote', data, children };
};

/** `key=value` and `key="value with spaces"` pairs from a code fence meta. */
export function parseMeta(
  meta: string | null | undefined,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const match of (meta ?? '').matchAll(
    /([\w-]+)(?:=(?:"([^"]*)"|(\S+)))?/g,
  )) {
    const [, key, quoted, bare] = match;
    if (key) out[key] = quoted ?? bare ?? '';
  }
  return out;
}

const CALLOUTS: Record<string, { glyph: string; label: string }> = {
  note: { glyph: '●', label: 'Note' },
  tip: { glyph: '✓', label: 'Tip' },
  rule: { glyph: '■', label: 'Rule' },
  warning: { glyph: '▲', label: 'Warning' },
};

/** GitHub's heading anchor: lowercase, punctuation dropped, spaces to hyphens. */
export const githubSlug = (text: string): string =>
  text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, '')
    .replace(/\s/g, '-');

const SPEC_URL = 'https://github.com/syncular/syncular/blob/main/docs/SPEC.md';
let specAnchors: Map<string, string> | undefined;
/** SPEC.md section number ("4", "3.3") to its GitHub anchor. */
export function specAnchor(section: string): string {
  specAnchors ??= new Map(
    [
      ...readFileSync(
        new URL('../../../docs/SPEC.md', import.meta.url),
        'utf8',
      ).matchAll(/^#{2,3} (\d+(?:\.\d+)?)\.? (.+)$/gm),
    ].map(([, number, title]) => [
      number ?? '',
      githubSlug(`${number} ${title}`.replace(/^(\d+)\. /, '$1 ')),
    ]),
  );
  const anchor = specAnchors.get(section);
  if (!anchor)
    throw new Error(
      `docs.meta_unknown_spec_section: SPEC.md has no section ${section}`,
    );
  return `${SPEC_URL}#${anchor}`;
}

const pageTitle = (slug: string): string => {
  const page = navPages.find((entry) => entry.slug === slug);
  if (!page)
    throw new Error(`docs.meta_unknown_page: "${slug}" is not in nav.ts`);
  return page.title;
};

/** Escaped text with `code` spans, for attribute values that name APIs. */
const inlineCode = (value: string): string =>
  escapeHtml(value).replace(/`([^`]+)`/g, '<code>$1</code>');

/**
 * Meta strip fields in display order. `first` and `spec` resolve to links;
 * the rest are text with optional `code` spans. SDK overview pages use the
 * runs/package/threading facts.
 */
const META_FIELDS = [
  'for',
  'runs',
  'package',
  'threading',
  'time',
  'first',
  'spec',
] as const;
const META_LABELS: Record<(typeof META_FIELDS)[number], string> = {
  for: 'For',
  runs: 'Runs on',
  package: 'Package',
  threading: 'Threading',
  time: 'Time',
  first: 'Read first',
  spec: 'Spec',
};

function metaStrip(
  attributes: Record<string, string | null | undefined>,
): string {
  for (const key of Object.keys(attributes)) {
    if (!(META_FIELDS as readonly string[]).includes(key)) {
      throw new Error(`docs.meta_unknown_field: ${key}`);
    }
  }
  const cells = META_FIELDS.flatMap((field): [string, string][] => {
    const value = attributes[field];
    if (!value) return [];
    if (field === 'first') {
      return [
        [
          META_LABELS[field],
          value
            .split(/\s+/)
            .map(
              (slug) =>
                `<a href="/${slug}/">${escapeHtml(pageTitle(slug))}</a>`,
            )
            .join(' · '),
        ],
      ];
    }
    if (field === 'spec') {
      return [
        [
          META_LABELS[field],
          value
            .split(/\s+/)
            .map(
              (section) =>
                `<a href="${specAnchor(section)}">§${escapeHtml(section)}</a>`,
            )
            .join(' · '),
        ],
      ];
    }
    return [[META_LABELS[field], inlineCode(value)]];
  });
  return `<dl class="meta">${cells.map(([k, v]) => `<div><dt>${k}</dt><dd>${v}</dd></div>`).join('')}</dl>`;
}

/** A `tree` fence: one path per line, two-space indent per level, `# note`. */
export function fileTree(source: string): string {
  const items = source
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => {
      const [, indent = '', rest = ''] = /^(\s*)(.*)$/.exec(line) ?? [];
      const [path = '', ...note] = rest.split(/\s+#\s?/);
      const level = Math.floor(indent.length / 2);
      const name = path.trim();
      return `<li style="--level:${level}"><span class="${name.endsWith('/') ? 'dir' : 'file'}">${escapeHtml(name)}</span>${note.length > 0 ? `<span class="note">${escapeHtml(note.join(' # '))}</span>` : ''}</li>`;
    });
  return `<ul class="tree">${items.join('')}</ul>`;
}

const codeBar = (title: string, extra = '', copy = true): string =>
  `<div class="code-bar">${extra}<span class="code-file">${escapeHtml(title)}</span>${copy ? '<button type="button" class="code-copy" aria-label="Copy code"></button>' : ''}</div>`;

const freshCode = (node: CodeNode, lang = node.lang): CodeNode => ({
  type: 'code',
  lang,
  meta: node.meta,
  value: node.value,
});

const nameOf = (node: unknown): string | undefined =>
  typeof node === 'object' &&
  node !== null &&
  'type' in node &&
  'name' in node &&
  (node.type === 'containerDirective' || node.type === 'leafDirective')
    ? String(node.name)
    : undefined;

function fail(ctx: Context, message: string): never {
  const file = ctx.fileURL?.pathname.split('/').pop() ?? 'markdown';
  throw new Error(`${message} (in ${file})`);
}

function sdkTabs(node: ContainerNode, ctx: Context): void {
  const panels: BoxNode[] = [];
  const tabs: { id: string; label: string; file: string }[] = [];
  for (const child of node.children) {
    if (child.type !== 'code')
      fail(
        ctx,
        'docs.tabs_child_not_code: :::tabs holds only fenced code blocks',
      );
    const meta = parseMeta(child.meta);
    const sdk = meta.sdk
      ? sdks.find((entry) => entry.id === meta.sdk)
      : undefined;
    if (meta.sdk && !sdk) fail(ctx, `docs.tabs_unknown_sdk: ${meta.sdk}`);
    const id = sdk?.id ?? meta.label;
    if (!id)
      fail(ctx, 'docs.tabs_missing_sdk: give each block sdk=<id> or label="…"');
    if (tabs.some((tab) => tab.id === id))
      fail(ctx, `docs.tabs_duplicate: ${id}`);
    tabs.push({ id, label: sdk?.name ?? id, file: meta.title ?? '' });
    panels.push(
      box('tab-panel', [freshCode(child)], {
        'data-tab': id,
        'data-file': meta.title ?? '',
        ...(panels.length > 0 ? { hidden: true } : {}),
      }),
    );
  }
  if (tabs.length === 0) fail(ctx, 'docs.tabs_empty');
  const synced = tabs.every((tab) => sdks.some((entry) => entry.id === tab.id));
  // Which tab each SDK opens on, decided here so the page script stays a lookup.
  const pick = synced
    ? Object.fromEntries(
        sdks.map((entry) => [
          entry.id,
          [entry.id, ...(sampleFallback[entry.id] ?? [])].find((id) =>
            tabs.some((tab) => tab.id === id),
          ) ?? tabs[0]?.id,
        ]),
      )
    : undefined;
  const buttons = tabs
    .map(
      (tab, i) =>
        `<button type="button" role="tab" data-tab="${escapeHtml(tab.id)}" aria-selected="${i === 0}">${escapeHtml(tab.label)}</button>`,
    )
    .join('');
  ctx.setProperty(node, 'data', {
    hName: 'div',
    hProperties: {
      className: ['code', 'tabs'],
      ...(pick
        ? { 'data-sync': 'sdk', 'data-pick': JSON.stringify(pick) }
        : {}),
    },
  });
  ctx.setProperty(node, 'children', [
    html(
      codeBar(
        tabs[0]?.file ?? '',
        `<div class="code-tabs" role="tablist">${buttons}</div>`,
      ),
    ),
    ...panels,
    html('<p class="code-note" hidden></p>'),
  ]);
}

function figure(node: ContainerNode, ctx: Context): void {
  const data = ctx.data as { figures?: number };
  data.figures = (data.figures ?? 0) + 1;
  const { title, note, ticks } = node.attributes ?? {};
  if (!title) fail(ctx, 'docs.figure_missing_title: :::figure{title="…"}');
  const captions = node.children.filter((child) => nameOf(child) === 'caption');
  if (captions.length > 1) fail(ctx, 'docs.figure_two_captions');
  const body = node.children.filter((child) => nameOf(child) !== 'caption');
  ctx.setProperty(node, 'data', {
    hName: 'figure',
    hProperties: {
      className: ticks === undefined ? ['fig'] : ['fig', 'ticks'],
    },
  });
  ctx.setProperty(node, 'children', [
    html(
      `${ticks === undefined ? '' : '<span class="tk-b"></span>'}<div class="fig-head"><span><b>Fig. ${data.figures}</b> · ${escapeHtml(title)}</span>${note ? `<span class="fig-note">${escapeHtml(note)}</span>` : ''}</div>`,
    ),
    box('fig-body', body),
    ...captions,
  ]);
}

function terms(node: ContainerNode, ctx: Context): void {
  const [list, ...rest] = node.children;
  if (list?.type !== 'list' || rest.length > 0) {
    fail(
      ctx,
      'docs.terms_not_a_list: :::terms holds one `- **Term**: definition` list',
    );
  }
  // `- **Term**: definition` reads well in markdown; the rail shows the term
  // on its own line, so the separating colon goes.
  for (const item of list.children) {
    const [paragraph] = item.children;
    const after =
      paragraph?.type === 'paragraph' ? paragraph.children[1] : undefined;
    if (
      paragraph?.type !== 'paragraph' ||
      paragraph.children[0]?.type !== 'strong' ||
      after?.type !== 'text'
    ) {
      fail(
        ctx,
        'docs.terms_item_shape: write each item as `- **Term**: definition`',
      );
    }
    ctx.setProperty(after, 'value', after.value.replace(/^:\s*/, ''));
  }
  ctx.setProperty(node, 'data', {
    hName: 'details',
    hProperties: { className: ['terms'], 'data-terms': true },
  });
  ctx.prependChild(
    node,
    html(`<summary>Terms on this page · ${list.children.length}</summary>`),
  );
}

const plugin = {
  name: 'syncular-docs-components',
  options: { position: true },
  heading(node, ctx) {
    // `## Advanced: …` sections carry the ADV marker (a CSS badge, so the
    // heading text, its anchor, and the contents rail stay unchanged).
    const [first] = node.children;
    if (
      (node.depth === 2 || node.depth === 3) &&
      first?.type === 'text' &&
      first.value.startsWith('Advanced:')
    ) {
      ctx.setProperty(node, 'data', {
        hProperties: { className: ['advanced'] },
      });
    }
  },
  containerDirective(node, ctx) {
    const callout = CALLOUTS[node.name];
    if (callout) {
      const title = node.attributes?.title ?? callout.label;
      ctx.setProperty(node, 'data', {
        hName: 'aside',
        hProperties: { className: ['callout', node.name] },
      });
      ctx.prependChild(
        node,
        html(
          `<p class="callout-label">${callout.glyph} ${escapeHtml(title)}</p>`,
        ),
      );
      return;
    }
    switch (node.name) {
      case 'steps':
        if (node.children.some((child) => nameOf(child) !== 'step')) {
          fail(
            ctx,
            'docs.steps_child_not_step: ::::steps holds only :::step blocks',
          );
        }
        ctx.setProperty(node, 'data', {
          hName: 'ol',
          hProperties: { className: ['steps'] },
        });
        return;
      case 'step': {
        if (nameOf(ctx.parent(node)) !== 'steps')
          fail(ctx, 'docs.step_outside_steps');
        const { title, time } = node.attributes ?? {};
        if (!title) fail(ctx, 'docs.step_missing_title: :::step{title="…"}');
        ctx.setProperty(node, 'data', {
          hName: 'li',
          hProperties: { className: ['step'] },
        });
        ctx.prependChild(node, [
          {
            type: 'heading',
            depth: 3,
            children: [{ type: 'text', value: title }],
          },
          ...(time
            ? [html(`<p class="step-time">≈ ${escapeHtml(time)}</p>`)]
            : []),
        ]);
        return;
      }
      case 'figure':
        return figure(node, ctx);
      case 'tabs':
        return sdkTabs(node, ctx);
      case 'terms':
        return terms(node, ctx);
      default:
        fail(ctx, `docs.unknown_directive: :::${node.name}`);
    }
  },
  leafDirective(node: LeafNode, ctx) {
    switch (node.name) {
      case 'checkpoint':
        ctx.setProperty(node, 'data', {
          hName: 'p',
          hProperties: { className: ['checkpoint'] },
        });
        return;
      case 'caption':
        if (nameOf(ctx.parent(node)) !== 'figure')
          fail(ctx, 'docs.caption_outside_figure');
        ctx.setProperty(node, 'data', { hName: 'figcaption' });
        return;
      case 'meta':
        ctx.replaceNode(node, html(metaStrip(node.attributes ?? {})));
        return;
      default:
        fail(ctx, `docs.unknown_directive: ::${node.name}`);
    }
  },
  textDirective(node, ctx) {
    // Prose such as `bun:sqlite` or `12:30` parses as a text directive.
    const start = node.position?.start.offset;
    const end = node.position?.end.offset;
    if (start === undefined || end === undefined)
      fail(ctx, 'docs.text_directive_without_position');
    return { type: 'text', value: ctx.source.slice(start, end) };
  },
  code(node, ctx) {
    const parent = nameOf(ctx.parent(node));
    if (parent === 'tabs') return;
    // A figure frames its own body: a fence there is a plain diagram.
    if (parent === 'figure' && node.lang !== 'tree') return;
    const meta = parseMeta(node.meta);
    if (node.lang === 'tree') {
      ctx.replaceNode(
        node,
        box('code file-tree', [
          html(codeBar(meta.title ?? '', '', false)),
          html(fileTree(node.value)),
        ]),
      );
      return;
    }
    if (node.lang === 'output') {
      ctx.replaceNode(
        node,
        box('code output', [
          html(codeBar(meta.title ?? 'Expected output')),
          freshCode(node, 'text'),
        ]),
      );
      return;
    }
    ctx.replaceNode(
      node,
      box('code', [html(codeBar(meta.title ?? '')), freshCode(node)]),
    );
  },
} satisfies MdastPlugin;

export const docsComponents: MdastPlugin = plugin;
