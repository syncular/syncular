export const SYNCULAR_GITHUB_URL = 'https://github.com/syncular/syncular';

interface RepoResponse {
  stargazers_count?: unknown;
}

export async function getSyncularGitHubStars(): Promise<number | null> {
  try {
    const headers = new Headers({
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    });

    const githubToken = process.env.GITHUB_TOKEN?.trim();
    if (githubToken) {
      headers.set('Authorization', `Bearer ${githubToken}`);
    }

    const response = await fetch(
      'https://api.github.com/repos/syncular/syncular',
      {
        headers,
      }
    );

    if (!response.ok) {
      return null;
    }

    const payload = (await response.json()) as RepoResponse;
    if (typeof payload.stargazers_count !== 'number') {
      return null;
    }

    return payload.stargazers_count;
  } catch {
    return null;
  }
}

export function formatDate(date: string | Date): string {
  return new Intl.DateTimeFormat('en-US', {
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  }).format(new Date(date));
}
