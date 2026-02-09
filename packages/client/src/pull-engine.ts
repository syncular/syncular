/**
 * @syncular/client - Sync pull engine
 */

import type {
  SyncBootstrapState,
  SyncPullRequest,
  SyncPullResponse,
  SyncSubscriptionRequest,
  SyncTransport,
} from '@syncular/core';
import { type Kysely, sql } from 'kysely';
import type { ClientTableRegistry } from './handlers/registry';
import type {
  SyncClientPlugin,
  SyncClientPluginContext,
} from './plugins/types';
import type { SyncClientDb, SyncSubscriptionStateTable } from './schema';

// Simple JSON serialization cache to avoid repeated stringification
// of the same objects during pull operations
const jsonCache = new WeakMap<object, string>();
const jsonCacheStats = { hits: 0, misses: 0 };
const SNAPSHOT_CHUNK_CONCURRENCY = 8;

function serializeJsonCached(obj: object): string {
  if (obj === null || typeof obj !== 'object') {
    return JSON.stringify(obj);
  }
  const cached = jsonCache.get(obj);
  if (cached !== undefined) {
    jsonCacheStats.hits++;
    return cached;
  }
  jsonCacheStats.misses++;
  const serialized = JSON.stringify(obj);
  // Only cache objects that are likely to be reused (not one-off empty objects)
  if (Object.keys(obj).length > 0) {
    jsonCache.set(obj, serialized);
  }
  return serialized;
}

function isGzipBytes(bytes: Uint8Array): boolean {
  return bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b;
}

async function maybeGunzip(bytes: Uint8Array): Promise<Uint8Array> {
  if (!isGzipBytes(bytes)) return bytes;

  // Prefer Web Streams decompression when available (browser/modern runtimes).
  if (typeof DecompressionStream !== 'undefined') {
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array(bytes));
        controller.close();
      },
    });

    const decompressed = stream.pipeThrough(
      new DecompressionStream('gzip')
    ) as ReadableStream<Uint8Array>;
    const reader = decompressed.getReader();

    try {
      const chunks: Uint8Array[] = [];
      let total = 0;
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        if (!value) continue;
        chunks.push(value);
        total += value.length;
      }

      const out = new Uint8Array(total);
      let offset = 0;
      for (const chunk of chunks) {
        out.set(chunk, offset);
        offset += chunk.length;
      }
      return out;
    } finally {
      reader.releaseLock();
    }
  }

  // If the runtime didn't auto-decompress `Content-Encoding: gzip`, and doesn't
  // support DecompressionStream, we can't safely decode the chunk.
  throw new Error(
    'Snapshot chunk appears gzip-compressed but gzip decompression is not available in this runtime'
  );
}

function parseNdjsonRows(text: string): unknown[] {
  const rows: unknown[] = [];
  for (const line of text.split('\n')) {
    if (!line) continue;
    rows.push(JSON.parse(line));
  }
  return rows;
}

async function computeSha256Hex(bytes: Uint8Array): Promise<string> {
  // Use crypto.subtle if available (browsers, modern Node/Bun)
  if (typeof crypto !== 'undefined' && crypto.subtle) {
    // Create a fresh ArrayBuffer to satisfy crypto.subtle's type requirements
    const buffer = new ArrayBuffer(bytes.length);
    new Uint8Array(buffer).set(bytes);
    const hashBuffer = await crypto.subtle.digest('SHA-256', buffer);
    const hashArray = new Uint8Array(hashBuffer);
    return Array.from(hashArray, (b) => b.toString(16).padStart(2, '0')).join(
      ''
    );
  }

  // Fallback for Node.js/Bun without crypto.subtle
  if (typeof globalThis.require === 'function') {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { createHash } = await import('node:crypto');
    return createHash('sha256').update(Buffer.from(bytes)).digest('hex');
  }

  throw new Error(
    'No crypto implementation available for SHA-256. ' +
      'Ensure crypto.subtle is available or running in Node.js/Bun.'
  );
}

async function mapWithConcurrency<T, U>(
  items: readonly T[],
  concurrency: number,
  mapper: (item: T, index: number) => Promise<U>
): Promise<U[]> {
  if (items.length === 0) return [];

  const workerCount = Math.max(1, Math.min(concurrency, items.length));
  const results = new Array<U>(items.length);
  let nextIndex = 0;

  async function worker(): Promise<void> {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      const item = items[index];
      if (item === undefined) continue;
      results[index] = await mapper(item, index);
    }
  }

  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
}

