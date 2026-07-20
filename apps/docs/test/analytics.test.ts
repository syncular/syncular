import { describe, expect, test } from 'bun:test';
import worker, {
  analyticsDataset,
  classifyDevice,
  isPrefetch,
  parseArticleRead,
  referrerHost,
} from '../src/worker';

interface DataPoint {
  blobs?: string[];
  doubles?: number[];
  indexes?: string[];
}

const testEnv = () => {
  const points: DataPoint[] = [];
  return {
    points,
    env: {
      ASSETS: {
        fetch: async () =>
          new Response('<html></html>', {
            status: 200,
            headers: { 'content-type': 'text/html; charset=utf-8' },
          }),
      },
      ANALYTICS: {
        writeDataPoint: (point: DataPoint) => {
          points.push(point);
        },
      },
    },
  };
};

const articleReadRequest = (headers: Record<string, string>) =>
  new Request('https://syncular.dev/_analytics/read', {
    method: 'POST',
    headers: {
      origin: 'https://syncular.dev',
      'content-type': 'application/json',
      ...headers,
    },
    body: JSON.stringify({
      path: '/blog/offline-first-writes/',
      activeSeconds: 45,
      scrollDepth: 0.8,
    }),
  });

describe('docs analytics', () => {
  test('uses the configured dataset name', () => {
    expect(analyticsDataset).toBe('syncular_docs_engagement');
  });

  test('reduces user agents to a broad class', () => {
    expect(classifyDevice('Mozilla/5.0 (iPhone; Mobile)')).toBe('mobile');
    expect(classifyDevice('Googlebot/2.1')).toBe('bot');
    expect(classifyDevice('Mozilla/5.0 (Macintosh)')).toBe('desktop');
  });

  test('stores only a referrer hostname', () => {
    expect(referrerHost('https://news.ycombinator.com/item?id=123')).toBe(
      'news.ycombinator.com',
    );
    expect(referrerHost('https://syncular.dev/blog/')).toBe('internal');
    expect(referrerHost('not a url')).toBe('direct');
  });

  test('accepts a bare hostname referrer from the engagement script', () => {
    expect(referrerHost('news.ycombinator.com')).toBe('news.ycombinator.com');
    expect(referrerHost('docs.syncular.dev')).toBe('internal');
    expect(referrerHost('')).toBe('direct');
  });

  test('recognizes prefetch requests from purpose headers', () => {
    const withHeaders = (headers: Record<string, string>) =>
      new Request('https://syncular.dev/', { headers });
    expect(isPrefetch(withHeaders({ 'sec-purpose': 'prefetch' }))).toBe(true);
    expect(
      isPrefetch(withHeaders({ 'sec-purpose': 'prefetch;prerender' })),
    ).toBe(true);
    expect(isPrefetch(withHeaders({ purpose: 'prefetch' }))).toBe(true);
    expect(isPrefetch(withHeaders({}))).toBe(false);
  });

  test('skips the page_view write for prefetch navigations', async () => {
    const { env, points } = testEnv();
    const prefetch = await worker.fetch(
      new Request('https://syncular.dev/quickstart/', {
        headers: { 'sec-purpose': 'prefetch' },
      }),
      env,
    );
    expect(prefetch.status).toBe(200);
    expect(points).toHaveLength(0);

    const view = await worker.fetch(
      new Request('https://syncular.dev/quickstart/'),
      env,
    );
    expect(view.status).toBe(200);
    expect(points).toHaveLength(1);
    expect(points[0]?.blobs?.[0]).toBe('page_view');
  });

  test('accepts article reads without Sec-Fetch headers', async () => {
    const { env, points } = testEnv();
    const response = await worker.fetch(articleReadRequest({}), env);
    expect(response.status).toBe(204);
    expect(points).toHaveLength(1);
    expect(points[0]?.blobs?.[0]).toBe('article_read');
  });

  test('rejects article reads with a wrong sec-fetch-site value', async () => {
    const { env, points } = testEnv();
    const response = await worker.fetch(
      articleReadRequest({ 'sec-fetch-site': 'cross-site' }),
      env,
    );
    expect(response.status).toBe(400);
    expect(points).toHaveLength(0);
  });

  test('accepts article reads with a same-origin sec-fetch-site', async () => {
    const { env, points } = testEnv();
    const response = await worker.fetch(
      articleReadRequest({ 'sec-fetch-site': 'same-origin' }),
      env,
    );
    expect(response.status).toBe(204);
    expect(points).toHaveLength(1);
  });

  test('accepts only meaningful article reads', () => {
    expect(
      parseArticleRead({
        path: '/blog/offline-first-writes/',
        activeSeconds: 35.4,
        scrollDepth: 0.72,
        utmSource: 'Hacker News',
      }),
    ).toEqual({
      path: '/blog/offline-first-writes/',
      activeSeconds: 35,
      scrollDepth: 0.72,
      referrer: undefined,
      utmSource: 'hacker-news',
      utmMedium: undefined,
      utmCampaign: undefined,
    });
    expect(
      parseArticleRead({
        path: '/blog/offline-first-writes/',
        activeSeconds: 10,
        scrollDepth: 0.9,
      }),
    ).toBeNull();
    expect(
      parseArticleRead({
        path: '/quickstart/',
        activeSeconds: 60,
        scrollDepth: 0.9,
      }),
    ).toBeNull();
  });
});
