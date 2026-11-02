import type { FenceEvidence, SiblingEvidence } from './opfs-sibling-fixture';

declare global {
  interface Window {
    opfsSiblingTest: {
      /** Run the sibling scenario in a fresh worker and resolve its report. */
      run(): Promise<SiblingEvidence>;
      /**
       * Two workers on one replica: a holder with an open sibling, then a
       * taker that steals the storage lock while the holder keeps running.
       */
      fence(): Promise<FenceEvidence>;
    };
  }
}

/** Post one fence step to a worker and resolve its report. */
function step<T>(worker: Worker, t: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const listener = (event: MessageEvent) => {
      const data = event.data as
        | { t: 'report'; value: T }
        | { t: 'error'; message: string };
      worker.removeEventListener('message', listener);
      if (data.t === 'report') resolve(data.value);
      else reject(new Error(data.message));
    };
    worker.addEventListener('message', listener);
    worker.postMessage({ t });
  });
}

window.opfsSiblingTest = {
  run: () =>
    new Promise<SiblingEvidence>((resolve, reject) => {
      const worker = new Worker('/opfs-sibling-worker.js', { type: 'module' });
      const settle = (fn: () => void) => {
        worker.terminate();
        fn();
      };
      worker.addEventListener('message', (event: MessageEvent) => {
        const data = event.data as
          | { t: 'report'; evidence: SiblingEvidence }
          | { t: 'error'; message: string };
        if (data.t === 'report') settle(() => resolve(data.evidence));
        else if (data.t === 'error')
          settle(() => reject(new Error(data.message)));
      });
      worker.addEventListener('error', (event) =>
        settle(() => reject(new Error(event.message))),
      );
      worker.postMessage({ t: 'run' });
    }),
  fence: async () => {
    const holder = new Worker('/opfs-sibling-worker.js', { type: 'module' });
    const taker = new Worker('/opfs-sibling-worker.js', { type: 'module' });
    try {
      await step(holder, 'fence-hold');
      const taken = await step<
        Pick<FenceEvidence, 'rowsAtTakeover' | 'integrity'>
      >(taker, 'fence-take');
      const writes = await step<{ replica: string; sibling: string }>(
        holder,
        'fence-write',
      );
      return {
        ...taken,
        fencedReplicaWrite: writes.replica,
        fencedSiblingWrite: writes.sibling,
        rowsAtEnd: await step<string[]>(taker, 'fence-rows'),
      };
    } finally {
      holder.terminate();
      taker.terminate();
    }
  },
};
