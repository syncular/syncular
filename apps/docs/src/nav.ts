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
      { slug: 'blog', title: 'Blog' },
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
      { slug: 'guide-web-desktop', title: 'One codebase: web + desktop' },
      { slug: 'platform-rust', title: 'Rust' },
      { slug: 'platform-ffi', title: 'Embedding via C FFI' },
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
      {
        slug: 'guide-concurrency-correction',
        title: 'Concurrency & correction',
      },
      { slug: 'concepts-crdt', title: 'CRDT columns' },
      { slug: 'concepts-blobs', title: 'Blobs' },
      { slug: 'concepts-encryption', title: 'Client-side encryption' },
      { slug: 'concepts-local-data-purge', title: 'Authorized local purge' },
      { slug: 'concepts-windowing', title: 'Windowed sync' },
    ],
  },
  {
    title: 'Server',
    items: [
      { slug: 'guide-server', title: 'Server setup' },
      { slug: 'server-storage', title: 'Storage backends' },
      { slug: 'server-workers', title: 'Cloudflare Workers' },
      { slug: 'server-operations', title: 'Operations' },
    ],
  },
  {
    title: 'Tooling',
    items: [
      { slug: 'guide-schema', title: 'Schema & typegen' },
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
      { slug: 'privacy', title: 'Privacy' },
    ],
  },
];
