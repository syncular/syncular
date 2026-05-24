import { describe, expect, it } from 'bun:test';
import { SyncCombinedRequestSchema } from '@syncular/core';
import { createSyncCombinedRequest } from './sync-builders';

describe('sync builders', () => {
  it('creates combined requests without transport negotiation knobs', () => {
    const request = createSyncCombinedRequest({
      clientId: 'client-1',
    });

    expect(SyncCombinedRequestSchema.parse(request)).toEqual({
      clientId: 'client-1',
    });
  });
});
