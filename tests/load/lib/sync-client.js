/**
 * k6 Sync API client helpers
 *
 * Provides reusable functions for interacting with the sync API
 * in k6 load test scripts.
 */

import http from 'k6/http';
import ws from 'k6/ws';

const BASE_URL = __ENV.BASE_URL || 'http://localhost:3001';

/**
 * Push operations to the server
 * @param {string} userId - User ID for authentication
 * @param {Array} operations - Array of sync operations
 * @param {string} [clientId] - Optional client ID (auto-generated if not provided)
 * @returns {object} k6 http response
 */
export function push(userId, operations, clientId) {
  const cid = clientId || `k6-${__VU}-${__ITER}`;
  return http.post(
    `${BASE_URL}/api/sync/push`,
    JSON.stringify({
      clientId: cid,
      clientCommitId: `commit-${Date.now()}-${__VU}-${__ITER}`,
      operations,
    }),
    {
      headers: {
        'Content-Type': 'application/json',
        'X-User-Id': userId,
      },
    }
  );
}

/**
 * Pull changes from the server
 * @param {string} userId - User ID for authentication
 * @param {Array} subscriptions - Array of subscription requests (must include id, kind, params, cursor)
 * @param {number} [limitCommits] - Max commits to pull (default: 1000)
 * @param {string} [clientId] - Optional client ID (auto-generated if not provided)
 * @returns {object} k6 http response
 */
export function pull(userId, subscriptions, limitCommits, clientId) {
  const cid = clientId || `k6-${__VU}-${__ITER}`;
  return http.post(
    `${BASE_URL}/api/sync/pull`,
    JSON.stringify({
      clientId: cid,
      limitCommits: limitCommits || 1000,
      subscriptions,
    }),
    {
      headers: {
        'Content-Type': 'application/json',
        'X-User-Id': userId,
      },
    }
  );
}

/**
 * Connect to WebSocket for realtime notifications
 * @param {string} userId - User ID for authentication
 * @param {object} handlers - Event handlers { onOpen, onMessage, onError, onClose }
 * @param {number} [duration] - How long to keep the connection open (seconds)
 * @returns {object} WebSocket connection result
 */
export function connectWebSocket(userId, handlers, duration) {
  const wsUrl = BASE_URL.replace('http', 'ws');
  const url = `${wsUrl}/api/sync/realtime?userId=${userId}`;

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
  return http.get(`${BASE_URL}/api/sync/snapshot/${chunkId}`, {
    headers: {
      'X-User-Id': userId,
    },
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
