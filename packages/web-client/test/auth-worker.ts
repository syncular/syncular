/**
 * A worker entry whose header source lives in the worker (§1.1): each call
 * asks the test over a BroadcastChannel and answers with the test's reply.
 * `rejected` carries the refused `Authorization` after a 401.
 */
import { BunClientDatabase } from '../src/bun-database';
import { startSyncWorker } from '../src/worker-remote';

const channel = new BroadcastChannel('auth-worker');
const answers: ((authorization: string) => void)[] = [];
channel.onmessage = (event: MessageEvent<string>) =>
  answers.shift()?.(event.data);

startSyncWorker({
  openDatabase: () => new BunClientDatabase(),
  headers: (rejected) =>
    new Promise((resolve) => {
      answers.push((authorization) =>
        resolve({ Authorization: authorization }),
      );
      channel.postMessage(rejected?.Authorization ?? null);
    }),
});
