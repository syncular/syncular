const workerScope = globalThis as unknown as {
  addEventListener(
    type: 'message',
    listener: (event: MessageEvent) => void,
  ): void;
  postMessage(message: unknown): void;
};

workerScope.addEventListener('message', (event: MessageEvent) => {
  const message = event.data as {
    readonly t?: string;
    readonly id?: number;
    readonly config?: { readonly clientId?: string };
    readonly method?: string;
  };
  if (message.t === 'init') {
    workerScope.postMessage({
      t: 'result',
      id: message.id,
      value: { clientId: message.config?.clientId ?? crypto.randomUUID() },
    });
    return;
  }
  if (message.t !== 'call') return;
  const value =
    message.method === 'statusSnapshot'
      ? {
          currentSchemaVersion: 1,
          outbox: 0,
          upgrading: false,
          syncNeeded: false,
        }
      : message.method === 'query'
        ? []
        : undefined;
  workerScope.postMessage({ t: 'result', id: message.id, value });
});

workerScope.postMessage({ t: 'ready' });

export {};
