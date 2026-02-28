/**
 * @syncular/client - Sync pull engine
 */

import type {
  SyncBootstrapState,
  SyncPullRequest,
  SyncPullResponse,
  SyncPullSubscriptionResponse,
  SyncSnapshot,
  SyncSubscriptionRequest,
  SyncTransport,
} from '@syncular/core';
import { decodeSnapshotRows } from '@syncular/core';
import { type Kysely, sql, type Transaction } from 'kysely';
import {
  type ClientHandlerCollection,
  getClientHandlerOrThrow,
} from './handlers/collection';
import type { ClientTableHandler } from './handlers/types';
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
const SNAPSHOT_APPLY_BATCH_ROWS = 500;
const SNAPSHOT_ROW_FRAME_MAGIC = new Uint8Array([0x53, 0x52, 0x46, 0x31]); // "SRF1"
const FRAME_LENGTH_BYTES = 4;

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

function bytesToReadableStream(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

function concatBytes(chunks: readonly Uint8Array[]): Uint8Array {
  if (chunks.length === 1) {
    return chunks[0] ?? new Uint8Array();
  }
  let total = 0;
  for (const chunk of chunks) total += chunk.length;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

function appendBytes(base: Uint8Array, next: Uint8Array): Uint8Array {
  if (base.length === 0) return next;
  if (next.length === 0) return base;
  const out = new Uint8Array(base.length + next.length);
  out.set(base, 0);
  out.set(next, base.length);
  return out;
}

function toOwnedUint8Array(chunk: Uint8Array): Uint8Array<ArrayBuffer> {
  const out = new ArrayBuffer(chunk.byteLength);
  const bytes = new Uint8Array(out);
  bytes.set(chunk);
  return bytes;
}

async function streamToBytes(
  stream: ReadableStream<Uint8Array>
): Promise<Uint8Array> {
  const reader = stream.getReader();
  try {
    const chunks: Uint8Array[] = [];
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value || value.length === 0) continue;
      chunks.push(value);
    }
    return concatBytes(chunks);
  } finally {
    reader.releaseLock();
  }
}

async function maybeGunzipStream(
  stream: ReadableStream<Uint8Array>
): Promise<ReadableStream<Uint8Array>> {
  const reader = stream.getReader();
  const prefetched: Uint8Array[] = [];
  let prefetchedBytes = 0;

  while (prefetchedBytes < 2) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value || value.length === 0) continue;
    prefetched.push(value);
    prefetchedBytes += value.length;
  }

  const prefetchedCombined = concatBytes(prefetched);
  const gzip = isGzipBytes(prefetchedCombined);

  const replayStream = new ReadableStream<Uint8Array<ArrayBuffer>>({
    start(controller) {
      if (prefetchedCombined.length > 0) {
        controller.enqueue(toOwnedUint8Array(prefetchedCombined));
      }
    },
    async pull(controller) {
      const { done, value } = await reader.read();
      if (done) {
        controller.close();
        reader.releaseLock();
        return;
      }
      if (!value || value.length === 0) return;
      controller.enqueue(toOwnedUint8Array(value));
    },
    async cancel(reason) {
      await reader.cancel(reason);
      reader.releaseLock();
    },
  });

  if (!gzip) return replayStream;

  if (typeof DecompressionStream !== 'undefined') {
    return replayStream.pipeThrough(new DecompressionStream('gzip'));
  }

  throw new Error(
    'Snapshot chunk appears gzip-compressed but gzip decompression is not available in this runtime'
  );
}

async function maybeGunzip(bytes: Uint8Array): Promise<Uint8Array> {
  if (!isGzipBytes(bytes)) return bytes;
  const decompressedStream = await maybeGunzipStream(
    bytesToReadableStream(bytes)
  );
  return streamToBytes(decompressedStream);
}

