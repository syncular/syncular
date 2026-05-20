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

  it('includes runtime and local storage classifications', () => {
    expect(createSyncularErrorResponse('sync.transport_failed')).toMatchObject({
      category: 'transport',
      retryable: true,
      recommendedAction: 'retryLater',
    });
    expect(createSyncularErrorResponse('storage.failed')).toMatchObject({
      category: 'storage',
      retryable: false,
      recommendedAction: 'inspectStorage',
    });
    expect(createSyncularErrorResponse('runtime.internal')).toMatchObject({
      category: 'internal',
      retryable: false,
      recommendedAction: 'inspectServer',
    });
  });

  it('includes push operation result classifications', () => {
    expect(createSyncularErrorResponse('sync.version_conflict')).toMatchObject({
      category: 'conflict',
      retryable: false,
      recommendedAction: 'resolveConflict',
    });
    expect(createSyncularErrorResponse('sync.unknown_table')).toMatchObject({
      category: 'schema-mismatch',
      retryable: false,
      recommendedAction: 'regenerateClient',
    });
    expect(
      createSyncularErrorResponse('sync.idempotency_cache_miss')
    ).toMatchObject({
      category: 'internal',
      retryable: true,
      recommendedAction: 'retryLater',
    });
  });

  it('includes console gateway classifications', () => {
    expect(
      createSyncularErrorResponse('console.forbidden_origin')
    ).toMatchObject({
      category: 'forbidden',
      retryable: false,
      recommendedAction: 'checkPermissions',
    });
    expect(
      createSyncularErrorResponse('console.downstream_unavailable')
    ).toMatchObject({
      category: 'server',
      retryable: true,
      recommendedAction: 'retryLater',
    });
    expect(
      createSyncularErrorResponse('console.schema_unavailable')
    ).toMatchObject({
      category: 'server',
      retryable: true,
      recommendedAction: 'retryLater',
    });
  });

  it('includes proxy websocket classifications', () => {
    expect(createSyncularErrorResponse('proxy.auth_required')).toMatchObject({
      category: 'auth-required',
      retryable: true,
      recommendedAction: 'refreshAuth',
    });
    expect(createSyncularErrorResponse('proxy.connection_limit')).toMatchObject({
      category: 'rate-limited',
      retryable: true,
      recommendedAction: 'retryLater',
    });
  });

  it('includes blob storage configuration classification', () => {
    expect(
      createSyncularErrorResponse('blob.storage_not_configured')
    ).toMatchObject({
      category: 'blob',
      retryable: false,
      recommendedAction: 'inspectServer',
    });
  });
});
