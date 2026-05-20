import { describe, expect, it } from 'bun:test';
import {
  SyncularV2ClientError,
  toSyncularV2ClientError,
} from './errors';

describe('Syncular v2 browser errors', () => {
  it('classifies direct Rust schema errors', () => {
    const source = new Error(
      'server requires schema version 9, but this client supports 1'
    ) as Error & { syncularKind?: string };
    source.syncularKind = 'Schema';

    const error = toSyncularV2ClientError(source);

    expect(error).toBeInstanceOf(SyncularV2ClientError);
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

    const error = toSyncularV2ClientError(source);

    expect(error).toBeInstanceOf(SyncularV2ClientError);
    expect(error).toMatchObject({
      code: 'sync.integrity_rejected',
      category: 'integrity-rejected',
      retryable: false,
      recommendedAction: 'forceResync',
      details: { syncularKind: 'Protocol' },
    });
  });
});
