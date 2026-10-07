/**
 * The docs manifest: the page tree in reading order, the SDK list, and the
 * redirects for slugs that moved. Each `slug` maps to `content/<slug>.md`
 * (or a page under `pages/`). The page type and the `advanced` flag live
 * here; the content files carry no frontmatter. The root `/` is the landing
 * page and `/docs/` is the docs home; neither is in the sidebar.
 */
export type PageKind = 'concept' | 'how-to' | 'reference';

export interface NavPage {
  readonly slug: string;
  readonly title: string;
  readonly kind: PageKind;
  readonly advanced?: true;
}

export interface NavGroup {
  readonly title: string;
  /** Every page in the group is advanced. */
  readonly advanced?: true;
  /** The sidebar shows the chosen SDK's pages at the top of this group. */
  readonly sdk?: true;
  readonly pages: readonly NavPage[];
}

export interface Sdk {
  readonly id: string;
  readonly name: string;
  readonly core: string;
  readonly language: string;
  /** The SDK's pages in reading order. Add sub-pages here. */
  readonly pages: readonly NavPage[];
}

const sdk = (
  id: string,
  name: string,
  core: string,
  language: string,
  slug: string,
  title: string,
): Sdk => ({
  id,
  name,
  core,
  language,
  pages: [{ slug, title, kind: 'how-to' }],
});

/** The six-page set of a native SDK: overview plus the standard sub-pages. */
const nativePages = (
  slug: string,
  title: string,
  advancedSpecifics?: true,
): readonly NavPage[] => [
  { slug, title, kind: 'concept' },
  { slug: `${slug}-install`, title: 'Install & first sync', kind: 'how-to' },
  { slug: `${slug}-reads-writes`, title: 'Reads & writes', kind: 'how-to' },
  { slug: `${slug}-realtime`, title: 'Realtime & lifecycle', kind: 'how-to' },
  {
    slug: `${slug}-specifics`,
    title: 'Platform specifics',
    kind: 'reference',
    ...(advancedSpecifics ? { advanced: true as const } : {}),
  },
  {
    slug: `${slug}-troubleshooting`,
    title: 'Troubleshooting',
    kind: 'reference',
  },
];

export const sdks: readonly Sdk[] = [
  {
    ...sdk(
      'web',
      'Browser',
      'TypeScript core',
      'TypeScript',
      'platform-web',
      'Browser',
    ),
    pages: [
      { slug: 'platform-web', title: 'Browser', kind: 'concept' },
      {
        slug: 'platform-web-install',
        title: 'Install & first sync',
        kind: 'how-to',
      },
      {
        slug: 'platform-web-reads-writes',
        title: 'Reads & writes',
        kind: 'how-to',
      },
      {
        slug: 'platform-web-realtime',
        title: 'Realtime & lifecycle',
        kind: 'how-to',
      },
      {
        slug: 'platform-web-specifics',
        title: 'Platform specifics',
        kind: 'reference',
        advanced: true,
      },
      {
        slug: 'platform-web-troubleshooting',
        title: 'Troubleshooting',
        kind: 'reference',
      },
    ],
  },
  {
    ...sdk(
      'react',
      'React',
      'TypeScript core',
      'TSX',
      'platform-react',
      'React',
    ),
    pages: [
      { slug: 'platform-react', title: 'React', kind: 'concept' },
      {
        slug: 'platform-react-install',
        title: 'Install & first sync',
        kind: 'how-to',
      },
      {
        slug: 'platform-react-reads-writes',
        title: 'Reads & writes',
        kind: 'how-to',
      },
      {
        slug: 'platform-react-realtime',
        title: 'Realtime & lifecycle',
        kind: 'how-to',
      },
      {
        slug: 'platform-react-specifics',
        title: 'Platform specifics',
        kind: 'reference',
      },
      {
        slug: 'platform-react-troubleshooting',
        title: 'Troubleshooting',
        kind: 'reference',
      },
    ],
  },
  {
    ...sdk(
      'swift',
      'Swift',
      'Rust core',
      'Swift',
      'platform-swift',
      'Swift (iOS & macOS)',
    ),
    pages: nativePages('platform-swift', 'Swift (iOS & macOS)'),
  },
  {
    ...sdk(
      'kotlin',
      'Kotlin',
      'Rust core',
      'Kotlin',
      'platform-kotlin',
      'Kotlin (Android & JVM)',
    ),
    pages: nativePages('platform-kotlin', 'Kotlin (Android & JVM)'),
  },
  {
    ...sdk(
      'flutter',
      'Flutter',
      'Rust core',
      'Dart',
      'platform-flutter',
      'Flutter & Dart',
    ),
    pages: nativePages('platform-flutter', 'Flutter & Dart'),
  },
  {
    ...sdk(
      'react-native',
      'React Native',
      'Rust core',
      'TSX',
      'platform-react-native',
      'React Native',
    ),
    pages: [
      { slug: 'platform-react-native', title: 'React Native', kind: 'concept' },
      {
        slug: 'platform-react-native-install',
        title: 'Install & first sync',
        kind: 'how-to',
      },
      {
        slug: 'platform-react-native-reads-writes',
        title: 'Reads & writes',
        kind: 'how-to',
      },
      {
        slug: 'platform-react-native-realtime',
        title: 'Realtime & lifecycle',
        kind: 'how-to',
      },
      {
        slug: 'platform-react-native-specifics',
        title: 'Platform specifics',
        kind: 'reference',
      },
      {
        slug: 'platform-react-native-troubleshooting',
        title: 'Troubleshooting',
        kind: 'reference',
      },
    ],
  },
  {
    ...sdk(
      'tauri',
      'Tauri',
      'Rust core',
      'TypeScript',
      'platform-tauri',
      'Tauri',
    ),
    pages: [
      { slug: 'platform-tauri', title: 'Tauri', kind: 'concept' },
      {
        slug: 'platform-tauri-install',
        title: 'Install & first sync',
        kind: 'how-to',
      },
      {
        slug: 'platform-tauri-reads-writes',
        title: 'Reads & writes',
        kind: 'how-to',
      },
      {
        slug: 'platform-tauri-realtime',
        title: 'Realtime & lifecycle',
        kind: 'how-to',
      },
      {
        slug: 'platform-tauri-specifics',
        title: 'Platform specifics',
        kind: 'reference',
        advanced: true,
      },
      {
        slug: 'platform-tauri-troubleshooting',
        title: 'Troubleshooting',
        kind: 'reference',
      },
    ],
  },
  {
    ...sdk('rust', 'Rust', 'Rust core', 'Rust', 'platform-rust', 'Rust'),
    pages: nativePages('platform-rust', 'Rust', true),
  },
];

