import type { ClientSchema } from '../src/schema';
import type { ClientDiagnosticsSnapshot } from '../src/diagnostics';
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
      evidence: Promise<[SyncProgress, ClientDiagnosticsSnapshot]>;
      watchRound(state: 'failed' | 'complete'): Promise<void>;
      open(
        contend?: boolean,
        schema?: ClientSchema,
        autoSync?: boolean,
      ): Promise<void>;
      storageBusy: Promise<void>;
      terminate(): boolean;
      crash: Promise<CrashReceipt>;
      arm(point: CrashPoint): Promise<void>;
      probe(): Promise<OpfsProbe>;
      limitStorage(limit: number, failCommit?: boolean): Promise<void>;
    };
  }
}

let worker: Worker;
let imageCommitted = false;
let announceStorageBusy: () => void;
let announceCrash: (receipt: CrashReceipt) => void;
window.opfsTest = {
  progress: [],
  evidence: new Promise(() => {}),
  watchRound: async (state) => {
    const client = await window.opfsTest.ready;
    const progress = new Promise<SyncProgress>((resolve) => {
      let off = () => {};
      off = client.onProgress((value) => {
        if (value.state !== state) return;
        off();
        resolve(value);
      });
    });
    const diagnostics = new Promise<ClientDiagnosticsSnapshot>((resolve) => {
      let off = () => {};
      off = client.onDiagnostics((value) => {
        if (
          value.lastRound?.status !==
          (state === 'failed' ? 'failed' : 'succeeded')
        )
          return;
        off();
        resolve(value);
      });
    });
    window.opfsTest.evidence = Promise.all([progress, diagnostics]);
  },
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
  open: async (contend = false, schema = OPFS_SCHEMA, autoSync = false) => {
    window.opfsTest.ready = createSyncClientHandle({
      worker: () => {
        worker = new Worker(
          `${location.pathname === '/production/' ? '/production' : ''}/opfs-bootstrap-worker.js${location.search === '?responsive' ? '?responsive' : ''}`,
          { type: 'module' },
        );
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
      schema,
      autoSync,
      retainFailedCommits: true,
      endpoints: {
        syncUrl: `${location.origin}/${schema.version >= 100 ? 'sync-alternative' : schema.version >= 89 ? 'sync-scope' : location.search === '?fresh' ? 'sync-fresh' : location.search === '?signed' ? 'sync-signed' : 'sync'}`,
        segmentsUrl: `${location.origin}/${schema.version >= 100 ? 'alternative-segments' : schema.version >= 89 ? 'scope-segments' : location.search === '?fresh' ? 'fresh-segments' : 'segments'}`,
      },
    });
    (await window.opfsTest.ready).onProgress((progress) =>
      window.opfsTest.progress.push(progress),
    );
  },
  limitStorage: (limit, failCommit = false) =>
    new Promise((resolve) => {
      const listener = (event: MessageEvent) => {
        if (event.data.t !== 'page-limit-set') return;
        worker.removeEventListener('message', listener);
        resolve();
      };
      worker.addEventListener('message', listener);
      worker.postMessage({ t: 'page-limit', limit, failCommit });
    }),
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
