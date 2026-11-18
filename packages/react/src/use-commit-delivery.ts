/**
 * `useCommitDelivery(ids)`: the §7.5 delivery status of each client commit in
 * `ids`, in request order, from one `snapshotRead`. The hook re-reads when a
 * change batch carries a status (outbox writes and drains report one) or an
 * outcome-journal change, so a commit moves from `pending` to `known` without
 * polling. `unknown` means neither the outbox nor the journal holds the id:
 * this client never wrote it, or retention pruned its outcome.
 */

import type { CommitDelivery } from '@syncular/client';
import { useEffect, useState } from 'react';
import type { SyncClientLike } from './client';
import { useSyncClient } from './use-client';

export interface UseCommitDeliveryResult {
  /** One entry per requested id, in request order; empty until the first read. */
  readonly deliveries: readonly CommitDelivery[];
  readonly isLoading: boolean;
  readonly error: Error | undefined;
}

const LOADING: UseCommitDeliveryResult = {
  deliveries: [],
  isLoading: true,
  error: undefined,
};

export function useCommitDelivery(
  ids: readonly string[],
): UseCommitDeliveryResult {
  const client = useSyncClient();
  const key = JSON.stringify(ids);
  const [snapshot, setSnapshot] = useState<{
    client: SyncClientLike;
    key: string;
    result: UseCommitDeliveryResult;
  }>(() => ({ client, key, result: LOADING }));
  if (snapshot.client !== client || snapshot.key !== key) {
    setSnapshot({ client, key, result: LOADING });
  }

  useEffect(() => {
    const commitIds: readonly string[] = JSON.parse(key);
    let generation = 0;
    const settle = (next: UseCommitDeliveryResult) =>
      setSnapshot((previous) => {
        if (previous.client !== client || previous.key !== key) return previous;
        const current = previous.result;
        // A status batch without a delivery transition keeps the snapshot.
        // A journal entry changes only by resolution; `sequence` names it.
        const same =
          !current.isLoading &&
          current.error === next.error &&
          current.deliveries.every((delivery, index) => {
            const other = next.deliveries[index]!;
            return delivery.status === 'known' && other.status === 'known'
              ? delivery.outcome.sequence === other.outcome.sequence &&
                  delivery.outcome.resolution === other.outcome.resolution
              : delivery.status === other.status;
          });
        return same ? previous : { client, key, result: next };
      });
    const read = () => {
      const request = ++generation;
      void Promise.resolve()
        .then(() => client.snapshotRead({ statements: [], commitIds }))
        .then(
          (result) => {
            if (request === generation)
              settle({
                deliveries: result.deliveries,
                isLoading: false,
                error: undefined,
              });
          },
          (error: unknown) => {
            if (request === generation)
              settle({
                deliveries: [],
                isLoading: false,
                error:
                  error instanceof Error ? error : new Error(String(error)),
              });
          },
        );
    };
    const unsubscribe = client.onChange((batch) => {
      if (batch.outcomesChanged || batch.status !== undefined) read();
    });
    read();
    return () => {
      generation += 1;
      unsubscribe();
    };
  }, [client, key]);

  return snapshot.client === client && snapshot.key === key
    ? snapshot.result
    : LOADING;
}