async function* decodeSnapshotRowStreamBatches(
  stream: ReadableStream<Uint8Array>,
  batchSize: number
): AsyncGenerator<unknown[]> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let pending: Uint8Array = new Uint8Array(0);
  let headerValidated = false;
  let rows: unknown[] = [];

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value || value.length === 0) continue;
      pending = appendBytes(pending, value);

      if (!headerValidated) {
        if (pending.length < SNAPSHOT_ROW_FRAME_MAGIC.length) {
          continue;
        }
        for (let index = 0; index < SNAPSHOT_ROW_FRAME_MAGIC.length; index++) {
          if (pending[index] !== SNAPSHOT_ROW_FRAME_MAGIC[index]) {
            throw new Error('Unexpected snapshot chunk format');
          }
        }
        pending = pending.subarray(SNAPSHOT_ROW_FRAME_MAGIC.length);
        headerValidated = true;
      }

      while (pending.length >= FRAME_LENGTH_BYTES) {
        const view = new DataView(
          pending.buffer,
          pending.byteOffset,
          pending.byteLength
        );
        const payloadLength = view.getUint32(0, false);
        if (pending.length < FRAME_LENGTH_BYTES + payloadLength) {
          break;
        }

        const payload = pending.subarray(
          FRAME_LENGTH_BYTES,
          FRAME_LENGTH_BYTES + payloadLength
        );
        rows.push(JSON.parse(decoder.decode(payload)));
        pending = pending.subarray(FRAME_LENGTH_BYTES + payloadLength);

        if (rows.length >= batchSize) {
          yield rows;
          rows = [];
        }
      }
    }

    if (!headerValidated) {
      throw new Error('Snapshot chunk payload is too small');
    }

    if (pending.length > 0) {
      if (pending.length < FRAME_LENGTH_BYTES) {
        throw new Error('Snapshot chunk payload ended mid-frame header');
      }
      const view = new DataView(
        pending.buffer,
        pending.byteOffset,
        pending.byteLength
      );
      const payloadLength = view.getUint32(0, false);
      if (pending.length < FRAME_LENGTH_BYTES + payloadLength) {
        throw new Error('Snapshot chunk payload ended mid-frame body');
      }
      while (pending.length >= FRAME_LENGTH_BYTES) {
        const nextView = new DataView(
          pending.buffer,
          pending.byteOffset,
          pending.byteLength
        );
        const nextLength = nextView.getUint32(0, false);
        if (pending.length < FRAME_LENGTH_BYTES + nextLength) {
          break;
        }
        const payload = pending.subarray(
          FRAME_LENGTH_BYTES,
          FRAME_LENGTH_BYTES + nextLength
        );
        rows.push(JSON.parse(decoder.decode(payload)));
        pending = pending.subarray(FRAME_LENGTH_BYTES + nextLength);
        if (rows.length >= batchSize) {
          yield rows;
          rows = [];
        }
      }
      if (pending.length > 0) {
        throw new Error('Snapshot chunk payload ended mid-frame body');
      }
    }

    if (rows.length > 0) {
      yield rows;
    }
  } finally {
    reader.releaseLock();
  }
}

async function computeSha256Hex(
  bytes: Uint8Array,
  sha256Override?: (bytes: Uint8Array) => Promise<string>
): Promise<string> {
  // Use injected implementation if provided (e.g. expo-crypto on React Native)
  if (sha256Override) {
    return sha256Override(bytes);
  }

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

  throw new Error(
    'No crypto implementation available for SHA-256. ' +
      'Provide a sha256 function via options or ensure crypto.subtle is available.'
  );
}

async function fetchSnapshotChunkStream(
  transport: SyncTransport,
  chunkId: string
): Promise<ReadableStream<Uint8Array>> {
  if (transport.fetchSnapshotChunkStream) {
    return transport.fetchSnapshotChunkStream({ chunkId });
  }
  const bytes = await transport.fetchSnapshotChunk({ chunkId });
  return bytesToReadableStream(bytes);
}

async function readAllBytesFromStream(
  stream: ReadableStream<Uint8Array>
): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let totalLength = 0;

  try {
    while (true) {
      // eslint-disable-next-line no-await-in-loop
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      chunks.push(value);
      totalLength += value.byteLength;
    }
  } finally {
    reader.releaseLock();
  }

  if (chunks.length === 0) {
    return new Uint8Array();
  }
  if (chunks.length === 1) {
    return chunks[0]!;
  }

  const bytes = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
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
  response: SyncPullResponse,
  sha256Override?: (bytes: Uint8Array) => Promise<string>
): Promise<SyncPullResponse> {
  const chunkCache = new Map<string, Promise<Uint8Array>>();

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
                const actualHash = await computeSha256Hex(
                  bytes,
                  sha256Override
                );
                if (actualHash !== chunk.sha256) {
                  throw new Error(
                    `Snapshot chunk integrity check failed: expected sha256 ${chunk.sha256}, got ${actualHash}`
                  );
                }
              }

              return decodeSnapshotRows(bytes);
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

