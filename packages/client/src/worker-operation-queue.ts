interface SyncularWorkerOperationQueue {
  run<T>(operation: () => T | Promise<T>): Promise<T>;
}

export function createSyncularWorkerOperationQueue(): SyncularWorkerOperationQueue {
  let tail: Promise<void> = Promise.resolve();

  return {
    run<T>(operation: () => T | Promise<T>): Promise<T> {
      const result = tail.then(operation, operation);
      tail = result.then(
        () => undefined,
        () => undefined
      );
      return result;
    },
  };
}
