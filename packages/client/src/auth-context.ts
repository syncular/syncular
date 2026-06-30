import type {
  SyncularLocalVisibilityOptions,
  SyncularLocalVisibilityQuery,
} from './local-visibility';
import type {
  SyncularAuthHeaders,
  SyncularSubscriptionSpec,
  SyncularSyncRequestOptions,
  SyncularSyncResult,
} from './types';

export interface SyncularAuthContextClient<DB> {
  client: {
    setAuthHeaders(headers: SyncularAuthHeaders): Promise<void>;
    forceSubscriptionsBootstrap(
      subscriptionIds?: readonly string[]
    ): Promise<number>;
  };
  setSubscriptions(
    subscriptions: readonly SyncularSubscriptionSpec[]
  ): Promise<void>;
  resumeFromBackground(
    options?: SyncularSyncRequestOptions
  ): Promise<SyncularSyncResult>;
  sync(): Promise<SyncularSyncResult>;
  awaitLocalVisibility<TResult>(
    query: SyncularLocalVisibilityQuery<DB, TResult>,
    options?: SyncularLocalVisibilityOptions<TResult>
  ): Promise<TResult>;
}

export interface SyncularAuthContextVisibilityWait<DB, TResult> {
  query: SyncularLocalVisibilityQuery<DB, TResult>;
  options?: SyncularLocalVisibilityOptions<TResult>;
}

export interface SyncularAuthContextReplacementOptions<DB, TResult = never> {
  /**
   * Explicit replacement headers. Omit this when `getHeaders` is the source of
   * truth; the recovery path will refresh headers through the configured
   * provider.
   */
  headers?: SyncularAuthHeaders;
  subscriptions?: readonly SyncularSubscriptionSpec[];
  /**
   * Defaults to true when headers or subscriptions are replaced. Pass false
   * for simple token rotation that should not reset subscription bootstrap.
   * Pass subscription ids to reset only those subscriptions.
   */
  forceBootstrap?: boolean | readonly string[];
  /**
   * Defaults to true. With explicit headers this runs `sync()` so a configured
   * `getHeaders` callback cannot overwrite the provided headers; otherwise it
   * runs `resumeFromBackground()` so dynamic headers and realtime restart are
   * refreshed together.
   */
  sync?: boolean;
  resumeOptions?: SyncularSyncRequestOptions;
  visibility?: SyncularAuthContextVisibilityWait<DB, TResult>;
}

export interface SyncularAuthContextBootstrapReset {
  /**
   * Null means all active subscriptions were reset.
   */
  subscriptionIds: readonly string[] | null;
  resetCount: number;
}

export interface SyncularAuthContextReplacementResult<TResult = never> {
  authHeadersReplaced: boolean;
  subscriptionsReplaced: boolean;
  bootstrapReset: SyncularAuthContextBootstrapReset | null;
  syncMode: 'explicitHeadersSync' | 'resumeFromBackground' | 'skipped';
  syncResult: SyncularSyncResult | null;
  visibilityResult?: TResult;
}

export async function replaceSyncularAuthContext<DB, TResult = never>(
  database: SyncularAuthContextClient<DB>,
  options: SyncularAuthContextReplacementOptions<DB, TResult>
): Promise<SyncularAuthContextReplacementResult<TResult>> {
  const authHeadersReplaced = options.headers !== undefined;
  const subscriptionsReplaced = options.subscriptions !== undefined;

  if (options.headers !== undefined) {
    await database.client.setAuthHeaders(options.headers);
  }
  if (options.subscriptions !== undefined) {
    await database.setSubscriptions(options.subscriptions);
  }

  const bootstrapReset = await resetBootstrapIfNeeded(database, {
    forceBootstrap: options.forceBootstrap,
    shouldResetByDefault: authHeadersReplaced || subscriptionsReplaced,
  });

  const { syncMode, syncResult } = await recoverAuthContext(database, {
    explicitHeaders: authHeadersReplaced,
    sync: options.sync,
    resumeOptions: options.resumeOptions,
  });

  const visibilityResult = options.visibility
    ? await database.awaitLocalVisibility(
        options.visibility.query,
        options.visibility.options
      )
    : undefined;

  return {
    authHeadersReplaced,
    subscriptionsReplaced,
    bootstrapReset,
    syncMode,
    syncResult,
    ...(options.visibility ? { visibilityResult } : {}),
  };
}

async function resetBootstrapIfNeeded<DB>(
  database: SyncularAuthContextClient<DB>,
  options: {
    forceBootstrap: SyncularAuthContextReplacementOptions<
      DB,
      unknown
    >['forceBootstrap'];
    shouldResetByDefault: boolean;
  }
): Promise<SyncularAuthContextBootstrapReset | null> {
  const forceBootstrap =
    options.forceBootstrap === undefined
      ? options.shouldResetByDefault
      : options.forceBootstrap;
  if (forceBootstrap === false) return null;

  const subscriptionIds = Array.isArray(forceBootstrap)
    ? [...forceBootstrap]
    : null;
  const resetCount = await database.client.forceSubscriptionsBootstrap(
    subscriptionIds ?? undefined
  );
  return { subscriptionIds, resetCount };
}

async function recoverAuthContext<DB>(
  database: SyncularAuthContextClient<DB>,
  options: {
    explicitHeaders: boolean;
    sync: SyncularAuthContextReplacementOptions<DB, unknown>['sync'];
    resumeOptions: SyncularSyncRequestOptions | undefined;
  }
): Promise<
  Pick<SyncularAuthContextReplacementResult<unknown>, 'syncMode' | 'syncResult'>
> {
  if (options.sync === false) {
    return { syncMode: 'skipped', syncResult: null };
  }
  if (options.explicitHeaders) {
    return {
      syncMode: 'explicitHeadersSync',
      syncResult: await database.sync(),
    };
  }
  return {
    syncMode: 'resumeFromBackground',
    syncResult: await database.resumeFromBackground(options.resumeOptions),
  };
}
