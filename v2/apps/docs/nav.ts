/**
 * The sidebar manifest — the page tree, in order. Each `slug` maps to
 * `pages/<slug>.md` (or `pages/index.md` for the empty slug).
 */
export interface NavSection {
  readonly title: string;
  readonly items: readonly { readonly slug: string; readonly title: string }[];
}

export const nav: readonly NavSection[] = [
  {
    title: 'Start',
    items: [
      { slug: '', title: 'Why syncular' },
      { slug: 'quickstart', title: 'Quickstart' },
      { slug: 'migration', title: 'Migrating from 0.1.x' },
    ],
  },
  {
    title: 'Concepts',
    items: [
      { slug: 'concepts-scopes', title: 'Scopes & authorization' },
      { slug: 'concepts-commits', title: 'Commits, cursors, idempotency' },
      { slug: 'concepts-bootstrap', title: 'Bootstrap & segments' },
      { slug: 'concepts-realtime', title: 'Realtime & the WS loop' },
      { slug: 'concepts-conflicts', title: 'Conflicts & optimistic writes' },
      { slug: 'concepts-blobs', title: 'Blobs' },
    ],
  },
  {
    title: 'Guides',
    items: [
      { slug: 'guide-server', title: 'Server setup' },
      { slug: 'guide-client', title: 'Web client' },
      { slug: 'guide-schema', title: 'Schema & typegen' },
      { slug: 'guide-conformance', title: 'Protocol & conformance' },
    ],
  },
  {
    title: 'Reference',
    items: [{ slug: 'reference', title: 'Spec & package map' }],
  },
];
