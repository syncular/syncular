/**
 * GET /health
 */

import type { SqlFamily, SyncCoreDb } from '@syncular/server';
import type { SyncRoutesContext } from './context';
import type { SyncAuthResult } from './shared';

export function registerHealthRoutes<
  DB extends SyncCoreDb = SyncCoreDb,
  Auth extends SyncAuthResult = SyncAuthResult,
  F extends SqlFamily = SqlFamily,
>(ctx: SyncRoutesContext<DB, Auth, F>): void {
  const { routes } = ctx;

  // -------------------------------------------------------------------------
  // GET /health
  // -------------------------------------------------------------------------

  routes.get('/health', (c) => {
    return c.json({
      status: 'healthy',
      timestamp: new Date().toISOString(),
    });
  });
}
