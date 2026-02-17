'use client';

import { ObservableUniverseHeader } from '@syncular/ui/observable-universe';

const TOPIC_LINKS = [
  { label: 'Docs', href: '/docs' },
  { label: 'Blog', href: '/blog' },
];

export function BlogHeader() {
  return (
    <ObservableUniverseHeader
      topicLinks={TOPIC_LINKS}
      demoHref="https://demo.syncular.dev"
      githubHref="https://github.com/syncular/syncular"
    />
  );
}
