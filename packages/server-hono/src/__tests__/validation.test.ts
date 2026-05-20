import { describe, expect, it } from 'bun:test';
import { Hono } from 'hono';
import { z } from 'zod';
import { blobValidator, consoleValidator, syncValidator } from '../validation';

describe('Syncular Hono validation envelopes', () => {
  it.each([
    ['sync', syncValidator, 'sync.invalid_request'],
    ['blob', blobValidator, 'blob.invalid_request'],
    ['console', consoleValidator, 'console.invalid_request'],
  ] as const)(
    'returns a stable %s validation envelope',
    async (_name, validator, code) => {
      const app = new Hono();
      app.post(
        '/test',
        validator('json', z.object({ required: z.string() })),
        (c) => c.json({ ok: true })
      );

      const response = await app.request('http://localhost/test', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({}),
      });

      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({
        error: code,
        code,
        retryable: false,
        details: {
          target: 'json',
          issues: [{ path: ['required'] }],
        },
      });
    }
  );
});
