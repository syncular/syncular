import type { MutationInput } from '@syncular/client';
import { useCallback, useRef, useState } from 'react';
import { useSyncClient } from './use-client';

export interface SyncTableDescriptor<Row, Insert, Update, Id> {
  readonly name: string;
  readonly primaryKey: keyof Row & string;
  readonly physicalPrimaryKey: string;
  readonly __row?: Row;
  readonly __insert?: Insert;
  readonly __update?: Update;
  readonly __id?: Id;
}

export interface UseMutationOptions {
  readonly onSuccess?: (clientCommitId: string) => void;
  readonly onError?: (error: Error) => void;
}

export interface UseMutationResult {
  mutate: (mutations: readonly MutationInput[]) => Promise<string>;
  readonly pendingCount: number;
  readonly isPending: boolean;
  readonly error: Error | undefined;
  readonly resetError: () => void;
}

export interface UseTableMutationResult<Insert, Update, Id>
  extends UseMutationResult {
  readonly upsert: (values: Insert, baseVersion?: number) => Promise<string>;
  readonly patch: (
    id: Id,
    partial: Partial<Update>,
    baseVersion?: number,
  ) => Promise<string>;
  readonly remove: (id: Id, baseVersion?: number) => Promise<string>;
}

export function useMutation(options?: UseMutationOptions): UseMutationResult;
export function useMutation<Row, Insert, Update, Id>(
  table: SyncTableDescriptor<Row, Insert, Update, Id>,
  options?: UseMutationOptions,
): UseTableMutationResult<Insert, Update, Id>;
export function useMutation<Row, Insert, Update, Id>(
  tableOrOptions?:
    | SyncTableDescriptor<Row, Insert, Update, Id>
    | UseMutationOptions,
  maybeOptions?: UseMutationOptions,
): UseMutationResult | UseTableMutationResult<Insert, Update, Id> {
  const client = useSyncClient();
  const table =
    tableOrOptions !== undefined && 'name' in tableOrOptions
      ? tableOrOptions
      : undefined;
  const options =
    table === undefined
      ? (tableOrOptions as UseMutationOptions | undefined)
      : maybeOptions;
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const [pendingCount, setPendingCount] = useState(0);
  const [error, setError] = useState<Error | undefined>(undefined);
  const resetError = useCallback(() => setError(undefined), []);

  const run = useCallback(
    async (operation: () => Promise<string>): Promise<string> => {
      setPendingCount((count) => count + 1);
      setError(undefined);
      try {
        const id = await operation();
        optionsRef.current?.onSuccess?.(id);
        return id;
      } catch (caught) {
        const wrapped =
          caught instanceof Error ? caught : new Error(String(caught));
        setError(wrapped);
        optionsRef.current?.onError?.(wrapped);
        throw wrapped;
      } finally {
        setPendingCount((count) => Math.max(0, count - 1));
      }
    },
    [],
  );
  const mutate = useCallback(
    (mutations: readonly MutationInput[]) =>
      run(() => client.mutate(mutations)),
    [client, run],
  );
  const base: UseMutationResult = {
    mutate,
    pendingCount,
    isPending: pendingCount > 0,
    error,
    resetError,
  };
  const upsert = useCallback(
    (values: Insert, baseVersion?: number): Promise<string> => {
      if (table === undefined)
        throw new Error('table mutation descriptor missing');
      return mutate([
        {
          table: table.name,
          op: 'upsert',
          values: values as Readonly<Record<string, unknown>>,
          ...(baseVersion !== undefined ? { baseVersion } : {}),
        },
      ]);
    },
    [mutate, table],
  );
  const patch = useCallback(
    (
      id: Id,
      partial: Partial<Update>,
      baseVersion?: number,
    ): Promise<string> => {
      if (table === undefined)
        throw new Error('table mutation descriptor missing');
      return run(() =>
        client.patch(
          table.name,
          String(id),
          partial as Readonly<Record<string, unknown>>,
          baseVersion !== undefined ? { baseVersion } : undefined,
        ),
      );
    },
    [client, run, table],
  );
  const remove = useCallback(
    (id: Id, baseVersion?: number): Promise<string> => {
      if (table === undefined)
        throw new Error('table mutation descriptor missing');
      return mutate([
        {
          table: table.name,
          op: 'delete',
          rowId: String(id),
          ...(baseVersion !== undefined ? { baseVersion } : {}),
        },
      ]);
    },
    [mutate, table],
  );
  if (table === undefined) return base;
  return { ...base, upsert, patch, remove };
}
