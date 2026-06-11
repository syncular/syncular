/**
 * k6 Sync API client helpers
 *
 * Provides reusable functions for interacting with the sync API
 * in k6 load test scripts.
 */

import http from 'k6/http';
import ws from 'k6/ws';
import { isSyncPackBody, parseSyncPack } from './ssp1.js';

const BASE_URL = __ENV.BASE_URL || 'http://localhost:3001';
const DEFAULT_SCHEMA_VERSION = Number.parseInt(__ENV.SCHEMA_VERSION || '1', 10);

function jsonHeaders(userId) {
  return {
    'Content-Type': 'application/json',
    'X-User-Id': userId,
  };
}

/**
 * Parse a combined /sync response body safely.
 *
 * The combined endpoint responds with binary SSP1 sync packs (push/pull
 * helpers below request `responseType: 'binary'`, so `res.body` is an
 * ArrayBuffer). Returns the decoded SyncCombinedResponse-shaped object,
 * or null when the body is missing, not SSP1, or malformed.
 *
 * Note: changes the server grouped into compressed binary row groups
 * come back with `row_json: null` plus a `rowRef` marker (k6 cannot
 * gunzip); their row_id/op/scopes metadata is complete. See ssp1.js.
 * @param {object} res - k6 http response (binary)
 * @returns {object|null}
 */
export function parseCombinedResponse(res) {
  if (!res || !isSyncPackBody(res.body)) {
    return null;
  }

  try {
    return parseSyncPack(res.body);
  } catch (err) {
    console.error(`Failed to parse SSP1 sync pack: ${err}`);
    return null;
  }
}

/**
 * Summarize a k6 response for error logs. Bodies are binary SSP1 packs,
 * so printing `res.body` directly is useless; report sizes instead.
 * @param {object} res - k6 http response
 * @returns {string}
 */
export function describeResponse(res) {
  if (!res) return 'no response';
  const byteLength =
    res.body && typeof res.body.byteLength === 'number'
      ? res.body.byteLength
      : typeof res.body === 'string'
        ? res.body.length
        : 0;
  return `status=${res.status}, bodyBytes=${byteLength}`;
}

function pushRowId(set, value) {
  if (typeof value === 'string' && value.length > 0) {
    set.add(value);
  }
}

/**
 * Collect row ids that were delivered in a pull subscription payload.
 * Includes both incremental commits and bootstrap snapshots.
 *
 * Works on parsed SSP1 subscriptions: change row ids always travel in
 * the uncompressed change metadata, so this stays exact even when row
 * bodies were grouped into compressed payloads. Rows that only exist in
 * external snapshot chunks (refs-only snapshots) are NOT visible here.
 * @param {object|null|undefined} subscription
 * @returns {Set<string>}
 */
export function collectPulledRowIds(subscription) {
  const rowIds = new Set();
  if (!subscription || typeof subscription !== 'object') return rowIds;

  for (const commit of subscription.commits || []) {
    for (const change of commit?.changes || []) {
      pushRowId(rowIds, change?.row_id);

      const rowJson = change?.row_json;
      if (rowJson && typeof rowJson === 'object') {
        pushRowId(rowIds, rowJson.id);
      }
    }
  }

  for (const snapshot of subscription.snapshots || []) {
    for (const row of snapshot?.rows || []) {
      if (row && typeof row === 'object') {
        pushRowId(rowIds, row.id);
      }
    }
  }

  return rowIds;
}

/**
 * Push operations to the server
 * @param {string} userId - User ID for authentication
 * @param {Array} operations - Array of sync operations
 * @param {string} [clientId] - Optional client ID (auto-generated if not provided)
 * @param {object} [options] - Optional push options
 * @param {number} [options.schemaVersion] - Schema version (default: 1)
 * @param {string} [options.clientCommitId] - Custom commit ID
 * @returns {object} k6 http response (binary SSP1 body; use parseCombinedResponse)
 */
export function push(userId, operations, clientId, options) {
  const opts = options || {};
  const cid = clientId || `k6-${__VU}-${__ITER}`;
  const schemaVersion = Number.isFinite(opts.schemaVersion)
    ? opts.schemaVersion
    : DEFAULT_SCHEMA_VERSION;

  return http.post(
    `${BASE_URL}/api/sync`,
    JSON.stringify({
      clientId: cid,
      push: {
        commits: [
          {
            clientCommitId:
              opts.clientCommitId || `commit-${Date.now()}-${__VU}-${__ITER}`,
            schemaVersion,
            operations,
          },
        ],
      },
    }),
    {
      headers: jsonHeaders(userId),
      responseType: 'binary',
    }
  );
}

