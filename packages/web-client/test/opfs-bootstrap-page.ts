import type { ClientSchema } from '../src/schema';
import type { ClientDiagnosticsSnapshot } from '../src/diagnostics';
import { singleOwnerLock } from '../src/leader-lock';
import { ReactiveClientStore } from '../src/reactive-store';
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
      diagnostics: ClientDiagnosticsSnapshot[];
      changes: number;
      activated: Promise<void>;
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
      gatePhases(): Promise<string[]>;
    };
  }
}

let worker: Worker;
let imageCommitted = false;
let announceStorageBusy: () => void;
let announceCrash: (receipt: CrashReceipt) => void;
window.opfsTest = {
  progress: [],
  diagnostics: [],
  changes: 0,
  activated: new Promise(() => {}),
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
      ...(location.hash === '#navigate' ? { securityPreflight: true } : {}),
      endpoints: {
        syncUrl: `${location.origin}/${schema.version >= 200 ? 'sync-relax' : schema.version >= 100 ? 'sync-alternative' : schema.version >= 89 ? 'sync-scope' : location.search === '?fresh' ? 'sync-fresh' : location.search === '?signed' ? 'sync-signed' : 'sync'}`,
        segmentsUrl: `${location.origin}/${schema.version >= 200 ? 'relax-segments' : schema.version >= 100 ? 'alternative-segments' : schema.version >= 89 ? 'scope-segments' : location.search === '?fresh' ? 'fresh-segments' : 'segments'}`,
      },
    });
    (await window.opfsTest.ready).onProgress((progress) =>
      window.opfsTest.progress.push(progress),
    );
  },
  gatePhases: async () => {
    const client = await window.opfsTest.ready;
    const store = new ReactiveClientStore(client);
    const entry = store.query({
      id: 'gate',
      sql: 'SELECT id FROM catalogue ORDER BY id',
      dependencies: [{ table: 'catalogue' }],
    });
    const late = store.query({
      id: 'gate-late',
      sql: 'SELECT id FROM catalogue ORDER BY id',
      dependencies: [{ table: 'catalogue' }],
    });
    const phases: string[] = [];
    const reached = (target: typeof entry, done: () => boolean) =>
      new Promise<void>((resolve) => {
        const check = () => {
          if (!done()) return;
          off();
          resolve();
        };
        const off = target.subscribe(check);
        check();
      });
    const keep = entry.subscribe(() => {});
    await reached(entry, () => entry.getSnapshot().phase === 'ready');
    phases.push(entry.getSnapshot().phase);
    await client.beginSecurityPreflight();
    entry.refresh();
    // The refused refresh ends without an error and keeps the snapshot.
    await reached(entry, () => !entry.getSnapshot().isRefreshing);
    const keepLate = late.subscribe(() => {});
    phases.push(entry.getSnapshot().phase, String(entry.getSnapshot().error));
    await client.activateSecurity();
    await reached(late, () => late.getSnapshot().phase === 'ready');
    phases.push(late.getSnapshot().phase);
    keep();
    keepLate();
    store.dispose();
    return phases;
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

// An application page opens its handle at module load, while the previous
// document of the same tab may still hold the lock.
if (location.hash === '#navigate') {
  window.opfsTest.activated = window.opfsTest
    .open(false, OPFS_SCHEMA, true)
    .then(async () => {
      const client = await window.opfsTest.ready;
      client.onDiagnostics((snapshot) =>
        window.opfsTest.diagnostics.push(snapshot),
      );
      client.onChange(() => {
        window.opfsTest.changes += 1;
      });
      await client.beginSecurityPreflight();
      await client.activateSecurity();
    });
}
