import { describe, expect, it } from 'bun:test';
import type { SyncCombinedRequest } from '@syncular/core';
import { createMockTransport, withFaults } from './faults';

function createPushRequest(
  clientCommitId: string
): Pick<SyncCombinedRequest, 'clientId' | 'push'> {
  return {
    clientId: 'client-1',
    push: {
      commits: [
        {
          clientCommitId,
          schemaVersion: 1,
          operations: [
            {
              table: 'tasks',
              row_id: `row-${clientCommitId}`,
              op: 'upsert',
              payload: { title: clientCommitId, project_id: 'p1' },
              base_version: null,
            },
          ],
        },
      ],
    },
  };
}

function createPullRequest(): Pick<SyncCombinedRequest, 'clientId' | 'pull'> {
  return {
    clientId: 'client-1',
    pull: {
      limitCommits: 10,
      subscriptions: [
        {
          id: 'tasks-p1',
          table: 'tasks',
          scopes: { project_id: 'p1', user_id: 'u1' },
          cursor: 0,
        },
      ],
    },
  };
}

describe('withFaults', () => {
  it('supports deterministic post-success failures for ack-loss scenarios', async () => {
    const wrapped = withFaults(createMockTransport(), {
      plan: [
        {
          operation: 'push',
          phase: 'after',
          failWith: new Error('SIMULATED_ACK_LOSS'),
        },
      ],
    });

    await expect(
      wrapped.transport.sync(createPushRequest('push-1'))
    ).rejects.toThrow('SIMULATED_ACK_LOSS');

    const retry = await wrapped.transport.sync(createPushRequest('push-2'));
    expect(retry.push?.commits[0]?.status).toBe('applied');
    expect(wrapped.getState()).toEqual({
      pushCount: 2,
      pullCount: 0,
      fetchCount: 0,
      failureCount: 1,
    });
  });

  it('consumes pass and fail steps in order for matching operations', async () => {
    const wrapped = withFaults(createMockTransport(), {
      plan: [
        { operation: 'push', action: 'pass' },
        {
          operation: 'pull',
          phase: 'before',
          failWith: new Error('SIMULATED_PULL_DROP'),
        },
      ],
    });

    const pushResult = await wrapped.transport.sync(
      createPushRequest('push-1')
    );
    expect(pushResult.push?.commits[0]?.status).toBe('applied');

    await expect(wrapped.transport.sync(createPullRequest())).rejects.toThrow(
      'SIMULATED_PULL_DROP'
    );

    const retry = await wrapped.transport.sync(createPullRequest());
    expect(retry.pull?.ok).toBe(true);
    expect(wrapped.getState()).toEqual({
      pushCount: 1,
      pullCount: 1,
      fetchCount: 0,
      failureCount: 1,
    });
  });

  it('reset restores the original plan for deterministic reruns', async () => {
    const wrapped = withFaults(createMockTransport(), {
      plan: [
        {
          operation: 'fetch',
          phase: 'before',
          failWith: new Error('SIMULATED_FETCH_FAILURE'),
        },
      ],
    });

    await expect(
      wrapped.transport.fetchSnapshotChunk({ chunkId: 'chunk-1' })
    ).rejects.toThrow('SIMULATED_FETCH_FAILURE');

    await wrapped.transport.fetchSnapshotChunk({ chunkId: 'chunk-1' });

    wrapped.reset();

    await expect(
      wrapped.transport.fetchSnapshotChunk({ chunkId: 'chunk-1' })
    ).rejects.toThrow('SIMULATED_FETCH_FAILURE');
  });
});
