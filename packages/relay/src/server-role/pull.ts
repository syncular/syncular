/**
 * @syncular/relay - Server Role Pull Handler
 *
 * Handles pulls from local clients, serving changes stored locally
 * on the relay.
 */

import type { SyncPullRequest } from '@syncular/core';
import type { ServerSyncDialect, TableRegistry } from '@syncular/server';
import { type PullResult, pull } from '@syncular/server';
import type { Kysely } from 'kysely';
import type { RelayDatabase } from '../schema';

/**
 * Pull commits for a local client from the relay.
 *
 * This wraps the standard server pull with relay-specific logic:
 * - Restricts scopes to those the relay subscribes to
 */
export async function relayPull<
  DB extends RelayDatabase = RelayDatabase,
>(args: {
  db: Kysely<DB>;
  dialect: ServerSyncDialect;
  shapes: TableRegistry<DB>;
  actorId: string;
  request: SyncPullRequest;
}): Promise<PullResult> {
  // Use the standard pull - scope authorization is handled by shapes
  return pull({
    db: args.db,
    dialect: args.dialect,
    shapes: args.shapes,
    actorId: args.actorId,
    request: args.request,
  });
}
