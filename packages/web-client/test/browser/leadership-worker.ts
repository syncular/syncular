import type { MainToWorkerMessage } from '../../src/worker-protocol';

const workerScope = globalThis as unknown as {
  addEventListener(
    type: 'message',
    listener: (event: MessageEvent) => void,
  ): void;
  postMessage(message: unknown): void;
};

workerScope.addEventListener('message', (event: MessageEvent) => {
  const message = event.data as MainToWorkerMessage;
  if (message.t === 'init') {
    workerScope.postMessage({
      t: 'result',
      id: message.id,
      value: { clientId: message.config.clientId ?? crypto.randomUUID() },
    });
    return;
  }
  for (const call of message.calls)
    workerScope.postMessage({
      t: 'result',
      id: call.id,
      value:
        call.method === 'statusSnapshot'
          ? {
              currentSchemaVersion: 1,
              outbox: 0,
              upgrading: false,
              syncNeeded: false,
            }
          : call.method === 'query'
            ? []
            : undefined,
    });
});

workerScope.postMessage({ t: 'ready' });

export {};
