/**
 * The real worker entry with its timer and realtime socket crossing to the
 * test process: the test delivers socket text and fires the watchdog the
 * worker's client scheduled, without a timer (§8.5).
 */
import { BunClientDatabase } from '../src/bun-database';
import type { RealtimeHandlers } from '../src/transport';
import { startSyncWorker } from '../src/worker-remote';

let socket: RealtimeHandlers | undefined;
const timers: Array<() => void> = [];
addEventListener('message', (event) => {
  const message = event.data as { readonly t?: string; readonly text?: string };
  if (message.t === 'socket-text') socket?.onText(message.text ?? '');
  if (message.t === 'fire-timer') timers.shift()?.();
});

startSyncWorker({
  openDatabase: () => new BunClientDatabase(),
  createRealtime: () => (handlers) => {
    socket = handlers;
    return {
      send: () => {},
      sendBytes: () => {},
      close: () => postMessage({ t: 'socket-closed' }),
    };
  },
  scheduleBackground: (callback, delayMs) => {
    timers.push(callback);
    postMessage({ t: 'timer', delayMs });
    return () => {
      const index = timers.indexOf(callback);
      if (index >= 0) timers.splice(index, 1);
    };
  },
});
