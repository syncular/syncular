import { z } from 'zod';

export const SYNCULAR_GITHUB_URL = 'https://github.com/syncular/syncular';

const REPO_RESPONSE_SCHEMA = z.object({
  stargazers_count: z.number().int().nonnegative(),
});

export async function getSyncularGitHubStars(): Promise<number | null> {
  try {
    const headers = new Headers({
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    });

    const githubToken = process.env.GITHUB_TOKEN;
    if (githubToken) {
      headers.set('Authorization', `Bearer ${githubToken}`);
    }

    const response = await fetch(
      'https://api.github.com/repos/syncular/syncular',
      {
        headers,
        next: { revalidate: 3600 },
      }
    );

    if (!response.ok) {
      return null;
    }

    const payload = REPO_RESPONSE_SCHEMA.safeParse(await response.json());
    if (!payload.success) {
      return null;
    }

    return payload.data.stargazers_count;
  } catch {
    return null;
  }
}
