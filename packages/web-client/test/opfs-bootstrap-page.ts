import { singleOwnerLock } from '../src/leader-lock';
import type { SyncProgress } from '../src/progress';
import {
  createSyncClientHandle,
  type SyncClientHandle,
} from '../src/worker-host';
import {
  OPFS_SCHEMA,
  type CrashPoint,
  type CrashReceipt,
  type OpfsProbe,
} from './opfs-bootstrap-fixture';

declare global {
  interface Window {
    opfsTest: {
      ready: Promise<SyncClientHandle>;
      progress: SyncProgress[];
      open(contend?: boolean): Promise<void>;
      storageBusy: Promise<void>;
      terminate(): boolean;
      crash: Promise<CrashReceipt>;
      arm(point: CrashPoint): Promise<void>;
      probe(): Promise<OpfsProbe>;
    };
  }
}

let worker: Worker;
let imageCommitted = false;
let announceStorageBusy: () => void;
let announceCrash: (receipt: CrashReceipt) => void;
window.opfsTest = {
  progress: [],
  storageBusy: new Promise((resolve) => {
    announceStorageBusy = resolve;
  }),
  terminate: () => {
    worker.terminate();
    return imageCommitted;
  },
  crash: new Promise((resolve) => {
    announceCrash = resolve;
  }),
  ready: new Promise(() => {}),
  open: async (contend = false) => {
    window.opfsTest.ready = createSyncClientHandle({
      worker: () => {
        worker = new Worker('/opfs-bootstrap-worker.js', { type: 'module' });
        worker.addEventListener('message', (event) => {
          if (event.data.t === 'storage-open-failed') announceStorageBusy();
          if (event.data.t === 'crash-point') announceCrash(event.data.receipt);
          if (event.data.t === 'image-committed') imageCommitted = true;
        });
        return worker;
      },
      database: { mode: 'persistent', name: 'opfs-bootstrap-test' },
      replica: { mode: 'isolated', id: 'reload-replica' },
      ...(contend ? { leaderLock: singleOwnerLock(), multiTab: false } : {}),
      schema: OPFS_SCHEMA,
      autoSync: false,
      endpoints: {
        syncUrl: `${location.origin}/${location.search === '?signed' ? 'sync-signed' : 'sync'}`,
        segmentsUrl: `${location.origin}/segments`,
      },
    });
    (await window.opfsTest.ready).onProgress((progress) =>
      window.opfsTest.progress.push(progress),
    );
  },
  arm: (point) =>
    new Promise((resolve) => {
      const listener = (event: MessageEvent) => {
        if (event.data.t !== 'armed') return;
        worker.removeEventListener('message', listener);
        resolve();
      };
      worker.addEventListener('message', listener);
      worker.postMessage({ t: 'arm', point });
    }),
  probe: () =>
    new Promise((resolve, reject) => {
      const listener = (event: MessageEvent) => {
        if (event.data.t !== 'probe-result' && event.data.t !== 'probe-error')
          return;
        worker.removeEventListener('message', listener);
        if (event.data.t === 'probe-error')
          reject(new Error(event.data.message));
        else resolve(event.data.probe);
      };
      worker.addEventListener('message', listener);
      worker.postMessage({ t: 'probe' });
    }),
};
