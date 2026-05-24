import { describe, expect, it } from 'bun:test';
import { createSyncRealtimeShardKey } from './types';

describe('createSyncRealtimeShardKey', () => {
  it('uses partition as the default tenant/workspace shard', () => {
    expect(createSyncRealtimeShardKey({ partitionId: 'workspace-1' })).toBe(
      'sync-realtime-v1:workspace-1:workspace-1:workspace-1'
    );
  });

  it('keeps tenant, workspace, and partition independent when provided', () => {
    expect(
      createSyncRealtimeShardKey({
        tenantId: 'tenant-1',
        workspaceId: 'workspace-1',
        partitionId: 'partition-1',
      })
    ).toBe('sync-realtime-v1:tenant-1:workspace-1:partition-1');
  });

  it('escapes shard parts', () => {
    expect(
      createSyncRealtimeShardKey({
        tenantId: 'tenant/a',
        workspaceId: 'workspace b',
        partitionId: 'partition:c',
      })
    ).toBe('sync-realtime-v1:tenant%2Fa:workspace%20b:partition%3Ac');
  });
});
