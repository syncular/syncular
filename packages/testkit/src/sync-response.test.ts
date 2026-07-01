import { describe, expect, it } from 'bun:test';
import type { SyncCombinedResponse } from '@syncular/core';
import {
  requirePullSubscription,
  requirePushCommit,
  requirePushErrorCode,
  requirePushOperationResult,
  requireRevokedSubscription,
} from './sync-response';

describe('sync response assertions', () => {
  const response: SyncCombinedResponse = {
    ok: true,
    push: {
      ok: true,
      commits: [
        {
          ok: true,
          clientCommitId: 'commit-1',
          status: 'rejected',
          results: [
            {
              opIndex: 0,
              status: 'error',
              error: 'Forbidden',
              code: 'sync.forbidden',
              retriable: false,
            },
          ],
        },
      ],
    },
    pull: {
      ok: true,
      subscriptions: [
        {
          id: 'tasks-allowed',
          status: 'active',
          scopes: { user_id: 'u1', project_id: 'p0' },
          bootstrap: false,
          nextCursor: 3,
          commits: [],
        },
        {
          id: 'tasks-denied',
          status: 'revoked',
          scopes: { user_id: 'u1', project_id: 'p1' },
          bootstrap: false,
          nextCursor: 0,
          commits: [],
        },
      ],
    },
  };

  it('asserts push commits and operation results by stable ids', () => {
    expect(requirePushCommit(response.push, 'commit-1').status).toBe(
      'rejected'
    );
    expect(
      requirePushOperationResult(response.push, { clientCommitId: 'commit-1' })
    ).toMatchObject({
      status: 'error',
      code: 'sync.forbidden',
    });
    expect(
      requirePushErrorCode(response.push, {
        clientCommitId: 'commit-1',
        code: 'sync.forbidden',
      })
    ).toMatchObject({
      status: 'error',
      code: 'sync.forbidden',
    });
  });

  it('asserts revoked pull subscriptions without message matching', () => {
    expect(
      requirePullSubscription(response.pull?.subscriptions, 'tasks-allowed')
    ).toMatchObject({
      id: 'tasks-allowed',
      status: 'active',
    });
    expect(
      requireRevokedSubscription(response.pull?.subscriptions, 'tasks-denied')
    ).toMatchObject({
      id: 'tasks-denied',
      status: 'revoked',
    });
  });

  it('throws actionable assertion failures', () => {
    expect(() => requirePushCommit(response.push, 'missing')).toThrow(
      'Expected Syncular push commit "missing" but observed: commit-1'
    );
    expect(() =>
      requirePushErrorCode(response.push, {
        clientCommitId: 'commit-1',
        code: 'sync.rate_limited',
      })
    ).toThrow(
      'Expected Syncular push result "commit-1" op 0 to be error code "sync.rate_limited" but observed error:sync.forbidden'
    );
    expect(() =>
      requireRevokedSubscription(response.pull?.subscriptions, 'tasks-allowed')
    ).toThrow(
      'Expected Syncular pull subscription "tasks-allowed" to be revoked but observed active'
    );
  });
});
