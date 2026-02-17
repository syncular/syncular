'use client';

import { ObservableUniverseLanding } from '@syncular/ui/observable-universe';

const TOPIC_LINKS = [
  { label: 'Docs', href: '/docs' },
  { label: 'Blog', href: '/blog' },
];

export default function LandingPage() {
  return (
    <ObservableUniverseLanding
      docsHref="/docs"
      topicLinks={TOPIC_LINKS}
      demoHref="https://demo.syncular.dev"
      githubHref="https://github.com/syncular/syncular"
    />
  );
}
