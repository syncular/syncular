import { describe, expect, test } from 'bun:test';
import {
  analyticsDataset,
  classifyDevice,
  parseArticleRead,
  referrerHost,
} from '../src/worker';

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
