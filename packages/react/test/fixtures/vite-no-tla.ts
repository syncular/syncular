import { createViteSyncClientResource } from '../../src/vite-hmr';
import { FakeClient } from '../fake-client';

interface ViteHotContext {
  readonly data: Record<string, unknown>;
  invalidate(message?: string): void;
}

const hot = (import.meta as ImportMeta & { readonly hot?: ViteHotContext }).hot;
const retained = createViteSyncClientResource(
  hot?.data,
  1,
  () => new FakeClient(),
);

void retained.handoff.then(
  () => {
    if (hot && retained.ownerChanged) {
      hot.invalidate('Syncular owner identity changed');
    }
  },
  () => undefined,
);

export const clientResource = retained.resource;