/**
 * Where an SDK's reader looks when a code-tab block has no sample in that
 * SDK's language: React Native apps use the React hooks, React and Tauri
 * webviews call the TypeScript client. Read by the markdown tabs component.
 */
export const sampleFallback: Readonly<Record<string, readonly string[]>> = {
  web: ['react'],
  react: ['web'],
  'react-native': ['react', 'web'],
  tauri: ['web'],
};

export const nav: readonly NavGroup[] = [
  {
    title: 'Start',
    pages: [
      { slug: 'what-is', title: 'What is Syncular', kind: 'concept' },
      { slug: 'quickstart', title: 'Quickstart', kind: 'how-to' },
      {
        slug: 'add-to-existing-app',
        title: 'Add to an existing app',
        kind: 'how-to',
      },
      { slug: 'demos', title: 'Live demos', kind: 'how-to' },
      { slug: 'tooling-testing', title: 'Testing your app', kind: 'how-to' },
    ],
  },
  {
    title: 'Core model',
    pages: [
      {
        slug: 'concepts-subscriptions',
        title: 'Subscriptions & the outbox',
        kind: 'concept',
      },
      {
        slug: 'concepts-commits',
        title: 'Commits, cursors, idempotency',
        kind: 'concept',
      },
      {
        slug: 'concepts-scopes',
        title: 'Scopes & authorization',
        kind: 'concept',
      },
      {
        slug: 'concepts-conflicts',
        title: 'Conflicts & optimistic writes',
        kind: 'concept',
      },
      {
        slug: 'concepts-bootstrap',
        title: 'Bootstrap & segments',
        kind: 'concept',
      },
      {
        slug: 'concepts-realtime',
        title: 'Realtime & the WS loop',
        kind: 'concept',
      },
      {
        slug: 'concepts-schema-upgrades',
        title: 'Schema upgrades',
        kind: 'concept',
      },
    ],
  },
  {
    title: 'Build your app',
    sdk: true,
    pages: [
      { slug: 'guide-schema', title: 'Schema & typegen', kind: 'how-to' },
      {
        slug: 'native-client-api',
        title: 'Native client API',
        kind: 'reference',
      },
      { slug: 'tooling-queries', title: 'Named queries', kind: 'how-to' },
      {
        slug: 'guide-concurrency-correction',
        title: 'Handling conflicts',
        kind: 'how-to',
      },
      { slug: 'guide-auth', title: 'Authentication', kind: 'how-to' },
      {
        slug: 'guide-domain-events',
        title: 'Domain actions & event rows',
        kind: 'how-to',
        advanced: true,
      },
    ],
  },
  {
    title: 'Run your server',
    pages: [
      { slug: 'server-storage', title: 'Choosing a database', kind: 'concept' },
      { slug: 'guide-server', title: 'Server setup', kind: 'how-to' },
      { slug: 'server-workers', title: 'Cloudflare Workers', kind: 'how-to' },
      {
        slug: 'server-storage-reference',
        title: 'Storage reference',
        kind: 'reference',
      },
      {
        slug: 'server-partitions',
        title: 'Partitions & multi-tenancy',
        kind: 'concept',
        advanced: true,
      },
      {
        slug: 'server-operations',
        title: 'Operations and maintenance',
        kind: 'how-to',
      },
      {
        slug: 'server-reactions',
        title: 'Durable reactions',
        kind: 'how-to',
        advanced: true,
      },
      {
        slug: 'guide-server-clients',
        title: 'Server-side clients',
        kind: 'how-to',
      },
      {
        slug: 'guide-remote-operations',
        title: 'Remote server operations',
        kind: 'reference',
        advanced: true,
      },
    ],
  },
  {
    title: 'Optional features',
    advanced: true,
    pages: [
      { slug: 'concepts-crdt', title: 'CRDT columns', kind: 'concept' },
      { slug: 'concepts-blobs', title: 'Blobs', kind: 'concept' },
      {
        slug: 'concepts-encryption',
        title: 'Client-side encryption',
        kind: 'concept',
      },
      {
        slug: 'tooling-local-search',
        title: 'Local full-text search',
        kind: 'how-to',
      },
      { slug: 'concepts-windowing', title: 'Windowed sync', kind: 'concept' },
      {
        slug: 'concepts-local-data-purge',
        title: 'Authorized local purge',
        kind: 'how-to',
      },
    ],
  },
  {
    title: 'Reference',
    pages: [
      {
        slug: 'reference',
        title: 'Specifications & packages',
        kind: 'reference',
      },
      { slug: 'tooling-cli', title: 'CLI reference', kind: 'reference' },
      { slug: 'syql', title: 'SYQL language', kind: 'reference' },
      { slug: 'playground', title: 'SYQL playground', kind: 'reference' },
      { slug: 'benchmarks', title: 'Benchmarks', kind: 'reference' },
      {
        slug: 'reference-outbox-outcomes',
        title: 'Outbox & commit outcomes',
        kind: 'reference',
        advanced: true,
      },
      {
        slug: 'platform-ffi',
        title: 'Embedding via C FFI',
        kind: 'reference',
        advanced: true,
      },
      { slug: 'troubleshooting', title: 'Troubleshooting', kind: 'reference' },
    ],
  },
  {
    title: 'Project',
    pages: [
      { slug: 'changelog', title: 'Changelog', kind: 'reference' },
      { slug: 'blog', title: 'Blog', kind: 'reference' },
      { slug: 'contributing', title: 'Contributing', kind: 'how-to' },
      { slug: 'llms', title: 'LLMs', kind: 'reference' },
      { slug: 'privacy', title: 'Privacy', kind: 'reference' },
    ],
  },
];

