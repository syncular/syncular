/**
 * @syncular/client - Proxy Driver
 *
 * Kysely Driver that creates WebSocket connections for query execution.
 */

import type { DatabaseConnection, Driver } from 'kysely';
import { ProxyConnection } from './connection';

interface ProxyDriverConfig {
  /** WebSocket endpoint URL (wss://...) */
  endpoint: string;
  /** Actor ID for oplog tracking */
  actorId: string;
  /** Client ID for oplog tracking */
  clientId: string;
  /** Optional headers for authentication */
  headers?: Record<string, string>;
}

/**
 * Custom WebSocket factory type for environments that need it.
 */
export type WebSocketFactory = (
  url: string,
  protocols?: string | string[]
) => WebSocket;

/**
 * Extended config with optional WebSocket factory.
 */
export interface ProxyDriverConfigWithFactory extends ProxyDriverConfig {
  /** Optional WebSocket factory for custom environments */
  createWebSocket?: WebSocketFactory;
}

export class ProxyDriver implements Driver {
  private connection: ProxyConnection | null = null;

  constructor(private config: ProxyDriverConfigWithFactory) {}

  async init(): Promise<void> {
    // No initialization needed
  }

  async acquireConnection(): Promise<DatabaseConnection> {
    // Reuse existing connection if available
    if (this.connection) {
      return this.connection as DatabaseConnection;
    }

    const ws = await this.createWebSocket();
    this.connection = new ProxyConnection(
      ws,
      this.config.actorId,
      this.config.clientId
    );
    return this.connection as DatabaseConnection;
  }

  private async createWebSocket(): Promise<WebSocket> {
    return new Promise((resolve, reject) => {
      // Build URL with auth info if needed
      const url = new URL(this.config.endpoint);

      // Note: WebSocket doesn't support custom headers directly,
      // so auth is typically done via query params or after connection
      // The server should handle auth during the handshake
      if (this.config.headers?.authorization) {
        url.searchParams.set(
          'authorization',
          this.config.headers.authorization
        );
      }

      let ws: WebSocket;
      if (this.config.createWebSocket) {
        ws = this.config.createWebSocket(url.toString());
      } else {
        ws = new WebSocket(url.toString());
      }

      ws.onopen = () => {
        resolve(ws);
      };

      ws.onerror = (_event) => {
        reject(new Error('Failed to connect to proxy endpoint'));
      };

      // Set a connection timeout
      const timeout = setTimeout(() => {
        ws.close();
        reject(new Error('Connection timeout'));
      }, 30000);

      ws.onopen = () => {
        clearTimeout(timeout);
        resolve(ws);
      };
    });
  }

  async beginTransaction(connection: DatabaseConnection): Promise<void> {
    await (connection as ProxyConnection).beginTransaction();
  }

  async commitTransaction(connection: DatabaseConnection): Promise<void> {
    await (connection as ProxyConnection).commitTransaction();
  }

  async rollbackTransaction(connection: DatabaseConnection): Promise<void> {
    await (connection as ProxyConnection).rollbackTransaction();
  }

  async releaseConnection(): Promise<void> {
    // Keep the connection alive for reuse
  }

  async destroy(): Promise<void> {
    if (this.connection) {
      this.connection.close();
      this.connection = null;
    }
  }
}
