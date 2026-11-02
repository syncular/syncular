import type { LeaderUnreachableEvent } from '../src/multi-tab';
import type { ClientSchema } from '../src/schema';
import {
  createSyncClientHandle,
  type HandleRole,
  type SyncClientHandle,
} from '../src/worker-host';
import {
  LOCAL_AUTHORITY_DATABASE,
  type LocalAuthorityProbe,
} from './local-authority-browser-fixture';

declare global {
  interface Window {
    localAuthorityTest: {
      ready: Promise<SyncClientHandle>;
      /** Open the persistent handle; resolves with its multi-tab role. */
      open(
        schema: ClientSchema,
        followerCallTimeoutMs?: number,
      ): Promise<HandleRole>;
      /** Every `onLeaderUnreachable` event this tab's handle reported. */
      unreachable: LeaderUnreachableEvent[];
      /** Ask this tab's worker (a leader's only) for its OPFS evidence. */
      probe(): Promise<LocalAuthorityProbe>;
    };
  }
}

let worker: Worker | undefined;
window.localAuthorityTest = {
  ready: new Promise(() => {}),
  unreachable: [],
  open: async (schema, followerCallTimeoutMs) => {
    window.localAuthorityTest.ready = createSyncClientHandle({
      worker: () => {
        worker = new Worker('/local-authority-browser-worker.js', {
          type: 'module',
        });
        return worker;
      },
      schema,
      database: { mode: 'persistent', name: LOCAL_AUTHORITY_DATABASE },
      endpoints: {
        syncUrl: `${location.origin}/sync`,
        segmentsUrl: `${location.origin}/segments`,
      },
      localAuthority: true,
      autoSync: false,
      ...(followerCallTimeoutMs !== undefined ? { followerCallTimeoutMs } : {}),
      onLeaderUnreachable: (event) =>
        window.localAuthorityTest.unreachable.push(event),
    });
    return (await window.localAuthorityTest.ready).role;
  },
  probe: () =>
    new Promise((resolve, reject) => {
      const target = worker;
      if (target === undefined) {
        reject(new Error('this tab spawned no worker'));
        return;
      }
      const listener = (event: MessageEvent) => {
        if (event.data.t !== 'probe-result' && event.data.t !== 'probe-error')
          return;
        target.removeEventListener('message', listener);
        if (event.data.t === 'probe-error')
          reject(new Error(event.data.message));
        else resolve(event.data.probe);
      };
      target.addEventListener('message', listener);
      target.postMessage({ t: 'probe' });
    }),
};
