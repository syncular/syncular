import { describe, expect, it } from 'bun:test';
import {
  isSyncularOfflineError,
  SyncularClientError,
  toSyncularClientError,
} from './errors';

describe('Syncular browser errors', () => {
  it('classifies direct Rust schema errors', () => {
    const source = new Error(
      'server requires schema version 9, but this client supports 1'
    ) as Error & { syncularKind?: string };
    source.syncularKind = 'Schema';

    const error = toSyncularClientError(source);

    expect(error).toBeInstanceOf(SyncularClientError);
    expect(error).toMatchObject({
      code: 'sync.schema_mismatch',
      category: 'schema-mismatch',
      retryable: false,
      recommendedAction: 'regenerateClient',
      details: { syncularKind: 'Schema' },
    });
  });

  it('classifies direct Rust integrity errors', () => {
    const source = new Error(
      'snapshot chunk hash mismatch: expected abc, got def'
    ) as Error & { syncularKind?: string };
    source.syncularKind = 'Protocol';

    const error = toSyncularClientError(source);

    expect(error).toBeInstanceOf(SyncularClientError);
    expect(error).toMatchObject({
      code: 'sync.integrity_rejected',
      category: 'integrity-rejected',
      retryable: false,
      recommendedAction: 'forceResync',
      details: { syncularKind: 'Protocol' },
    });
  });

  it('classifies server error envelopes from transport failures', () => {
    const source = new Error(
      'browser fetch failed with HTTP 403: {"error":"sync.forbidden","code":"sync.forbidden","category":"forbidden","retryable":false,"recommendedAction":"checkPermissions","message":"Forbidden"}'
    );

    const error = toSyncularClientError(source);

    expect(error).toBeInstanceOf(SyncularClientError);
    expect(error).toMatchObject({
      code: 'sync.forbidden',
      category: 'forbidden',
      retryable: false,
      recommendedAction: 'checkPermissions',
      details: {
        status: 403,
        serverErrorCode: 'sync.forbidden',
      },
    });
  });

  it('classifies offline transport failures', () => {
    const error = toSyncularClientError(
      new Error('browser fetch failed: offline')
    );

    expect(error).toBeInstanceOf(SyncularClientError);
    expect(error).toMatchObject({
      code: 'sync.offline',
      category: 'offline',
      retryable: true,
      recommendedAction: 'retryLater',
    });
    expect(isSyncularOfflineError(error)).toBe(true);
  });

  it('recognizes worker offline errors by envelope code', () => {
    expect(
      isSyncularOfflineError({
        code: 'sync.offline',
        category: 'offline',
        message: 'browser fetch failed: offline',
      })
    ).toBe(true);
  });
});