async function materializeChunkedSnapshots(
  transport: SyncTransport,
  response: SyncPullResponse
): Promise<SyncPullResponse> {
  const chunkCache = new Map<string, Promise<Uint8Array>>();
  const decoder = new TextDecoder();

  const subscriptions = await Promise.all(
    response.subscriptions.map(async (sub) => {
      if (!sub.bootstrap) return sub;
      if (!sub.snapshots || sub.snapshots.length === 0) return sub;

      const snapshots = await mapWithConcurrency(
        sub.snapshots,
        SNAPSHOT_CHUNK_CONCURRENCY,
        async (snapshot) => {
          const chunks = snapshot.chunks ?? [];
          if (chunks.length === 0) {
            return snapshot;
          }

          const parsedRowsByChunk = await mapWithConcurrency(
            chunks,
            SNAPSHOT_CHUNK_CONCURRENCY,
            async (chunk) => {
              const promise =
                chunkCache.get(chunk.id) ??
                transport.fetchSnapshotChunk({ chunkId: chunk.id });
              chunkCache.set(chunk.id, promise);

              const raw = await promise;
              const bytes = await maybeGunzip(raw);

              // Verify chunk integrity using sha256 hash
              if (chunk.sha256) {
                const actualHash = await computeSha256Hex(bytes);
                if (actualHash !== chunk.sha256) {
                  throw new Error(
                    `Snapshot chunk integrity check failed: expected sha256 ${chunk.sha256}, got ${actualHash}`
                  );
                }
              }

              const text = decoder.decode(bytes);
              return parseNdjsonRows(text);
            }
          );

          const rows: unknown[] = [];
          for (const parsedRows of parsedRowsByChunk) {
            rows.push(...parsedRows);
          }

          return { ...snapshot, rows, chunks: undefined };
        }
      );

      return { ...sub, snapshots };
    })
  );

  // Clear chunk cache after processing to prevent memory accumulation
  chunkCache.clear();

  return { ...response, subscriptions };
}

function parseBootstrapState(
  value: string | object | null | undefined
): SyncBootstrapState | null {
  if (!value) return null;
  try {
    // Handle both string (raw JSON) and object (already deserialized by SerializePlugin)
    const parsed: SyncBootstrapState =
      typeof value === 'string'
        ? (JSON.parse(value) as SyncBootstrapState)
        : (value as SyncBootstrapState);
    if (!parsed || typeof parsed !== 'object') return null;
    if (typeof parsed.asOfCommitSeq !== 'number') return null;
    if (!Array.isArray(parsed.tables)) return null;
    if (typeof parsed.tableIndex !== 'number') return null;
    if (parsed.rowCursor !== null && typeof parsed.rowCursor !== 'string')
      return null;
    return parsed;
  } catch {
    return null;
  }
}

export interface SyncPullOnceOptions {
  clientId: string;
  actorId?: string;
  plugins?: SyncClientPlugin[];
  /**
   * Desired subscriptions (client-chosen ids).
   * Cursors are persisted in `sync_subscription_state`.
   */
  subscriptions: Array<Omit<SyncSubscriptionRequest, 'cursor'>>;
  limitCommits?: number;
  limitSnapshotRows?: number;
  maxSnapshotPages?: number;
  dedupeRows?: boolean;
  stateId?: string;
}

