import type { SyncOperation, SyncPushBatchResponse } from '@syncular/core';

export function createSingleCommitPush(
  clientCommitId: string,
  operations: SyncOperation[],
  schemaVersion = 1
) {
  return {
    commits: [
      {
        clientCommitId,
        operations,
        schemaVersion,
      },
    ],
  };
}

export function getSinglePushStatus(
  push: SyncPushBatchResponse | undefined
): SyncPushBatchResponse['commits'][number]['status'] | undefined {
  return push?.commits[0]?.status;
}
