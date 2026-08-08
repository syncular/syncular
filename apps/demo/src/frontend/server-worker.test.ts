import { test } from 'bun:test';

interface WorkerMessage {
  readonly kind: string;
  readonly error?: { readonly code: string; readonly message: string };
}

test('embedded server reaches ready only after its seed applies', async () => {
  const worker = new Worker(new URL('./server-worker.ts', import.meta.url));
  try {
    await new Promise<void>((resolve, reject) => {
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
          resolve();
        }
      };
    });
  } finally {
    worker.terminate();
  }
});
