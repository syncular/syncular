import { createViteSyncClientResource } from '../../src/vite-hmr';

interface ViteHotContext {
  readonly data: Record<string, unknown>;
  invalidate(message?: string): void;
}

const hot = (import.meta as ImportMeta & { readonly hot?: ViteHotContext }).hot;
const retained = createViteSyncClientResource(
  hot?.data,
  1,
  // The build fixture only proves module/runtime ownership wiring. Keep its
  // client self-contained so it also runs before workspace package `dist`
  // artifacts exist in a clean release checkout.
  () => ({ close: () => undefined }) as never,
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
