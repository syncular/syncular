/**
 * Page-side entry of the documented web setup: `createSyncClientHandle`
 * spawns the sync worker, which runs the client core and sqlite-wasm.
 */
import { createSyncClientHandle } from '@syncular/client';

(globalThis as Record<string, unknown>).__syncularHandle =
  createSyncClientHandle;
