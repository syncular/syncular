import type { QueryContext, SyncClientDb } from '@syncular/client';
import { useMemo, useRef } from 'react';
import {
  createSyncularReact as createSyncularReactBase,
  type UseQueryOptions,
  type UseQueryResult,
  type UseSyncQueryOptions,
  type UseSyncQueryResult,
} from './createSyncularReact';

type ExecutableQuery<TResult> = {
  execute: () => Promise<TResult>;
};

type QueryFn<DB extends SyncClientDb, TResult> = (
  ctx: QueryContext<DB>
) => ExecutableQuery<TResult> | Promise<TResult>;

type SyncularReactBindings<DB extends SyncClientDb> = ReturnType<
  typeof createSyncularReactBase<DB>
>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function shallowEqualRecords(
  left: Record<string, unknown>,
  right: Record<string, unknown>
): boolean {
  if (left === right) return true;

  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  if (leftKeys.length !== rightKeys.length) return false;

  for (const key of leftKeys) {
    if (!(key in right)) return false;
    if (!Object.is(left[key], right[key])) return false;
  }

  return true;
}

function shallowEqualQueryValues(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (!isRecord(left) || !isRecord(right)) return false;
  return shallowEqualRecords(left, right);
}

function getKeyedQueryValueKey<T>(value: T, keyField: string): string | null {
  if (!isRecord(value) || !(keyField in value)) return null;

  const key = value[keyField];
  if (key === null || key === undefined) return null;
  return String(key);
}

function buildUniqueKeyMap<T>(
  items: T[],
  keyField: string
): Map<string, T> | null {
  const itemsByKey = new Map<string, T>();

  for (const item of items) {
    const key = getKeyedQueryValueKey(item, keyField);
    if (key === null || itemsByKey.has(key)) {
      return null;
    }
    itemsByKey.set(key, item);
  }

  return itemsByKey;
}

function shareArrayResult<T>(previous: T[], next: T[], keyField: string): T[] {
  if (previous.length === 0 || next.length === 0) {
    return next;
  }

  const previousByKey = buildUniqueKeyMap(previous, keyField);
  const nextByKey = buildUniqueKeyMap(next, keyField);
  const shared = next.slice();

  if (previousByKey && nextByKey) {
    for (const [index, item] of next.entries()) {
      const key = getKeyedQueryValueKey(item, keyField);
      if (key === null) {
        return next;
      }

      const previousItem = previousByKey.get(key);
      if (
        previousItem !== undefined &&
        shallowEqualQueryValues(previousItem, item)
      ) {
        shared[index] = previousItem;
      }
    }
  } else {
    const limit = Math.min(previous.length, next.length);
    for (let index = 0; index < limit; index += 1) {
      const previousItem = previous[index];
      const nextItem = next[index];
      if (
        previousItem !== undefined &&
        nextItem !== undefined &&
        shallowEqualQueryValues(previousItem, nextItem)
      ) {
        shared[index] = previousItem;
      }
    }
  }

  if (shared.length !== previous.length) {
    return shared;
  }

  for (let index = 0; index < shared.length; index += 1) {
    if (!Object.is(shared[index], previous[index])) {
      return shared;
    }
  }

  return previous;
}

function shareQueryResult<TResult>(
  previous: TResult | undefined,
  next: TResult | undefined,
  keyField: string,
  enabled: boolean
): TResult | undefined {
  if (!enabled || previous === undefined || next === undefined) {
    return next;
  }

  if (Array.isArray(previous) && Array.isArray(next)) {
    return shareArrayResult(previous, next, keyField) as TResult;
  }

  if (
    isRecord(previous) &&
    isRecord(next) &&
    shallowEqualRecords(previous, next)
  ) {
    return previous;
  }

  return next;
}

export function createSyncularReact<
  DB extends SyncClientDb,
>(): SyncularReactBindings<DB> {
  const base = createSyncularReactBase<DB>();

  function useSyncQuery<TResult>(
    queryFn: QueryFn<DB, TResult>,
    options: UseSyncQueryOptions = {}
  ): UseSyncQueryResult<TResult> {
    const keyField = options.keyField ?? 'id';
    const structuralSharing = options.structuralSharing !== false;
    const sharedDataRef = useRef<TResult | undefined>(undefined);
    const query = base.useSyncQuery(queryFn, {
      ...options,
      structuralSharing: false,
    });

    const data = useMemo(() => {
      const shared = shareQueryResult(
        sharedDataRef.current,
        query.data,
        keyField,
        structuralSharing
      );
      sharedDataRef.current = shared;
      return shared;
    }, [query.data, keyField, structuralSharing]);

    return useMemo(
      () => ({
        ...query,
        data,
      }),
      [query, data]
    );
  }

  function useQuery<TResult>(
    queryFn: QueryFn<DB, TResult>,
    options: UseQueryOptions = {}
  ): UseQueryResult<TResult> {
    const { enabled = true, deps = [], keyField = 'id' } = options;
    const query = useSyncQuery(queryFn, {
      enabled,
      deps,
      keyField,
      refreshOnDataChange: false,
      loadingOnRefresh: true,
      transitionUpdates: false,
    });

    return useMemo(
      () => ({
        data: query.data,
        isLoading: query.isLoading,
        error: query.error,
        refetch: query.refetch,
      }),
      [query.data, query.isLoading, query.error, query.refetch]
    );
  }

  return {
    ...base,
    useQuery,
    useSyncQuery,
  } as SyncularReactBindings<DB>;
}
