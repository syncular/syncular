import { createHash, randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import { gzip, gzipSync } from 'node:zlib';
import type {
  ScopeValues,
  SyncBootstrapState,
  SyncChange,
  SyncCommit,
  SyncPullRequest,
  SyncPullResponse,
  SyncPullSubscriptionResponse,
  SyncSnapshot,
} from '@syncular/core';
import type { Kysely } from 'kysely';
import type { ServerSyncDialect } from './dialect/types';
import type { SyncCoreDb } from './schema';
import type { TableRegistry } from './shapes/registry';
import {
  insertSnapshotChunk,
  readSnapshotChunkRefByPageKey,
} from './snapshot-chunks';
import type { SnapshotChunkStorage } from './snapshot-chunks/types';
import { resolveEffectiveScopesForSubscriptions } from './subscriptions/resolve';

const gzipAsync = promisify(gzip);
const ASYNC_GZIP_MIN_BYTES = 64 * 1024;

async function compressSnapshotNdjson(ndjson: string): Promise<Uint8Array> {
  if (Buffer.byteLength(ndjson) < ASYNC_GZIP_MIN_BYTES) {
    return new Uint8Array(gzipSync(ndjson));
  }
  const compressed = await gzipAsync(ndjson);
  return new Uint8Array(compressed);
}

export interface PullResult {
  response: SyncPullResponse;
  /**
   * Effective scopes for all active subscriptions (for cursor tracking).
   * Maps subscription ID to effective scopes.
   */
  effectiveScopes: ScopeValues;
  /** Minimum nextCursor across active subscriptions (for pruning cursor tracking). */
  clientCursor: number;
}

/**
 * Generate a stable cache key for snapshot chunks.
 */
function scopesToCacheKey(scopes: ScopeValues): string {
  const sorted = Object.entries(scopes)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => {
      const arr = Array.isArray(v) ? [...v].sort() : [v];
      return `${k}:${arr.join(',')}`;
    })
    .join('|');
  return createHash('sha256').update(sorted).digest('hex');
}

/**
 * Sanitize a numeric limit parameter with bounds checking.
 * Handles NaN, negative values, and undefined.
 */
function sanitizeLimit(
  value: number | undefined,
  defaultValue: number,
  min: number,
  max: number
): number {
  if (value === undefined || value === null) return defaultValue;
  if (Number.isNaN(value)) return defaultValue;
  return Math.max(min, Math.min(max, value));
}

/**
 * Merge all scope values into a flat ScopeValues for cursor tracking.
 */
function mergeScopes(subscriptions: { scopes: ScopeValues }[]): ScopeValues {
  const result: Record<string, Set<string>> = {};

  for (const sub of subscriptions) {
    for (const [key, value] of Object.entries(sub.scopes)) {
      if (!result[key]) result[key] = new Set();
      const arr = Array.isArray(value) ? value : [value];
      for (const v of arr) result[key].add(v);
    }
  }

  const merged: ScopeValues = {};
  for (const [key, set] of Object.entries(result)) {
    const arr = Array.from(set);
    if (arr.length === 0) continue;
    merged[key] = arr.length === 1 ? arr[0]! : arr;
  }
  return merged;
}

