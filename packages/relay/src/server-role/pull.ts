/**
 * @syncular/relay - Server Role Pull Handler
 *
 * Handles pulls from local clients, serving changes stored locally
 * on the relay.
 */

import type { SyncPullRequest } from '@syncular/core';
import type {
  ServerHandlerCollection,
  ServerSyncDialect,
  SyncServerAuth,
} from '@syncular/server';
import { type PullResult, pull } from '@syncular/server';
import type { Kysely } from 'kysely';
import type { RelayDatabase } from '../schema';

type RelayAuth = SyncServerAuth;

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
  handlers: ServerHandlerCollection<DB, RelayAuth>;
  auth: RelayAuth;
  request: SyncPullRequest;
}): Promise<PullResult> {
  // Use the standard pull - scope authorization is handled by handlers
  return pull({
    db: args.db,
    dialect: args.dialect,
    handlers: args.handlers,
    auth: args.auth,
    request: args.request,
  });
}
