/**
 * The sidebar manifest — the page tree, in order. Each `slug` maps to
 * `pages/<slug>.md`. The root `/` is the landing page (landing.ts), which is
 * not in the sidebar; the sidebar brand links back to it.
 */
export interface NavSection {
  readonly title: string;
  readonly items: readonly { readonly slug: string; readonly title: string }[];
}

export const nav: readonly NavSection[] = [
  {
    title: 'Start',
    items: [
      { slug: 'what-is', title: 'What is syncular' },
      { slug: 'quickstart', title: 'Quickstart' },
      { slug: 'demos', title: 'Live demos' },
    ],
  },
  {
    title: 'Platforms',
    items: [
      { slug: 'platform-web', title: 'Web (browser)' },
      { slug: 'guide-vite', title: 'Vite' },
      { slug: 'platform-react', title: 'React' },
      { slug: 'platform-swift', title: 'Swift (iOS & macOS)' },
      { slug: 'platform-kotlin', title: 'Kotlin (Android & JVM)' },
      { slug: 'platform-flutter', title: 'Flutter & Dart' },
      { slug: 'platform-react-native', title: 'React Native' },
      { slug: 'platform-tauri', title: 'Tauri' },
      { slug: 'platform-rust', title: 'Rust' },
      { slug: 'platform-ffi', title: 'Embedding via C FFI' },
    ],
  },
  {
    title: 'Concepts',
    items: [
      { slug: 'concepts-commits', title: 'Commits, cursors, idempotency' },
      { slug: 'concepts-subscriptions', title: 'Subscriptions & the outbox' },
      { slug: 'concepts-scopes', title: 'Scopes & authorization' },
      { slug: 'concepts-bootstrap', title: 'Bootstrap & segments' },
      { slug: 'concepts-windowing', title: 'Windowed sync' },
      { slug: 'concepts-schema-upgrades', title: 'Schema upgrades' },
      { slug: 'concepts-conflicts', title: 'Conflicts & optimistic writes' },
      {
        slug: 'guide-concurrency-correction',
        title: 'Concurrency & correction',
      },
      { slug: 'guide-domain-events', title: 'Domain actions & event rows' },
      { slug: 'concepts-realtime', title: 'Realtime & the WS loop' },
      { slug: 'concepts-crdt', title: 'CRDT columns' },
      { slug: 'concepts-blobs', title: 'Blobs' },
      { slug: 'concepts-encryption', title: 'Client-side encryption' },
      { slug: 'concepts-encryption-keys', title: 'Encryption keys' },
      { slug: 'concepts-local-data-purge', title: 'Authorized local purge' },
    ],
  },
  {
    title: 'Server',
    items: [
      { slug: 'guide-server', title: 'Server setup' },
      { slug: 'server-storage', title: 'Storage backends' },
      { slug: 'server-workers', title: 'Cloudflare Workers' },
      { slug: 'server-partitions', title: 'Partitions & multi-tenancy' },
      { slug: 'server-operations', title: 'Operations and maintenance' },
      { slug: 'server-reactions', title: 'Durable reactions' },
      { slug: 'server-realtime-tickets', title: 'Realtime tickets' },
      { slug: 'guide-server-clients', title: 'Server-side sync clients' },
      { slug: 'guide-remote-operations', title: 'Remote server operations' },
    ],
  },
  {
    title: 'Tooling',
    items: [
      { slug: 'guide-schema', title: 'Schema & typegen' },
      { slug: 'tooling-cli', title: 'CLI reference' },
      { slug: 'tooling-queries', title: 'Named queries' },
      { slug: 'tooling-local-search', title: 'Local full-text search' },
      { slug: 'syql', title: 'SYQL language' },
      { slug: 'playground', title: 'SYQL playground' },
      { slug: 'tooling-testing', title: 'Testing your app' },
    ],
  },
  {
    title: 'Reference',
    items: [
      { slug: 'reference', title: 'Specifications & packages' },
      { slug: 'guide-conformance', title: 'Protocol & conformance' },
      { slug: 'benchmarks', title: 'Benchmarks' },
      { slug: 'troubleshooting', title: 'Troubleshooting' },
    ],
  },
  {
    title: 'Project',
    items: [
      { slug: 'changelog', title: 'Changelog' },
      { slug: 'blog', title: 'Blog' },
      { slug: 'contributing', title: 'Contributing' },
      { slug: 'llms', title: 'LLMs' },
      { slug: 'privacy', title: 'Privacy' },
    ],
  },
];
