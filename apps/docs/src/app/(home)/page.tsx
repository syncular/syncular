'use client';

import { ObservableUniverseLanding } from '@syncular/ui/observable-universe';

const TOPIC_LINKS = [
  { label: 'Overview', href: '/docs' },
  { label: 'Introduction', href: '/docs/introduction' },
  { label: 'Guides', href: '/docs/guides' },
  { label: 'SDK', href: '/docs/sdk' },
  { label: 'Server', href: '/docs/server' },
  { label: 'API', href: '/docs/api' },
];

export default function LandingPage() {
  return (
    <ObservableUniverseLanding
      docsHref="/docs"
      topicLinks={TOPIC_LINKS}
      demoHref="/demo"
      consoleHref="/console"
      githubHref="https://github.com/syncular/syncular"
    />
  );
}