async function applyChunkedSnapshot<DB extends SyncClientDb>(
  transport: SyncTransport,
  handler: Pick<ClientTableHandler<DB>, 'applySnapshot'>,
  trx: Transaction<DB>,
  snapshot: SyncSnapshot,
  sha256Override?: (bytes: Uint8Array) => Promise<string>
): Promise<void> {
  const chunks = snapshot.chunks ?? [];
  if (chunks.length === 0) {
    await handler.applySnapshot({ trx }, snapshot);
    return;
  }

  let nextIsFirstPage = snapshot.isFirstPage;

  for (let chunkIndex = 0; chunkIndex < chunks.length; chunkIndex += 1) {
    const chunk = chunks[chunkIndex];
    if (!chunk) continue;

    const rawStream = await fetchSnapshotChunkStream(transport, chunk.id);
    const decodedStream = await maybeGunzipStream(rawStream);
    let applyStream = decodedStream;
    let chunkHashPromise: Promise<string> | null = null;

    if (chunk.sha256) {
      const [hashStream, streamForApply] = decodedStream.tee();
      applyStream = streamForApply;
      chunkHashPromise = readAllBytesFromStream(hashStream).then((bytes) =>
        computeSha256Hex(bytes, sha256Override)
      );
    }

    const rowBatchIterator = decodeSnapshotRowStreamBatches(
      applyStream,
      SNAPSHOT_APPLY_BATCH_ROWS
    );

    let pendingBatch: unknown[] | null = null;
    let applyError: unknown = null;

    try {
      // eslint-disable-next-line no-await-in-loop
      for await (const batch of rowBatchIterator) {
        if (pendingBatch) {
          // eslint-disable-next-line no-await-in-loop
          await handler.applySnapshot(
            { trx },
            {
              ...snapshot,
              rows: pendingBatch,
              chunks: undefined,
              isFirstPage: nextIsFirstPage,
              isLastPage: false,
            }
          );
          nextIsFirstPage = false;
        }
        pendingBatch = batch;
      }

      if (pendingBatch) {
        const isLastChunk = chunkIndex === chunks.length - 1;
        // eslint-disable-next-line no-await-in-loop
        await handler.applySnapshot(
          { trx },
          {
            ...snapshot,
            rows: pendingBatch,
            chunks: undefined,
            isFirstPage: nextIsFirstPage,
            isLastPage: isLastChunk ? snapshot.isLastPage : false,
          }
        );
        nextIsFirstPage = false;
      }
    } catch (error) {
      applyError = error;
    }

    if (chunkHashPromise) {
      try {
        // eslint-disable-next-line no-await-in-loop
        const actualHash = await chunkHashPromise;
        if (!applyError && actualHash !== chunk.sha256) {
          applyError = new Error(
            `Snapshot chunk integrity check failed: expected sha256 ${chunk.sha256}, got ${actualHash}`
          );
        }
      } catch (hashError) {
        if (!applyError) {
          applyError = hashError;
        }
      }
    }

    if (applyError) {
      throw applyError;
    }
  }
}

