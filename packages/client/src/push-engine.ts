/**
 * @syncular/client - Sync push engine (commit-based)
 */

import type {
  SyncPushRequest,
  SyncPushResponse,
  SyncTransport,
} from '@syncular/core';
import { countSyncMetric } from '@syncular/core';
import type { Kysely } from 'kysely';
import { upsertConflictsForRejectedCommit } from './conflicts';
import {
  getNextSendableOutboxCommit,
  markOutboxCommitAcked,
  markOutboxCommitFailed,
  markOutboxCommitPending,
} from './outbox';
import type {
  SyncClientPlugin,
  SyncClientPluginContext,
} from './plugins/types';
import type { SyncClientDb } from './schema';

export interface SyncPushOnceOptions {
  clientId: string;
  actorId?: string;
  plugins?: SyncClientPlugin[];
}

export interface SyncPushOnceResult {
  pushed: boolean;
  response?: SyncPushResponse;
}

interface TransportWithWsPush extends SyncTransport {
  pushViaWs(request: SyncPushRequest): Promise<SyncPushResponse | null>;
}

function hasPushViaWs(
  transport: SyncTransport
): transport is TransportWithWsPush {
  return 'pushViaWs' in transport && typeof transport.pushViaWs === 'function';
}

function clonePushRequest(request: SyncPushRequest): SyncPushRequest {
  if (typeof structuredClone === 'function') return structuredClone(request);
  return JSON.parse(JSON.stringify(request)) as SyncPushRequest;
}

export async function syncPushOnce<DB extends SyncClientDb>(
  db: Kysely<DB>,
  transport: SyncTransport,
  options: SyncPushOnceOptions
): Promise<SyncPushOnceResult> {
  // getNextSendableOutboxCommit now atomically claims the commit
  // (marks it as 'sending' and returns it in one operation)
  const next = await getNextSendableOutboxCommit(db);
  if (!next) return { pushed: false };

  const request: SyncPushRequest = {
    clientId: options.clientId,
    clientCommitId: next.client_commit_id,
    operations: next.operations,
    schemaVersion: next.schema_version,
  };
  const ctx: SyncClientPluginContext = {
    actorId: options.actorId ?? 'unknown',
    clientId: options.clientId,
  };
  const plugins = options.plugins ?? [];

  let requestToSend = request;
  if (plugins.length > 0) {
    try {
      requestToSend = clonePushRequest(request);
      for (const plugin of plugins) {
        if (!plugin.beforePush) continue;
        requestToSend = await plugin.beforePush(ctx, requestToSend);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      await markOutboxCommitPending(db, { id: next.id, error: message });
      throw err;
    }
  }

  let res: SyncPushResponse;
  let usedWsPush = false;
  try {
    // Try WS push first if the transport supports it
    let wsResponse: SyncPushResponse | null = null;
    if (hasPushViaWs(transport)) {
      wsResponse = await transport.pushViaWs(requestToSend);
    }

    if (wsResponse) {
      res = wsResponse;
      usedWsPush = true;
    } else {
      // Fall back to HTTP
      const combined = await transport.sync({
        clientId: requestToSend.clientId,
        push: {
          clientCommitId: requestToSend.clientCommitId,
          operations: requestToSend.operations,
          schemaVersion: requestToSend.schemaVersion,
        },
      });
      if (!combined.push) {
        throw new Error('Server returned no push response');
      }
      res = combined.push;
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    // Treat transport exceptions as retryable. The sync loop already applies backoff,
    // and failed commits are reserved for terminal server rejections (e.g. conflicts).
    await markOutboxCommitPending(db, { id: next.id, error: message });
    throw err;
  }

  let responseToUse = res;
  if (plugins.length > 0) {
    try {
      for (const plugin of plugins) {
        if (!plugin.afterPush) continue;
        responseToUse = await plugin.afterPush(ctx, {
          request: requestToSend,
          response: responseToUse,
        });
      }
    } catch (err) {
      // The server already received and processed this commit. Persist the raw response
      // so we don't end up retrying a commit that was already applied.
      const responseJson = JSON.stringify(res);

      if (res.status === 'applied' || res.status === 'cached') {
        await markOutboxCommitAcked(db, {
          id: next.id,
          commitSeq: res.commitSeq ?? null,
          responseJson,
        });
      } else {
        await upsertConflictsForRejectedCommit(db, {
          outboxCommitId: next.id,
          clientCommitId: next.client_commit_id,
          response: res,
        });
        await markOutboxCommitFailed(db, {
          id: next.id,
          error: 'REJECTED',
          responseJson,
        });
      }

      throw err;
    }
  }

  const responseJson = JSON.stringify(responseToUse);
  const detectedConflicts = responseToUse.results.reduce(
    (count, result) => count + (result.status === 'conflict' ? 1 : 0),
    0
  );
  if (detectedConflicts > 0 && !usedWsPush) {
    countSyncMetric('sync.conflicts.detected', detectedConflicts, {
      attributes: {
        source: 'client',
        transport: 'http',
      },
    });
  }

  if (responseToUse.status === 'applied' || responseToUse.status === 'cached') {
    await markOutboxCommitAcked(db, {
      id: next.id,
      commitSeq: responseToUse.commitSeq ?? null,
      responseJson,
    });
    return { pushed: true, response: responseToUse };
  }

  // Check if all errors are retriable - if so, keep pending for retry
  const errorResults = responseToUse.results.filter(
    (r) => r.status === 'error'
  );
  const allRetriable =
    errorResults.length > 0 && errorResults.every((r) => r.retriable === true);

  if (allRetriable) {
    // All errors are retriable - keep commit pending for retry
    const errorMessages = errorResults
      .map((r) => r.error ?? 'Unknown error')
      .join('; ');
    await markOutboxCommitPending(db, {
      id: next.id,
      error: `Retriable: ${errorMessages}`,
      responseJson,
    });
    return { pushed: true, response: responseToUse };
  }

  // Terminal rejection - mark as failed and record conflicts
  await upsertConflictsForRejectedCommit(db, {
    outboxCommitId: next.id,
    clientCommitId: next.client_commit_id,
    response: responseToUse,
  });
  await markOutboxCommitFailed(db, {
    id: next.id,
    error: 'REJECTED',
    responseJson,
  });
  return { pushed: true, response: responseToUse };
}
