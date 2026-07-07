/**
 * `useMutation` — submit local mutations (§6.1). Returns a stable `mutate`
 * that appends to the outbox and applies the optimistic overlay immediately
 * (§7.1); the referencing `useRawSql` re-runs on the resulting
 * invalidation batch, so optimistic writes appear without a manual refetch.
 * `mutate` resolves to the `clientCommitId` (track it against
 * `useConflicts`/status). `isPending`/`error` cover the (usually instant)
 * submit; server acceptance is observed through status + conflicts, not
 * here.
 */

import type { MutationInput } from '@syncular/client';
import { useCallback, useState } from 'react';
import { useSyncClient } from './use-client';

export interface UseMutationResult {
  /** Submit mutations; resolves to the clientCommitId. */
  mutate: (mutations: readonly MutationInput[]) => Promise<string>;
  readonly isPending: boolean;
  readonly error: Error | undefined;
}

export function useMutation(): UseMutationResult {
  const client = useSyncClient();
  const [isPending, setIsPending] = useState(false);
  const [error, setError] = useState<Error | undefined>(undefined);

  const mutate = useCallback(
    async (mutations: readonly MutationInput[]): Promise<string> => {
      setIsPending(true);
      setError(undefined);
      try {
        const id = await client.mutate(mutations);
        return id;
      } catch (err) {
        const wrapped = err instanceof Error ? err : new Error(String(err));
        setError(wrapped);
        throw wrapped;
      } finally {
        setIsPending(false);
      }
    },
    [client],
  );

  return { mutate, isPending, error };
}
