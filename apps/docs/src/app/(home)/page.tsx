import { ObservableUniverseLanding } from '@syncular/ui/observable-universe';
import { getSyncularGitHubStars, SYNCULAR_GITHUB_URL } from '@/lib/github';

const TOPIC_LINKS = [
  { label: 'Docs', href: '/docs' },
  { label: 'Blog', href: '/blog' },
];

export default async function LandingPage() {
  const githubStars = await getSyncularGitHubStars();

  return (
    <ObservableUniverseLanding
      docsHref="/docs"
      topicLinks={TOPIC_LINKS}
      demoHref="https://demo.syncular.dev"
      githubHref={SYNCULAR_GITHUB_URL}
      githubStars={githubStars}
    />
  );
}
