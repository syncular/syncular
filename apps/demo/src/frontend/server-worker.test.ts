import { expect, test } from 'bun:test';

interface WorkerMessage {
  readonly id?: number;
  readonly kind: string;
  readonly ok?: boolean;
  readonly error?: { readonly code: string; readonly message: string };
  readonly snapshot?: {
    readonly horizon: { readonly maxCommitSeq: number };
    readonly commits: readonly { readonly commitSeq: number }[];
    readonly events: readonly { readonly type: string }[];
  };
}

test('embedded server boots, seeds, and exposes its admin snapshot', async () => {
  const worker = new Worker(new URL('./server-worker.ts', import.meta.url));
  try {
    const snapshot = await new Promise<WorkerMessage['snapshot']>(
      (resolve, reject) => {
        worker.onerror = (event) => reject(event.error);
        worker.onmessage = (event: MessageEvent<WorkerMessage>) => {
          const message = event.data;
          if (message.kind === 'boot-error') {
            reject(
              new Error(
                `${message.error?.code ?? 'sync.internal'}: ${message.error?.message ?? 'embedded server failed to start'}`,
              ),
            );
          } else if (message.kind === 'ready') {
            worker.postMessage({ kind: 'admin-snapshot', id: 1 });
          } else if (message.kind === 'result' && message.id === 1) {
            resolve(message.snapshot);
          }
        };
      },
    );
    expect(snapshot?.horizon.maxCommitSeq).toBe(1);
    expect(snapshot?.commits).toEqual([
      expect.objectContaining({ commitSeq: 1 }),
    ]);
    expect(
      snapshot?.events.some((event) => event.type === 'push.applied'),
    ).toBe(true);
  } finally {
    worker.terminate();
  }
});
