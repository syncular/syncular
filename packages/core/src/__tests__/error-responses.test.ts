import { describe, expect, it } from 'bun:test';
import { createSyncularErrorResponse } from '../error-responses';
import { ErrorResponseSchema } from '../schemas/common';

describe('Syncular error responses', () => {
  it('builds stable public error envelopes', () => {
    const response = createSyncularErrorResponse('sync.auth_required');

    expect(response).toEqual({
      error: 'sync.auth_required',
      code: 'sync.auth_required',
      message: 'Authentication is required.',
      category: 'auth-required',
      retryable: true,
      recommendedAction: 'refreshAuth',
    });
    expect(ErrorResponseSchema.parse(response)).toEqual(response);
  });

  it('keeps details structured for recovery handlers', () => {
    const response = createSyncularErrorResponse('sync.rate_limited', {
      message: 'Too many requests.',
      details: { retryAfterMs: 250 },
    });

    expect(response).toMatchObject({
      error: 'sync.rate_limited',
      code: 'sync.rate_limited',
      message: 'Too many requests.',
      category: 'rate-limited',
      retryable: true,
      recommendedAction: 'retryLater',
      details: { retryAfterMs: 250 },
    });
    expect(ErrorResponseSchema.parse(response)).toEqual(response);
  });
});
