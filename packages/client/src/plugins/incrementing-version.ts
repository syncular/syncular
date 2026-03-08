import type {
  SyncOperation,
  SyncPushRequest,
  SyncPushResponse,
} from '@syncular/core';
import type { SyncClientPlugin, SyncClientPluginContext } from './types';

export const INCREMENTING_VERSION_PLUGIN_KIND = 'incrementing-version';

export interface IncrementingVersionPluginOptions {
  /**
   * Plugin name (used for debugging).
   * Defaults to "incrementing-version".
   */
  name?: string;
  /**
   * Maximum number of rows to track in memory.
   * Defaults to 10_000.
   */
  maxTrackedRows?: number;
}

function makeRowKey(op: Pick<SyncOperation, 'table' | 'row_id'>): string {
  return `${op.table}\u001f${op.row_id}`;
}

function touchLru(
  map: Map<string, number>,
  key: string,
  value: number,
  max: number
): void {
  // Maintain insertion order as an LRU.
  map.delete(key);
  map.set(key, value);
  if (map.size <= max) return;
  const firstKey = map.keys().next().value as string | undefined;
  if (firstKey) map.delete(firstKey);
}

/**
 * Automatically advances `base_version` for sequential operations on the same row.
 *
 * Why this exists:
 * - UI code often reads a row once and can enqueue multiple updates quickly.
 * - The server rejects stale `base_version` values (optimistic concurrency).
 * - When those updates all originate from the same client and are pushed in-order,
 *   later ops are effectively based on the earlier ops.
 *
 * Assumptions:
 * - The server's row version is an integer that increments by 1 per applied upsert.
 * - Operations are pushed in commit order for a given client (outbox ordering).
 *
 * This plugin:
 * - Tracks the "next expected server version" per (table, row_id) based on
 *   successfully applied pushes.
 * - Rewrites outgoing `base_version` to that expected version when it is higher
 *   than the caller-provided value, preventing "self-conflicts" on hot rows.
 */
export function createIncrementingVersionPlugin(
  options: IncrementingVersionPluginOptions = {}
): SyncClientPlugin {
  const name = options.name ?? INCREMENTING_VERSION_PLUGIN_KIND;
  const maxTrackedRows = Math.max(
    1,
    Math.min(1_000_000, options.maxTrackedRows ?? 10_000)
  );
  const nextExpectedBaseVersionByRow = new Map<string, number>();

  return {
    kind: INCREMENTING_VERSION_PLUGIN_KIND,
    name,

    beforePush(
      _ctx: SyncClientPluginContext,
      request: SyncPushRequest
    ): SyncPushRequest {
      const nextExpectedBaseVersionByRowForRequest = new Map<string, number>();
      const operations = request.operations.map((op) => {
        const key = makeRowKey(op);
        const nextExpected =
          nextExpectedBaseVersionByRowForRequest.get(key) ??
          nextExpectedBaseVersionByRow.get(key);

        const baseVersion =
          typeof op.base_version === 'number' &&
          typeof nextExpected === 'number' &&
          nextExpected > op.base_version
            ? nextExpected
            : op.base_version;

        const rewrittenOperation =
          baseVersion === op.base_version
            ? op
            : { ...op, base_version: baseVersion };

        if (op.op === 'delete') {
          nextExpectedBaseVersionByRowForRequest.delete(key);
          return rewrittenOperation;
        }

        if (typeof baseVersion === 'number') {
          touchLru(
            nextExpectedBaseVersionByRowForRequest,
            key,
            baseVersion + 1,
            maxTrackedRows
          );
          return rewrittenOperation;
        }

        touchLru(
          nextExpectedBaseVersionByRowForRequest,
          key,
          1,
          maxTrackedRows
        );
        return rewrittenOperation;
      });

      return { ...request, operations };
    },

    afterPush(
      _ctx: SyncClientPluginContext,
      args: { request: SyncPushRequest; response: SyncPushResponse }
    ): SyncPushResponse {
      // Rejected commits are rolled back by the server; nothing is applied.
      if (
        args.response.status !== 'applied' &&
        args.response.status !== 'cached'
      ) {
        return args.response;
      }

      for (const result of args.response.results ?? []) {
        if (result.status !== 'applied') continue;

        const op = args.request.operations[result.opIndex];
        if (!op) continue;

        const key = makeRowKey(op);

        if (op.op === 'delete') {
          nextExpectedBaseVersionByRow.delete(key);
          continue;
        }

        if (typeof op.base_version === 'number') {
          touchLru(
            nextExpectedBaseVersionByRow,
            key,
            op.base_version + 1,
            maxTrackedRows
          );
        } else {
          // Insert case: most tables start at version 1.
          touchLru(nextExpectedBaseVersionByRow, key, 1, maxTrackedRows);
        }
      }

      return args.response;
    },
  };
}
