import { describe, expect, it } from 'bun:test';
import {
  replaceSyncularAuthContext,
  type SyncularAuthContextClient,
} from './auth-context';
import type {
  SyncularAuthHeaders,
  SyncularSubscriptionSpec,
  SyncularSyncRequestOptions,
  SyncularSyncResult,
} from './types';

describe('replaceSyncularAuthContext', () => {
  it('replaces explicit headers and subscriptions before bootstrap reset, sync, and local visibility', async () => {
    const database = new FakeAuthContextClient<TestDb>({
      syncResult: syncResult({ changedTables: ['tasks'] }),
      visibilityResult: [{ id: 'task-1' }],
      bootstrapResetCount: 2,
    });
    const subscriptions = [taskSubscription('campaign-a')];

    const result = await replaceSyncularAuthContext(database, {
      headers: { authorization: 'Bearer campaign-a' },
      subscriptions,
      visibility: {
        query: () => [{ id: 'task-1' }],
        options: { tables: ['tasks'] },
      },
    });

    expect(database.calls).toEqual([
      ['setAuthHeaders', { authorization: 'Bearer campaign-a' }],
      ['setSubscriptions', subscriptions],
      ['forceSubscriptionsBootstrap', undefined],
      ['sync'],
      ['awaitLocalVisibility', { tables: ['tasks'] }],
    ]);
    expect(result).toMatchObject({
      authHeadersReplaced: true,
      subscriptionsReplaced: true,
      bootstrapReset: { subscriptionIds: null, resetCount: 2 },
      syncMode: 'explicitHeadersSync',
      syncResult: { changedTables: ['tasks'] },
      visibilityResult: [{ id: 'task-1' }],
    });
  });

  it('uses resume recovery when headers come from the configured provider', async () => {
    const database = new FakeAuthContextClient<TestDb>({
      resumeResult: syncResult({ changedTables: ['campaigns'] }),
      bootstrapResetCount: 1,
    });
    const resumeOptions = { syncAttempt: { traceId: 'trace' } };
    const subscriptions = [taskSubscription('campaign-b')];

    const result = await replaceSyncularAuthContext(database, {
      subscriptions,
      resumeOptions: resumeOptions as SyncularSyncRequestOptions,
    });

    expect(database.calls).toEqual([
      ['setSubscriptions', subscriptions],
      ['forceSubscriptionsBootstrap', undefined],
      ['resumeFromBackground', resumeOptions],
    ]);
    expect(result).toMatchObject({
      authHeadersReplaced: false,
      subscriptionsReplaced: true,
      syncMode: 'resumeFromBackground',
      syncResult: { changedTables: ['campaigns'] },
    });
  });

  it('can reset only affected subscriptions', async () => {
    const database = new FakeAuthContextClient<TestDb>();

    const result = await replaceSyncularAuthContext(database, {
      headers: { authorization: 'Bearer updated' },
      forceBootstrap: ['tasks:campaign-c'],
      sync: false,
    });

    expect(database.calls).toEqual([
      ['setAuthHeaders', { authorization: 'Bearer updated' }],
      ['forceSubscriptionsBootstrap', ['tasks:campaign-c']],
    ]);
    expect(result).toMatchObject({
      bootstrapReset: {
        subscriptionIds: ['tasks:campaign-c'],
        resetCount: 1,
      },
      syncMode: 'skipped',
      syncResult: null,
    });
  });

  it('does not reset bootstrap when explicitly disabled', async () => {
    const database = new FakeAuthContextClient<TestDb>();

    await replaceSyncularAuthContext(database, {
      headers: { authorization: 'Bearer rotated' },
      forceBootstrap: false,
      sync: false,
    });

    expect(database.calls).toEqual([
      ['setAuthHeaders', { authorization: 'Bearer rotated' }],
    ]);
  });

  it('treats empty headers as an explicit replacement', async () => {
    const database = new FakeAuthContextClient<TestDb>();

    await replaceSyncularAuthContext(database, {
      headers: {},
      forceBootstrap: false,
      sync: false,
    });

    expect(database.calls).toEqual([['setAuthHeaders', {}]]);
  });
});

class FakeAuthContextClient<DB> implements SyncularAuthContextClient<DB> {
  readonly calls: Array<[string, unknown?]> = [];
  readonly client = {
    setAuthHeaders: async (headers: SyncularAuthHeaders) => {
      this.calls.push(['setAuthHeaders', headers]);
    },
    forceSubscriptionsBootstrap: async (
      subscriptionIds?: readonly string[]
    ) => {
      this.calls.push(['forceSubscriptionsBootstrap', subscriptionIds]);
      return this.bootstrapResetCount;
    },
  };
  private readonly syncResult: SyncularSyncResult;
  private readonly resumeResult: SyncularSyncResult;
  private readonly visibilityResult: unknown;
  private readonly bootstrapResetCount: number;

  constructor(
    options: {
      syncResult?: SyncularSyncResult;
      resumeResult?: SyncularSyncResult;
      visibilityResult?: unknown;
      bootstrapResetCount?: number;
    } = {}
  ) {
    this.syncResult = options.syncResult ?? syncResult();
    this.resumeResult = options.resumeResult ?? syncResult();
    this.visibilityResult = options.visibilityResult;
    this.bootstrapResetCount = options.bootstrapResetCount ?? 1;
  }

  async setSubscriptions(
    subscriptions: readonly SyncularSubscriptionSpec[]
  ): Promise<void> {
    this.calls.push(['setSubscriptions', subscriptions]);
  }

  async resumeFromBackground(
    options?: SyncularSyncRequestOptions
  ): Promise<SyncularSyncResult> {
    this.calls.push(['resumeFromBackground', options]);
    return this.resumeResult;
  }

  async sync(): Promise<SyncularSyncResult> {
    this.calls.push(['sync']);
    return this.syncResult;
  }

  async awaitLocalVisibility<TResult>(
    _query: unknown,
    options?: unknown
  ): Promise<TResult> {
    this.calls.push(['awaitLocalVisibility', options]);
    return this.visibilityResult as TResult;
  }
}

function taskSubscription(campaignId: string): SyncularSubscriptionSpec {
  return {
    id: `tasks:${campaignId}`,
    table: 'tasks',
    scopes: { campaign_id: campaignId },
  };
}

function syncResult(
  overrides: Partial<SyncularSyncResult> = {}
): SyncularSyncResult {
  return {
    changedTables: [],
    changedRows: [],
    changedRowsTruncated: false,
    subscriptions: [],
    bootstrap: {
      channelPhase: 'complete',
      progressPercent: 100,
      isBootstrapping: false,
      criticalReady: true,
      interactiveReady: true,
      complete: true,
      activePhase: null,
      expectedSubscriptionIds: [],
      readySubscriptionIds: [],
      pendingSubscriptionIds: [],
      subscriptions: [],
      phases: [],
    },
    pushedCommits: 0,
    timings: {
      totalMs: 0,
      pushMs: 0,
      pullMs: 0,
      applyMs: 0,
      fetchMs: 0,
      decodeMs: 0,
    },
    ...overrides,
  };
}

interface TestDb {
  tasks: {
    id: string;
  };
}