/**
 * Pull changes from the server
 * @param {string} userId - User ID for authentication
 * @param {Array} subscriptions - Array of pull subscriptions
 * @param {object} [options] - Pull options
 * @param {number} [options.limitCommits] - Max commits to pull (default: 100)
 * @param {number} [options.limitSnapshotRows] - Max snapshot rows per page (default: 1000)
 * @param {number} [options.maxSnapshotPages] - Max snapshot pages per response (default: 4)
 * @param {boolean} [options.dedupeRows] - Enable row dedupe
 * @param {string} [clientId] - Optional client ID (auto-generated if not provided)
 * @returns {object} k6 http response (binary SSP1 body; use parseCombinedResponse)
 */
export function pull(userId, subscriptions, options, clientId) {
  const opts = options || {};
  const cid = clientId || `k6-${__VU}-${__ITER}`;

  return http.post(
    `${BASE_URL}/api/sync`,
    JSON.stringify({
      clientId: cid,
      pull: {
        schemaVersion: Number.isFinite(opts.schemaVersion)
          ? opts.schemaVersion
          : DEFAULT_SCHEMA_VERSION,
        limitCommits: opts.limitCommits ?? 100,
        limitSnapshotRows: opts.limitSnapshotRows ?? 1000,
        maxSnapshotPages: opts.maxSnapshotPages ?? 4,
        dedupeRows: opts.dedupeRows === true,
        subscriptions,
      },
    }),
    {
      headers: jsonHeaders(userId),
      responseType: 'binary',
    }
  );
}

/**
 * Connect to WebSocket for realtime notifications
 * @param {string} userId - User ID for authentication
 * @param {string} clientId - Client ID required by realtime endpoint
 * @param {object} handlers - Event handlers { onOpen, onMessage, onError, onClose }
 * @param {number} [duration] - How long to keep the connection open (seconds)
 * @returns {object} WebSocket connection result
 */
export function connectWebSocket(userId, clientId, handlers, duration) {
  const cid = clientId || `k6-ws-${__VU}-${__ITER}`;
  const wsUrl = BASE_URL.replace('http', 'ws');
  const url =
    `${wsUrl}/api/sync/realtime` +
    `?userId=${encodeURIComponent(userId)}` +
    `&clientId=${encodeURIComponent(cid)}`;

  return ws.connect(url, {}, (socket) => {
    socket.on('open', () => {
      if (handlers.onOpen) {
        handlers.onOpen(socket);
      }
    });

    socket.on('message', (data) => {
      if (handlers.onMessage) {
        handlers.onMessage(data, socket);
      }
    });

    socket.on('error', (e) => {
      if (handlers.onError) {
        handlers.onError(e, socket);
      } else {
        console.error('WS error:', e);
      }
    });

    socket.on('close', () => {
      if (handlers.onClose) {
        handlers.onClose(socket);
      }
    });

    // Keep connection alive for specified duration
    if (duration) {
      socket.setTimeout(() => {
        socket.close();
      }, duration * 1000);
    }
  });
}

/**
 * Fetch a snapshot chunk by ID.
 * The server authorizes chunk downloads against the subscription scopes,
 * passed as a JSON `scopes` query parameter (the parsed SSP1 subscription
 * exposes them as `subscription.scopes`).
 * @param {string} userId - User ID for authentication
 * @param {string} chunkId - Chunk ID to fetch
 * @param {object} [scopes] - Scope values the chunk was produced for
 * @returns {object} k6 http response (binary gzip body)
 */
export function fetchSnapshotChunk(userId, chunkId, scopes) {
  const scopesQuery = scopes
    ? `?scopes=${encodeURIComponent(JSON.stringify(scopes))}`
    : '';
  return http.get(
    `${BASE_URL}/api/sync/snapshot-chunks/${chunkId}${scopesQuery}`,
    {
      headers: {
        'X-User-Id': userId,
      },
      responseType: 'binary',
    }
  );
}

/**
 * Health check endpoint
 * @returns {object} k6 http response
 */
export function healthCheck() {
  return http.get(`${BASE_URL}/api/health`);
}

/**
 * Get the base URL being used
 * @returns {string} Base URL
 */
export function getBaseUrl() {
  return BASE_URL;
}
