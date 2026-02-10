/**
 * @syncular/core - Proxy Protocol Types
 *
 * Shared protocol types between proxy client (Kysely dialect) and server (WebSocket handler).
 */

/**
 * Message sent from proxy client to server.
 */
export interface ProxyMessage {
  /** Correlation ID for matching request/response */
  id: string;
  /** Message type */
  type: 'query' | 'begin' | 'commit' | 'rollback';
  /** SQL query (for 'query' type) */
  sql?: string;
  /** Query parameters (for 'query' type) */
  parameters?: readonly unknown[];
}

/**
 * Response sent from server to proxy client.
 */
export interface ProxyResponse {
  /** Correlation ID matching the request */
  id: string;
  /** Response type */
  type: 'result' | 'error';
  /** Query result rows (for SELECT queries) */
  rows?: unknown[];
  /** Number of affected rows (for mutations) */
  rowCount?: number;
  /** Error message (for 'error' type) */
  error?: string;
}

/**
 * Handshake message sent when connection is established.
 */
export interface ProxyHandshake {
  type: 'handshake';
  /** Actor ID for oplog tracking */
  actorId: string;
  /** Client ID for oplog tracking */
  clientId: string;
}

/**
 * Handshake acknowledgement from server.
 */
export interface ProxyHandshakeAck {
  type: 'handshake_ack';
  /** Whether handshake was successful */
  ok: boolean;
  /** Error message if handshake failed */
  error?: string;
}
