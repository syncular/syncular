import { expect, test } from 'bun:test';

interface WorkerMessage {
  readonly id?: number;
  readonly kind: string;
  readonly ok?: boolean;
  readonly status?: number;
  readonly body?: {
    readonly row?: { readonly exists: boolean; readonly serverVersion: number };
    readonly horizon?: { readonly maxCommitSeq: number };
  };
  readonly error?: { readonly code: string; readonly message: string };
}

test('embedded server seeds before serving its admin routes', async () => {
  const worker = new Worker(new URL('./server-worker.ts', import.meta.url));
  try {
    let horizon: WorkerMessage | undefined;
    const response = await new Promise<WorkerMessage>((resolve, reject) => {
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
          worker.postMessage({ kind: 'admin', id: 1, path: '/horizon' });
        } else if (message.kind === 'result' && message.id === 1) {
          horizon = message;
          worker.postMessage({
            kind: 'admin',
            id: 2,
            path: '/rows/todos/seed-1',
          });
        } else if (message.kind === 'result' && message.id === 2) {
          resolve(message);
        }
      };
    });
    expect(response.ok).toBe(true);
    expect(response.status).toBe(200);
    expect(horizon?.body?.horizon?.maxCommitSeq).toBe(1);
    expect(response.body?.row).toMatchObject({
      exists: true,
      serverVersion: 1,
    });
  } finally {
    worker.terminate();
  }
});
