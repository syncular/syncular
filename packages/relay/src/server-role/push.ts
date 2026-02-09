/**
 * @syncular/relay - Server Role Push Handler
 *
 * Handles pushes from local clients, storing them locally and
 * queueing them for forwarding to the main server.
 */

import type { SyncPushRequest } from '@syncular/core';
import type { ServerSyncDialect, TableRegistry } from '@syncular/server';
import { type PushCommitResult, pushCommit } from '@syncular/server';
import { type Kysely, sql } from 'kysely';
import type { RelayDatabase } from '../schema';

function randomId(): string {
  if (
    typeof crypto !== 'undefined' &&
    typeof crypto.randomUUID === 'function'
  ) {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

/**
 * Push a commit from a local client to the relay.
 *
 * This wraps the standard server pushCommit with relay-specific logic:
 * 1. Validates that operations are within the relay's scope
 * 2. Stores the commit locally
 * 3. Enqueues the commit for forwarding to the main server
 */
export async function relayPushCommit<
  DB extends RelayDatabase = RelayDatabase,
>(args: {
  db: Kysely<DB>;
  dialect: ServerSyncDialect;
  shapes: TableRegistry<DB>;
  actorId: string;
  request: SyncPushRequest;
}): Promise<PushCommitResult> {
  const { request } = args;

  // Use the standard pushCommit - scope authorization is handled by shapes
  const result = await pushCommit({
    db: args.db,
    dialect: args.dialect,
    shapes: args.shapes,
    actorId: args.actorId,
    request,
  });

  // If the commit was applied, enqueue it for forwarding to main server
  if (
    result.response.ok === true &&
    result.response.status === 'applied' &&
    typeof result.response.commitSeq === 'number'
  ) {
    await enqueueForForwarding(args.db, {
      localCommitSeq: result.response.commitSeq,
      clientId: request.clientId,
      clientCommitId: request.clientCommitId,
      operations: request.operations,
      schemaVersion: request.schemaVersion,
    });
  }

  return result;
}

/**
 * Enqueue a locally-committed change for forwarding to the main server.
 */
async function enqueueForForwarding<DB extends RelayDatabase>(
  db: Kysely<DB>,
  args: {
    localCommitSeq: number;
    clientId: string;
    clientCommitId: string;
    operations: SyncPushRequest['operations'];
    schemaVersion: number;
  }
): Promise<void> {
  const now = Date.now();

  await sql`
    insert into ${sql.table('relay_forward_outbox')} (
      id,
      local_commit_seq,
      client_id,
      client_commit_id,
      operations_json,
      schema_version,
      status,
      main_commit_seq,
      error,
      last_response_json,
      created_at,
      updated_at,
      attempt_count
    )
    values (
      ${randomId()},
      ${args.localCommitSeq},
      ${args.clientId},
      ${args.clientCommitId},
      ${JSON.stringify(args.operations)},
      ${args.schemaVersion},
      'pending',
      ${null},
      ${null},
      ${null},
      ${now},
      ${now},
      ${0}
    )
  `.execute(db);

  // Also create a sequence map entry for this commit
  await sql`
    insert into ${sql.table('relay_sequence_map')} (
      local_commit_seq,
      main_commit_seq,
      status,
      created_at,
      updated_at
    )
    values (${args.localCommitSeq}, ${null}, 'pending', ${now}, ${now})
    on conflict (local_commit_seq) do nothing
  `.execute(db);
}