export async function syncPullOnce<DB extends SyncClientDb>(
  db: Kysely<DB>,
  transport: SyncTransport,
  shapes: ClientTableRegistry<DB>,
  options: SyncPullOnceOptions
): Promise<SyncPullResponse> {
  const stateId = options.stateId ?? 'default';

  const existingResult = await sql<SyncSubscriptionStateTable>`
    select
      ${sql.ref('state_id')},
      ${sql.ref('subscription_id')},
      ${sql.ref('shape')},
      ${sql.ref('scopes_json')},
      ${sql.ref('params_json')},
      ${sql.ref('cursor')},
      ${sql.ref('bootstrap_state_json')},
      ${sql.ref('status')},
      ${sql.ref('created_at')},
      ${sql.ref('updated_at')}
    from ${sql.table('sync_subscription_state')}
    where ${sql.ref('state_id')} = ${sql.val(stateId)}
  `.execute(db);
  const existing = existingResult.rows;

  const existingById = new Map<string, SyncSubscriptionStateTable>();
  for (const row of existing) existingById.set(row.subscription_id, row);

  const request: SyncPullRequest = {
    clientId: options.clientId,
    limitCommits: options.limitCommits ?? 50,
    limitSnapshotRows: options.limitSnapshotRows ?? 1000,
    maxSnapshotPages: options.maxSnapshotPages,
    dedupeRows: options.dedupeRows,
    subscriptions: (options.subscriptions ?? []).map((sub) => ({
      ...sub,
      cursor: Math.max(-1, existingById.get(sub.id)?.cursor ?? -1),
      bootstrapState: parseBootstrapState(
        existingById.get(sub.id)?.bootstrap_state_json
      ),
    })),
  };

  const res = await transport.pull(request);
  const hydrated = await materializeChunkedSnapshots(transport, res);

  const ctx: SyncClientPluginContext = {
    actorId: options.actorId ?? 'unknown',
    clientId: options.clientId,
  };
  const plugins = options.plugins ?? [];

  let responseToApply = hydrated;
  for (const plugin of plugins) {
    if (!plugin.afterPull) continue;
    responseToApply = await plugin.afterPull(ctx, {
      request,
      response: responseToApply,
    });
  }

  await db.transaction().execute(async (trx) => {
    const desiredIds = new Set((options.subscriptions ?? []).map((s) => s.id));

    // Remove local data for subscriptions that are no longer desired.
    for (const row of existing) {
      if (desiredIds.has(row.subscription_id)) continue;

      // Clear data for this shape matching the subscription's scopes
      if (row.shape) {
        try {
          const scopes = row.scopes_json
            ? typeof row.scopes_json === 'string'
              ? JSON.parse(row.scopes_json)
              : row.scopes_json
            : {};
          await shapes.getOrThrow(row.shape).clearAll({ trx, scopes });
        } catch {
          // ignore missing shape handler
        }
      }

      await sql`
	        delete from ${sql.table('sync_subscription_state')}
	        where ${sql.ref('state_id')} = ${sql.val(stateId)}
	          and ${sql.ref('subscription_id')} = ${sql.val(row.subscription_id)}
	      `.execute(trx);
    }

    const subsById = new Map<string, (typeof options.subscriptions)[number]>();
    for (const s of options.subscriptions ?? []) subsById.set(s.id, s);

    for (const sub of responseToApply.subscriptions) {
      const def = subsById.get(sub.id);
      const prev = existingById.get(sub.id);

      // Revoked: clear data and drop the subscription row.
      if (sub.status === 'revoked') {
        if (prev?.shape) {
          try {
            const scopes = prev.scopes_json
              ? typeof prev.scopes_json === 'string'
                ? JSON.parse(prev.scopes_json)
                : prev.scopes_json
              : {};
            await shapes.getOrThrow(prev.shape).clearAll({ trx, scopes });
          } catch {
            // ignore missing handler
          }
        }

        await sql`
	          delete from ${sql.table('sync_subscription_state')}
	          where ${sql.ref('state_id')} = ${sql.val(stateId)}
	            and ${sql.ref('subscription_id')} = ${sql.val(sub.id)}
	        `.execute(trx);
        continue;
      }

      // Apply snapshots (bootstrap mode)
      if (sub.bootstrap) {
        for (const snapshot of sub.snapshots ?? []) {
          const handler = shapes.getOrThrow(snapshot.table);

          // Call onSnapshotStart hook when starting a new snapshot
          if (snapshot.isFirstPage && handler.onSnapshotStart) {
            await handler.onSnapshotStart({
              trx,
              table: snapshot.table,
              scopes: sub.scopes,
            });
          }

          await handler.applySnapshot({ trx }, snapshot);

          // Call onSnapshotEnd hook when snapshot is complete
          if (snapshot.isLastPage && handler.onSnapshotEnd) {
            await handler.onSnapshotEnd({
              trx,
              table: snapshot.table,
              scopes: sub.scopes,
            });
          }
        }
      } else {
        // Apply incremental changes
        for (const commit of sub.commits) {
          for (const change of commit.changes) {
            const handler = shapes.getOrThrow(change.table);
            await handler.applyChange({ trx }, change);
          }
        }
      }

      // Persist subscription cursor + metadata.
      // Use cached JSON serialization to avoid repeated stringification
      const now = Date.now();
      const paramsJson = serializeJsonCached(def?.params ?? {});
      const scopesJson = serializeJsonCached(def?.scopes ?? {});
      const bootstrapStateJson = sub.bootstrap
        ? sub.bootstrapState
          ? serializeJsonCached(sub.bootstrapState)
          : null
        : null;

      const shape = def?.shape ?? 'unknown';
      await sql`
	        insert into ${sql.table('sync_subscription_state')} (
	          ${sql.join([
              sql.ref('state_id'),
              sql.ref('subscription_id'),
              sql.ref('shape'),
              sql.ref('scopes_json'),
              sql.ref('params_json'),
              sql.ref('cursor'),
              sql.ref('bootstrap_state_json'),
              sql.ref('status'),
              sql.ref('created_at'),
              sql.ref('updated_at'),
            ])}
	        ) values (
	          ${sql.join([
              sql.val(stateId),
              sql.val(sub.id),
              sql.val(shape),
              sql.val(scopesJson),
              sql.val(paramsJson),
              sql.val(sub.nextCursor),
              sql.val(bootstrapStateJson),
              sql.val('active'),
              sql.val(now),
              sql.val(now),
            ])}
	        )
	        on conflict (${sql.join([sql.ref('state_id'), sql.ref('subscription_id')])})
	        do update set
	          ${sql.ref('shape')} = ${sql.val(shape)},
	          ${sql.ref('scopes_json')} = ${sql.val(scopesJson)},
	          ${sql.ref('params_json')} = ${sql.val(paramsJson)},
	          ${sql.ref('cursor')} = ${sql.val(sub.nextCursor)},
	          ${sql.ref('bootstrap_state_json')} = ${sql.val(bootstrapStateJson)},
	          ${sql.ref('status')} = ${sql.val('active')},
	          ${sql.ref('updated_at')} = ${sql.val(now)}
	      `.execute(trx);
    }
  });

  return responseToApply;
}
