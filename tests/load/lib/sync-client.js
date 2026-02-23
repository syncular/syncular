/**
 * k6 Sync API client helpers
 *
 * Provides reusable functions for interacting with the sync API
 * in k6 load test scripts.
 */

import http from 'k6/http';
import ws from 'k6/ws';

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
 * @param {object} res - k6 http response
 * @returns {object|null}
 */
export function parseCombinedResponse(res) {
  if (!res || typeof res.body !== 'string' || res.body.length === 0) {
    return null;
  }

  try {
    return JSON.parse(res.body);
  } catch {
    return null;
  }
}

function pushRowId(set, value) {
  if (typeof value === 'string' && value.length > 0) {
    set.add(value);
  }
}

/**
 * Collect row ids that were delivered in a pull subscription payload.
 * Includes both incremental commits and bootstrap snapshots.
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
 * @returns {object} k6 http response
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
        clientCommitId:
          opts.clientCommitId || `commit-${Date.now()}-${__VU}-${__ITER}`,
        schemaVersion,
        operations,
      },
    }),
    {
      headers: jsonHeaders(userId),
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
 * @returns {object} k6 http response
 */
export function pull(userId, subscriptions, options, clientId) {
  const opts = options || {};
  const cid = clientId || `k6-${__VU}-${__ITER}`;

  return http.post(
    `${BASE_URL}/api/sync`,
    JSON.stringify({
      clientId: cid,
      pull: {
        limitCommits: opts.limitCommits ?? 100,
        limitSnapshotRows: opts.limitSnapshotRows ?? 1000,
        maxSnapshotPages: opts.maxSnapshotPages ?? 4,
        dedupeRows: opts.dedupeRows === true,
        subscriptions,
      },
    }),
    {
      headers: jsonHeaders(userId),
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
 * Fetch a snapshot chunk by ID
 * @param {string} userId - User ID for authentication
 * @param {string} chunkId - Chunk ID to fetch
 * @returns {object} k6 http response
 */
export function fetchSnapshotChunk(userId, chunkId) {
  return http.get(`${BASE_URL}/api/sync/snapshot-chunks/${chunkId}`, {
    headers: {
      'X-User-Id': userId,
    },
    responseType: 'binary',
  });
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