function parseBootstrapState(
  value: string | object | null | undefined
): SyncBootstrapState | null {
  if (!value) return null;
  try {
    // Handle both string (raw JSON) and object (already deserialized by a DB plugin/driver)
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
  /**
   * Custom SHA-256 hash function for snapshot chunk integrity verification.
   * Provide this on platforms where `crypto.subtle` is unavailable (e.g. React Native).
   * Must return the hex-encoded hash string.
   */
  sha256?: (bytes: Uint8Array) => Promise<string>;
}

export interface SyncPullRequestState {
  request: SyncPullRequest;
  existing: SyncSubscriptionStateTable[];
  existingById: Map<string, SyncSubscriptionStateTable>;
  stateId: string;
}

/**
 * Build a pull request from subscription state. Exported for use
 * by the combined sync path in sync-loop.ts.
 */
export async function buildPullRequest<DB extends SyncClientDb>(
  db: Kysely<DB>,
  options: SyncPullOnceOptions
): Promise<SyncPullRequestState> {
  const stateId = options.stateId ?? 'default';

  const existingResult = await sql<SyncSubscriptionStateTable>`
    select
      ${sql.ref('state_id')},
      ${sql.ref('subscription_id')},
      ${sql.ref('table')},
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
    maxSnapshotPages: options.maxSnapshotPages ?? 4,
    dedupeRows: options.dedupeRows,
    subscriptions: (options.subscriptions ?? []).map((sub) => ({
      ...sub,
      cursor: Math.max(-1, existingById.get(sub.id)?.cursor ?? -1),
      bootstrapState: parseBootstrapState(
        existingById.get(sub.id)?.bootstrap_state_json
      ),
    })),
  };

  return { request, existing, existingById, stateId };
}

export function createFollowupPullState(
  pullState: SyncPullRequestState,
  response: SyncPullResponse
): SyncPullRequestState {
  const responseById = new Map<string, SyncPullSubscriptionResponse>();
  for (const sub of response.subscriptions ?? []) {
    responseById.set(sub.id, sub);
  }

  const now = Date.now();
  const nextExisting: SyncSubscriptionStateTable[] = [];
  const nextExistingById = new Map<string, SyncSubscriptionStateTable>();

  for (const sub of pullState.request.subscriptions ?? []) {
    const res = responseById.get(sub.id);
    if (res?.status === 'revoked') {
      continue;
    }

    const nextCursor = res ? Math.max(-1, res.nextCursor) : (sub.cursor ?? -1);
    const nextBootstrapState = res
      ? res.bootstrap
        ? (res.bootstrapState ?? null)
        : null
      : (sub.bootstrapState ?? null);
    const prev = pullState.existingById.get(sub.id);
    const nextRow: SyncSubscriptionStateTable = {
      state_id: pullState.stateId,
      subscription_id: sub.id,
      table: sub.table,
      scopes_json: serializeJsonCached(res?.scopes ?? sub.scopes ?? {}),
      params_json: serializeJsonCached(sub.params ?? {}),
      cursor: nextCursor,
      bootstrap_state_json: nextBootstrapState
        ? serializeJsonCached(nextBootstrapState)
        : null,
      status: 'active',
      created_at: prev?.created_at ?? now,
      updated_at: now,
    };
    nextExisting.push(nextRow);
    nextExistingById.set(nextRow.subscription_id, nextRow);
  }

  const nextRequest: SyncPullRequest = {
    ...pullState.request,
    subscriptions: (pullState.request.subscriptions ?? []).map((sub) => {
      const row = nextExistingById.get(sub.id);
      return {
        ...sub,
        cursor: Math.max(-1, row?.cursor ?? -1),
        bootstrapState: parseBootstrapState(row?.bootstrap_state_json),
      };
    }),
  };

  return {
    request: nextRequest,
    existing: nextExisting,
    existingById: nextExistingById,
    stateId: pullState.stateId,
  };
}

/**
 * Apply a pull response (run plugins + write to local DB).
 * Exported for use by the combined sync path in sync-loop.ts.
 */
export async function applyPullResponse<DB extends SyncClientDb>(
  db: Kysely<DB>,
  transport: SyncTransport,
  handlers: ClientHandlerCollection<DB>,
  options: SyncPullOnceOptions,
  pullState: SyncPullRequestState,
  rawResponse: SyncPullResponse
): Promise<SyncPullResponse> {
  const { request, existing, existingById, stateId } = pullState;

  const ctx: SyncClientPluginContext = {
    actorId: options.actorId ?? 'unknown',
    clientId: options.clientId,
  };
  const plugins = options.plugins ?? [];
  const requiresMaterializedSnapshots = plugins.some(
    (plugin) => !!plugin.afterPull
  );

  let responseToApply = requiresMaterializedSnapshots
    ? await materializeChunkedSnapshots(transport, rawResponse, options.sha256)
    : rawResponse;
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

      // Clear data for this table matching the subscription's scopes
      if (row.table) {
        try {
          const scopes = row.scopes_json
            ? typeof row.scopes_json === 'string'
              ? JSON.parse(row.scopes_json)
              : row.scopes_json
            : {};
          await getClientHandlerOrThrow(handlers, row.table).clearAll({
            trx,
            scopes,
          });
        } catch {
          // ignore missing table handler
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
      const prevCursorRaw = prev?.cursor;
      const prevCursor =
        typeof prevCursorRaw === 'number'
          ? prevCursorRaw
          : prevCursorRaw === null || prevCursorRaw === undefined
            ? null
            : Number(prevCursorRaw);
      const latestStateResult = await sql<{ cursor: number | string | null }>`
        select ${sql.ref('cursor')} as cursor
        from ${sql.table('sync_subscription_state')}
        where ${sql.ref('state_id')} = ${sql.val(stateId)}
          and ${sql.ref('subscription_id')} = ${sql.val(sub.id)}
      `.execute(trx);
      const latestCursorRaw = latestStateResult.rows[0]?.cursor;
      const latestCursor =
        typeof latestCursorRaw === 'number'
          ? latestCursorRaw
          : latestCursorRaw === null || latestCursorRaw === undefined
            ? null
            : Number(latestCursorRaw);
      const effectiveCursor =
        prevCursor !== null &&
        Number.isFinite(prevCursor) &&
        latestCursor !== null &&
        Number.isFinite(latestCursor)
          ? Math.max(prevCursor, latestCursor)
          : prevCursor !== null && Number.isFinite(prevCursor)
            ? prevCursor
            : latestCursor !== null && Number.isFinite(latestCursor)
              ? latestCursor
              : null;
      const staleIncrementalResponse =
        !sub.bootstrap &&
        effectiveCursor !== null &&
        sub.nextCursor < effectiveCursor;

      // Guard against out-of-order duplicate pull responses from older requests.
      if (staleIncrementalResponse) {
        continue;
      }

      // Revoked: clear data and drop the subscription row.
      if (sub.status === 'revoked') {
        if (prev?.table) {
          try {
            const scopes = prev.scopes_json
              ? typeof prev.scopes_json === 'string'
                ? JSON.parse(prev.scopes_json)
                : prev.scopes_json
              : {};
            await getClientHandlerOrThrow(handlers, prev.table).clearAll({
              trx,
              scopes,
            });
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
          const handler = getClientHandlerOrThrow(handlers, snapshot.table);
          const hasChunkRefs =
            Array.isArray(snapshot.chunks) && snapshot.chunks.length > 0;

          // Call onSnapshotStart hook when starting a new snapshot
          if (snapshot.isFirstPage && handler.onSnapshotStart) {
            await handler.onSnapshotStart({
              trx,
              table: snapshot.table,
              scopes: sub.scopes,
            });
          }

          if (hasChunkRefs) {
            await applyChunkedSnapshot(
              transport,
              handler,
              trx,
              snapshot,
              options.sha256
            );
          } else {
            await handler.applySnapshot({ trx }, snapshot);
          }

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
          const commitSeq = commit.commitSeq ?? null;
          const actorId = commit.actorId ?? null;
          const createdAt = commit.createdAt ?? null;
          for (const change of commit.changes) {
            const handler = getClientHandlerOrThrow(handlers, change.table);
            await handler.applyChange(
              {
                trx,
                commitSeq,
                actorId,
                createdAt,
              },
              change
            );
          }
        }
      }

      // Persist subscription cursor + metadata.
      // Use cached JSON serialization to avoid repeated stringification
      const now = Date.now();
      const paramsJson = serializeJsonCached(def?.params ?? {});
      const scopesJson = serializeJsonCached(sub.scopes ?? def?.scopes ?? {});
      const bootstrapStateJson = sub.bootstrap
        ? sub.bootstrapState
          ? serializeJsonCached(sub.bootstrapState)
          : null
        : null;

      const table = def?.table ?? 'unknown';
      await sql`
	        insert into ${sql.table('sync_subscription_state')} (
	          ${sql.join([
              sql.ref('state_id'),
              sql.ref('subscription_id'),
              sql.ref('table'),
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
              sql.val(table),
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
	          ${sql.ref('table')} = ${sql.val(table)},
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

export async function syncPullOnce<DB extends SyncClientDb>(
  db: Kysely<DB>,
  transport: SyncTransport,
  handlers: ClientHandlerCollection<DB>,
  options: SyncPullOnceOptions,
  pullStateOverride?: SyncPullRequestState
): Promise<SyncPullResponse> {
  const pullState = pullStateOverride ?? (await buildPullRequest(db, options));
  const { clientId, ...pullBody } = pullState.request;
  const combined = await transport.sync({ clientId, pull: pullBody });
  if (!combined.pull) {
    return { ok: true, subscriptions: [] };
  }
  return applyPullResponse(
    db,
    transport,
    handlers,
    options,
    pullState,
    combined.pull
  );
}
