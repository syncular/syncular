import type { SiblingEvidence } from './opfs-sibling-fixture';

declare global {
  interface Window {
    opfsSiblingTest: {
      /** Run the sibling scenario in a fresh worker and resolve its report. */
      run(): Promise<SiblingEvidence>;
    };
  }
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
};
