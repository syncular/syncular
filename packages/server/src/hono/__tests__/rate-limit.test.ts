import { afterEach, describe, expect, it } from 'bun:test';
import { Hono } from 'hono';
import { createRateLimiter, resetRateLimitStore } from '../rate-limit';

afterEach(() => {
  resetRateLimitStore();
});

describe('rate limiter store isolation', () => {
  it('does not share counters across independently configured routes', async () => {
    const app = new Hono();

    app.use(
      '/pull',
      createRateLimiter({
        maxRequests: 1,
        windowMs: 60_000,
        keyGenerator: () => 'actor-1',
      })
    );
    app.use(
      '/push',
      createRateLimiter({
        maxRequests: 1,
        windowMs: 60_000,
        keyGenerator: () => 'actor-1',
      })
    );

    app.get('/pull', (c) => c.text('ok'));
    app.get('/push', (c) => c.text('ok'));

    const pullFirst = await app.request('http://localhost/pull');
    const pushFirst = await app.request('http://localhost/push');
    const pushSecond = await app.request('http://localhost/push');

    expect(pullFirst.status).toBe(200);
    expect(pushFirst.status).toBe(200);
    expect(pushSecond.status).toBe(429);
  });

  it('keeps window durations isolated per limiter', async () => {
    const app = new Hono();

    app.use(
      '/short',
      createRateLimiter({
        maxRequests: 1,
        windowMs: 10,
        keyGenerator: () => 'actor-1',
      })
    );
    app.use(
      '/long',
      createRateLimiter({
        maxRequests: 1,
        windowMs: 1_000,
        keyGenerator: () => 'actor-1',
      })
    );

    app.get('/short', (c) => c.text('ok'));
    app.get('/long', (c) => c.text('ok'));

    // Initialize the short-window limiter first.
    expect((await app.request('http://localhost/short')).status).toBe(200);

    // Exhaust long-window limiter.
    expect((await app.request('http://localhost/long')).status).toBe(200);
    expect((await app.request('http://localhost/long')).status).toBe(429);

    // Wait longer than short window but shorter than long window.
    await Bun.sleep(30);

    // Long limiter must still be limited.
    expect((await app.request('http://localhost/long')).status).toBe(429);
  });
});