/**
 * Slugs that moved or merged, mapped to their new path. The Worker answers
 * these with a 301; the optional `#anchor` points at the merged section.
 */
export const redirects: Readonly<Record<string, string>> = {
  'guide-client': '/platform-web/',
  'guide-web-desktop': '/platform-tauri/',
  'guide-vite': '/platform-web-install/',
  'concepts-previous-version-context':
    '/concepts-schema-upgrades/#advanced-previous-version-context',
  'server-realtime-tickets': '/guide-auth/#realtime-tickets',
  'server-backup-restore': '/server-operations/#backup-and-restore',
  'concepts-encryption-keys': '/concepts-encryption/#encryption-keys',
  'guide-conformance': '/reference/#protocol--conformance',
};

/** Every page with its group, in sidebar order; SDK pages sit in the SDK group. */
export const navPages = nav.flatMap((group) =>
  [
    ...(group.sdk ? sdks.flatMap((entry) => entry.pages) : []),
    ...group.pages,
  ].map((page) => ({
    ...page,
    group,
    advanced: group.advanced === true || page.advanced === true,
  })),
);

export const sdkOfSlug = (slug: string): Sdk | undefined =>
  sdks.find((entry) => entry.pages.some((page) => page.slug === slug));

/**
 * The reading sequence a page belongs to: SDK pages read in their own SDK's
 * order between the Core model and the task guides; every other page reads
 * in sidebar order with SDK pages left out.
 */
export function neighbors(slug: string) {
  const owner = sdkOfSlug(slug);
  const sequence = nav.flatMap((group) =>
    group.sdk && owner ? [...owner.pages, ...group.pages] : group.pages,
  );
  const index = sequence.findIndex((page) => page.slug === slug);
  return {
    prev: index > 0 ? sequence[index - 1] : undefined,
    next: index >= 0 ? sequence[index + 1] : undefined,
  };
}