export async function pull<DB extends SyncCoreDb>(args: {
  db: Kysely<DB>;
  dialect: ServerSyncDialect;
  shapes: TableRegistry<DB>;
  actorId: string;
  request: SyncPullRequest;
  /**
   * Optional snapshot chunk storage adapter.
   * When provided, stores chunk bodies in external storage (S3, etc.)
   * instead of inline in the database.
   */
  chunkStorage?: SnapshotChunkStorage;
}): Promise<PullResult> {
  const { request, dialect } = args;
  const db = args.db;

  // Validate and sanitize request limits
  const limitCommits = sanitizeLimit(request.limitCommits, 50, 1, 500);
  const limitSnapshotRows = sanitizeLimit(
    request.limitSnapshotRows,
    1000,
    1,
    5000
  );
  const maxSnapshotPages = sanitizeLimit(request.maxSnapshotPages, 1, 1, 50);
  const dedupeRows = request.dedupeRows === true;

  // Resolve effective scopes for each subscription
  const resolved = await resolveEffectiveScopesForSubscriptions({
    db,
    actorId: args.actorId,
    subscriptions: request.subscriptions ?? [],
    shapes: args.shapes,
  });

  return dialect.executeInTransaction(db, async (trx) => {
    await dialect.setRepeatableRead(trx);

    const maxCommitSeq = await dialect.readMaxCommitSeq(trx);
    const minCommitSeq = await dialect.readMinCommitSeq(trx);

    const subResponses: SyncPullSubscriptionResponse[] = [];
    const activeSubscriptions: { scopes: ScopeValues }[] = [];
    const nextCursors: number[] = [];

    for (const sub of resolved) {
      const cursor = Math.max(-1, sub.cursor ?? -1);
      // Validate shape exists (throws if not registered)
      args.shapes.getOrThrow(sub.shape);

      if (sub.status === 'revoked' || Object.keys(sub.scopes).length === 0) {
        subResponses.push({
          id: sub.id,
          status: 'revoked',
          scopes: {},
          bootstrap: false,
          nextCursor: cursor,
          commits: [],
        });
        continue;
      }

      const effectiveScopes = sub.scopes;
      activeSubscriptions.push({ scopes: effectiveScopes });

      const needsBootstrap =
        sub.bootstrapState != null ||
        cursor < 0 ||
        cursor > maxCommitSeq ||
        (minCommitSeq > 0 && cursor < minCommitSeq - 1);

      if (needsBootstrap) {
        const tables = args.shapes
          .getBootstrapOrderFor(sub.shape)
          .map((handler) => handler.table);

        const initState: SyncBootstrapState = {
          asOfCommitSeq: maxCommitSeq,
          tables,
          tableIndex: 0,
          rowCursor: null,
        };

        const requestedState = sub.bootstrapState ?? null;
        const state =
          requestedState &&
          typeof requestedState.asOfCommitSeq === 'number' &&
          Array.isArray(requestedState.tables) &&
          typeof requestedState.tableIndex === 'number'
            ? (requestedState as SyncBootstrapState)
            : initState;

        // If the bootstrap state's asOfCommitSeq is no longer catch-up-able, restart bootstrap.
        const effectiveState =
          state.asOfCommitSeq < minCommitSeq - 1 ? initState : state;

        const tableName = effectiveState.tables[effectiveState.tableIndex];

        // No tables (or ran past the end): treat bootstrap as complete.
        if (!tableName) {
          subResponses.push({
            id: sub.id,
            status: 'active',
            scopes: effectiveScopes,
            bootstrap: true,
            bootstrapState: null,
            nextCursor: effectiveState.asOfCommitSeq,
            commits: [],
            snapshots: [],
          });
          nextCursors.push(effectiveState.asOfCommitSeq);
          continue;
        }

        const snapshots: SyncSnapshot[] = [];
        let nextState: SyncBootstrapState | null = effectiveState;

        for (let pageIndex = 0; pageIndex < maxSnapshotPages; pageIndex++) {
          if (!nextState) break;

          const nextTableName = nextState.tables[nextState.tableIndex];
          if (!nextTableName) {
            nextState = null;
            break;
          }

          const tableHandler = args.shapes.getOrThrow(nextTableName);
          const isFirstPage = nextState.rowCursor == null;

          const page = await tableHandler.snapshot(
            {
              db: trx,
              actorId: args.actorId,
              scopeValues: effectiveScopes,
              cursor: nextState.rowCursor,
              limit: limitSnapshotRows,
            },
            sub.params
          );

          const isLastPage = page.nextCursor == null;

          // Always use NDJSON+gzip for bootstrap snapshots
          const ttlMs = tableHandler.snapshotChunkTtlMs ?? 24 * 60 * 60 * 1000; // 24h
          const nowIso = new Date().toISOString();

          // Use scope hash for caching
          const cacheKey = scopesToCacheKey(effectiveScopes);
          const cached = await readSnapshotChunkRefByPageKey(trx, {
            scopeKey: cacheKey,
            scope: nextTableName,
            asOfCommitSeq: effectiveState.asOfCommitSeq,
            rowCursor: nextState.rowCursor,
            rowLimit: limitSnapshotRows,
            encoding: 'ndjson',
            compression: 'gzip',
            nowIso,
          });

          let chunkRef = cached;

          if (!chunkRef) {
            const lines: string[] = [];
            for (const r of page.rows ?? []) {
              const s = JSON.stringify(r);
              lines.push(s === undefined ? 'null' : s);
            }
            const ndjson = lines.length > 0 ? `${lines.join('\n')}\n` : '';
            const gz = await compressSnapshotNdjson(ndjson);
            const sha256 = createHash('sha256').update(ndjson).digest('hex');
            const expiresAt = new Date(
              Date.now() + Math.max(1000, ttlMs)
            ).toISOString();

            // Use external chunk storage if available, otherwise fall back to inline
            if (args.chunkStorage) {
              chunkRef = await args.chunkStorage.storeChunk({
                scopeKey: cacheKey,
                scope: nextTableName,
                asOfCommitSeq: effectiveState.asOfCommitSeq,
                rowCursor: nextState.rowCursor ?? null,
                rowLimit: limitSnapshotRows,
                encoding: 'ndjson',
                compression: 'gzip',
                sha256,
                body: gz,
                expiresAt,
              });
            } else {
              const chunkId = randomUUID();
              chunkRef = await insertSnapshotChunk(trx, {
                chunkId,
                scopeKey: cacheKey,
                scope: nextTableName,
                asOfCommitSeq: effectiveState.asOfCommitSeq,
                rowCursor: nextState.rowCursor,
                rowLimit: limitSnapshotRows,
                encoding: 'ndjson',
                compression: 'gzip',
                sha256,
                body: gz,
                expiresAt,
              });
            }
          }

          snapshots.push({
            table: nextTableName,
            rows: [],
            chunks: [chunkRef],
            isFirstPage,
            isLastPage,
          });

          if (page.nextCursor != null) {
            nextState = { ...nextState, rowCursor: page.nextCursor };
            continue;
          }

          if (nextState.tableIndex + 1 < nextState.tables.length) {
            nextState = {
              ...nextState,
              tableIndex: nextState.tableIndex + 1,
              rowCursor: null,
            };
            continue;
          }

          nextState = null;
          break;
        }

        subResponses.push({
          id: sub.id,
          status: 'active',
          scopes: effectiveScopes,
          bootstrap: true,
          bootstrapState: nextState,
          nextCursor: effectiveState.asOfCommitSeq,
          commits: [],
          snapshots,
        });
        nextCursors.push(effectiveState.asOfCommitSeq);
        continue;
      }

      // Incremental pull for this subscription
      // Use streaming when available to reduce memory pressure for large pulls
      const pullRowStream = dialect.streamIncrementalPullRows
        ? dialect.streamIncrementalPullRows(trx, {
            table: sub.shape,
            scopes: effectiveScopes,
            cursor,
            limitCommits,
          })
        : null;

      // Collect rows and compute nextCursor in a single pass
      const incrementalRows: Array<{
        commit_seq: number;
        actor_id: string;
        created_at: string;
        change_id: number;
        table: string;
        row_id: string;
        op: 'upsert' | 'delete';
        row_json: unknown | null;
        row_version: number | null;
        scopes: Record<string, string | string[]>;
      }> = [];

      let nextCursor = cursor;

      if (pullRowStream) {
        // Streaming path: process rows as they arrive
        for await (const row of pullRowStream) {
          incrementalRows.push(row);
          nextCursor = Math.max(nextCursor, row.commit_seq);
        }
      } else {
        // Non-streaming fallback: load all rows at once
        const rows = await dialect.readIncrementalPullRows(trx, {
          table: sub.shape,
          scopes: effectiveScopes,
          cursor,
          limitCommits,
        });
        incrementalRows.push(...rows);
        for (const r of incrementalRows) {
          nextCursor = Math.max(nextCursor, r.commit_seq);
        }
      }

      if (incrementalRows.length === 0) {
        subResponses.push({
          id: sub.id,
          status: 'active',
          scopes: effectiveScopes,
          bootstrap: false,
          nextCursor: cursor,
          commits: [],
        });
        nextCursors.push(cursor);
        continue;
      }

      if (dedupeRows) {
        const latestByRowKey = new Map<
          string,
          {
            commitSeq: number;
            createdAt: string;
            actorId: string;
            changeId: number;
            change: SyncChange;
          }
        >();

        for (const r of incrementalRows) {
          const rowKey = `${r.table}\u0000${r.row_id}`;
          const change: SyncChange = {
            table: r.table,
            row_id: r.row_id,
            op: r.op,
            row_json: r.row_json,
            row_version: r.row_version,
            scopes: dialect.dbToScopes(r.scopes),
          };

          latestByRowKey.set(rowKey, {
            commitSeq: r.commit_seq,
            createdAt: r.created_at,
            actorId: r.actor_id,
            changeId: r.change_id,
            change,
          });
        }

        const latest = Array.from(latestByRowKey.values()).sort(
          (a, b) => a.commitSeq - b.commitSeq || a.changeId - b.changeId
        );

        const commitsBySeq = new Map<number, SyncCommit>();
        for (const item of latest) {
          let commit = commitsBySeq.get(item.commitSeq);
          if (!commit) {
            commit = {
              commitSeq: item.commitSeq,
              createdAt: item.createdAt,
              actorId: item.actorId,
              changes: [],
            };
            commitsBySeq.set(item.commitSeq, commit);
          }
          commit.changes.push(item.change);
        }

        const commits = Array.from(commitsBySeq.values()).sort(
          (a, b) => a.commitSeq - b.commitSeq
        );

        subResponses.push({
          id: sub.id,
          status: 'active',
          scopes: effectiveScopes,
          bootstrap: false,
          nextCursor,
          commits,
        });
        nextCursors.push(nextCursor);
        continue;
      }

      const commitsBySeq = new Map<number, SyncCommit>();
      const commitSeqs: number[] = [];

      for (const r of incrementalRows) {
        const seq = r.commit_seq;
        let commit = commitsBySeq.get(seq);
        if (!commit) {
          commit = {
            commitSeq: seq,
            createdAt: r.created_at,
            actorId: r.actor_id,
            changes: [],
          };
          commitsBySeq.set(seq, commit);
          commitSeqs.push(seq);
        }

        const change: SyncChange = {
          table: r.table,
          row_id: r.row_id,
          op: r.op,
          row_json: r.row_json,
          row_version: r.row_version,
          scopes: dialect.dbToScopes(r.scopes),
        };
        commit.changes.push(change);
      }

      const commits: SyncCommit[] = commitSeqs
        .map((seq) => commitsBySeq.get(seq))
        .filter((c): c is SyncCommit => !!c)
        .filter((c) => c.changes.length > 0);

      subResponses.push({
        id: sub.id,
        status: 'active',
        scopes: effectiveScopes,
        bootstrap: false,
        nextCursor,
        commits,
      });
      nextCursors.push(nextCursor);
    }

    const effectiveScopes = mergeScopes(activeSubscriptions);
    const clientCursor =
      nextCursors.length > 0 ? Math.min(...nextCursors) : maxCommitSeq;

    return {
      response: {
        ok: true as const,
        subscriptions: subResponses,
      },
      effectiveScopes,
      clientCursor,
    };
  });
}
