/**
 * The real worker entry with a round-controlled transport: every sync round
 * crosses to the test process, which parks or answers it. That makes the host
 * loop's round count observable and holdable without timers.
 */
import { BunClientDatabase } from '../src/bun-database';
import { startSyncWorker } from '../src/worker-entry';

const replies = new Map<string, (bytes: Uint8Array) => void>();
let rounds = 0;

addEventListener('message', (event) => {
  const message = event.data as {
    readonly t?: string;
    readonly id?: string;
    readonly bytes?: Uint8Array;
  };
  if (
    message.t !== 'round-reply' ||
    message.id === undefined ||
    message.bytes === undefined
  )
    return;
  replies.get(message.id)?.(message.bytes);
  replies.delete(message.id);
});

startSyncWorker({
  openDatabase: () => new BunClientDatabase(),
  createRealtime: () => undefined,
  createTransport: () => (request) => {
    const id = String(++rounds);
    const reply = new Promise<Uint8Array>((resolve) =>
      replies.set(id, resolve),
    );
    postMessage({ t: 'round', id, bytes: request });
    return reply;
  },
});
