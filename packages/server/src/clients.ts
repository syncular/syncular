/**
 * @syncular/server - Client cursor tracking
 */

import type { ScopeValues } from '@syncular/core';
import type { DbExecutor, ServerSyncDialect } from './dialect/types';
import type { SyncCoreDb } from './schema';

export async function recordClientCursor<DB extends SyncCoreDb>(
  db: DbExecutor<DB>,
  dialect: ServerSyncDialect,
  args: {
    partitionId?: string;
    clientId: string;
    actorId: string;
    cursor: number;
    effectiveScopes: ScopeValues;
  }
): Promise<void> {
  await dialect.recordClientCursor(db, args);
}
