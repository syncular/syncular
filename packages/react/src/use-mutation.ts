import type { MutationInput } from '@syncular/client';
import { useCallback, useMemo, useRef, useState } from 'react';
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
  /** Runs after durable local enqueue. The server outcome can still reject this commit. */
  readonly onEnqueued?: (clientCommitId: string) => void;
  readonly onError?: (error: Error) => void;
}

export interface UseMutationResult {
  mutate: (
    mutations: readonly MutationInput[],
    options?: { readonly clientCommitId?: string },
  ) => Promise<string>;
  readonly pendingCount: number;
  /** True while at least one local enqueue is unresolved. */
  readonly isPending: boolean;
  readonly error: Error | undefined;
  readonly resetError: () => void;
}

export interface UseTableMutationResult<
  Insert,
  Update,
  Id,
> extends UseMutationResult {
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
    async (operation: () => string | Promise<string>): Promise<string> => {
      setPendingCount((count) => count + 1);
      setError(undefined);
      try {
        const id = await operation();
        optionsRef.current?.onEnqueued?.(id);
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
    (
      mutations: readonly MutationInput[],
      options?: { readonly clientCommitId?: string },
    ) => run(() => client.mutate(mutations, options)),
    [client, run],
  );
  const base: UseMutationResult = {
    mutate,
    pendingCount,
    isPending: pendingCount > 0,
    error,
    resetError,
  };
  const helpers = useMemo(
    () =>
      table === undefined
        ? undefined
        : {
            upsert: (values: Insert, baseVersion?: number) =>
              mutate([
                {
                  table: table.name,
                  op: 'upsert',
                  values: values as Readonly<Record<string, unknown>>,
                  ...(baseVersion !== undefined ? { baseVersion } : {}),
                },
              ]),
            patch: (id: Id, partial: Partial<Update>, baseVersion?: number) =>
              run(() =>
                client.patch(
                  table.name,
                  String(id),
                  partial as Readonly<Record<string, unknown>>,
                  baseVersion !== undefined ? { baseVersion } : undefined,
                ),
              ),
            remove: (id: Id, baseVersion?: number) =>
              mutate([
                {
                  table: table.name,
                  op: 'delete',
                  rowId: String(id),
                  ...(baseVersion !== undefined ? { baseVersion } : {}),
                },
              ]),
          },
    [client, mutate, run, table],
  );
  return helpers === undefined ? base : { ...base, ...helpers };
}
