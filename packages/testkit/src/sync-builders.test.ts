import { describe, expect, it } from 'bun:test';
import {
  SYNC_PACK_ENCODING_BINARY_V1,
  SyncCombinedRequestSchema,
} from '@syncular/core';
import { createSyncCombinedRequest } from './sync-builders';

describe('sync builders', () => {
  it('preserves root-level sync pack encodings on combined requests', () => {
    const request = createSyncCombinedRequest({
      clientId: 'client-1',
      syncPackEncodings: [SYNC_PACK_ENCODING_BINARY_V1],
    });

    expect(SyncCombinedRequestSchema.parse(request)).toEqual({
      clientId: 'client-1',
      syncPackEncodings: [SYNC_PACK_ENCODING_BINARY_V1],
    });
  });
});
