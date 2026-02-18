import { ObservableUniverseHeader } from '@syncular/ui/observable-universe';
import { getSyncularGitHubStars, SYNCULAR_GITHUB_URL } from '@/lib/github';

const TOPIC_LINKS = [
  { label: 'Docs', href: '/docs' },
  { label: 'Blog', href: '/blog' },
];

export async function BlogHeader() {
  const githubStars = await getSyncularGitHubStars();

  return (
    <ObservableUniverseHeader
      topicLinks={TOPIC_LINKS}
      demoHref="https://demo.syncular.dev"
      githubHref={SYNCULAR_GITHUB_URL}
      githubStars={githubStars}
    />
  );
}
