/**
 * @syncular/server-hono - Proxy Connection Manager
 *
 * Manages WebSocket connections for the proxy.
 */

import type {
  ProxyHandshake,
  ProxyMessage,
  ProxyResponse,
} from '@syncular/core';
import type {
  ExecuteProxyQueryResult,
  ProxyHandlerCollection,
  ServerSyncDialect,
  SyncCoreDb,
} from '@syncular/server';
import { executeProxyQuery } from '@syncular/server';
import type { WSContext } from 'hono/ws';
import type { Kysely, Transaction } from 'kysely';

export interface ProxyConnectionManagerConfig<
  DB extends SyncCoreDb = SyncCoreDb,
> {
  /** Database connection */
  db: Kysely<DB>;
  /** Server sync dialect */
  dialect: ServerSyncDialect;
  /** Proxy table handlers for oplog generation */
  handlers: ProxyHandlerCollection;
  /** Maximum concurrent connections (default: 100) */
  maxConnections?: number;
  /** Idle connection timeout in ms (default: 30000) */
  idleTimeoutMs?: number;
}

interface ProxyConnectionState<DB extends SyncCoreDb> {
  ws: WSContext;
  actorId: string;
  clientId: string;
  transaction: Transaction<DB> | null;
  lastActivity: number;
  idleTimer: ReturnType<typeof setTimeout> | null;
  /** Transaction promise resolve callback */
  __resolveTransaction?: () => void;
  /** Transaction promise reject callback */
  __rejectTransaction?: (error: Error) => void;
}

/**
 * Manages proxy WebSocket connections and their state.
 */
export class ProxyConnectionManager<DB extends SyncCoreDb = SyncCoreDb> {
  private connections = new Map<WSContext, ProxyConnectionState<DB>>();
  private config: ProxyConnectionManagerConfig<DB>;
  private idleTimeoutMs: number;
  private maxConnections: number;

  constructor(config: ProxyConnectionManagerConfig<DB>) {
    this.config = config;
    this.idleTimeoutMs = config.idleTimeoutMs ?? 30000;
    this.maxConnections = config.maxConnections ?? 100;
  }

  /**
   * Check if a new connection can be accepted.
   */
  canAccept(): boolean {
    return this.connections.size < this.maxConnections;
  }

  /**
   * Get the current connection count.
   */
  getConnectionCount(): number {
    return this.connections.size;
  }

  /**
   * Handle the handshake message and register the connection.
   */
  register(ws: WSContext, handshake: ProxyHandshake): ProxyConnectionState<DB> {
    const state: ProxyConnectionState<DB> = {
      ws,
      actorId: handshake.actorId,
      clientId: handshake.clientId,
      transaction: null,
      lastActivity: Date.now(),
      idleTimer: null,
    };

    this.connections.set(ws, state);
    this.resetIdleTimer(state);

    return state;
  }

  /**
   * Get the connection state for a WebSocket.
   */
  get(ws: WSContext): ProxyConnectionState<DB> | undefined {
    return this.connections.get(ws);
  }

  /**
   * Unregister and cleanup a connection.
   */
  async unregister(ws: WSContext): Promise<void> {
    const state = this.connections.get(ws);
    if (!state) return;

    // Clear idle timer
    if (state.idleTimer) {
      clearTimeout(state.idleTimer);
    }

    // Rollback any pending transaction by rejecting the promise
    if (state.transaction) {
      const rejectTransaction = state.__rejectTransaction;
      if (rejectTransaction) {
        rejectTransaction(new Error('Connection closed'));
      }
      state.transaction = null;
      state.__resolveTransaction = undefined;
      state.__rejectTransaction = undefined;
    }

    this.connections.delete(ws);
  }

  /**
   * Handle a proxy message and return the response.
   */
  async handleMessage(
    ws: WSContext,
    message: ProxyMessage
  ): Promise<ProxyResponse> {
    const state = this.connections.get(ws);
    if (!state) {
      return {
        id: message.id,
        type: 'error',
        error: 'Connection not registered',
      };
    }

    // Update activity and reset idle timer
    state.lastActivity = Date.now();
    this.resetIdleTimer(state);

    try {
      switch (message.type) {
        case 'begin':
          return await this.handleBegin(state, message);

        case 'commit':
          return await this.handleCommit(state, message);

        case 'rollback':
          return await this.handleRollback(state, message);

        case 'query':
          return await this.handleQuery(state, message);

        default:
          return {
            id: message.id,
            type: 'error',
            error: `Unknown message type: ${message.type}`,
          };
      }
    } catch (err) {
      return {
        id: message.id,
        type: 'error',
        error: err instanceof Error ? err.message : 'Unknown error',
      };
    }
  }

  private async handleBegin(
    state: ProxyConnectionState<DB>,
    message: ProxyMessage
  ): Promise<ProxyResponse> {
    if (state.transaction) {
      return {
        id: message.id,
        type: 'error',
        error: 'Transaction already in progress',
      };
    }

    // Start a transaction and keep it open
    // We use a workaround since Kysely doesn't expose raw transaction control
    return new Promise((resolve) => {
      this.config.db
        .transaction()
        .execute(async (trx) => {
          state.transaction = trx;

          // Wait for commit or rollback
          return new Promise<void>((resolveTransaction, rejectTransaction) => {
            state.__resolveTransaction = resolveTransaction;
            state.__rejectTransaction = rejectTransaction;
            resolve({
              id: message.id,
              type: 'result',
            });
          });
        })
        .catch(() => {
          // Transaction was rolled back externally
        });
    });
  }

  private async handleCommit(
    state: ProxyConnectionState<DB>,
    message: ProxyMessage
  ): Promise<ProxyResponse> {
    if (!state.transaction) {
      return {
        id: message.id,
        type: 'error',
        error: 'No transaction in progress',
      };
    }

    // Resolve the transaction promise to commit
    const resolveTransaction = state.__resolveTransaction;
    if (resolveTransaction) {
      resolveTransaction();
    }
    state.transaction = null;
    state.__resolveTransaction = undefined;
    state.__rejectTransaction = undefined;

    return {
      id: message.id,
      type: 'result',
    };
  }

  private async handleRollback(
    state: ProxyConnectionState<DB>,
    message: ProxyMessage
  ): Promise<ProxyResponse> {
    if (!state.transaction) {
      return {
        id: message.id,
        type: 'error',
        error: 'No transaction in progress',
      };
    }

    // Reject the transaction promise to trigger rollback
    const rejectTransaction = state.__rejectTransaction;
    if (rejectTransaction) {
      rejectTransaction(new Error('Transaction rolled back'));
    }
    state.transaction = null;
    state.__resolveTransaction = undefined;
    state.__rejectTransaction = undefined;

    return {
      id: message.id,
      type: 'result',
    };
  }

  private async handleQuery(
    state: ProxyConnectionState<DB>,
    message: ProxyMessage
  ): Promise<ProxyResponse> {
    if (!message.sql) {
      return {
        id: message.id,
        type: 'error',
        error: 'Missing SQL query',
      };
    }

    const db = state.transaction ?? this.config.db;

    const result: ExecuteProxyQueryResult = await executeProxyQuery({
      db,
      dialect: this.config.dialect,
      handlers: this.config.handlers,
      ctx: {
        actorId: state.actorId,
        clientId: state.clientId,
      },
      sqlQuery: message.sql,
      parameters: message.parameters ?? [],
    });

    return {
      id: message.id,
      type: 'result',
      rows: result.rows,
      rowCount: result.rowCount,
    };
  }

  private resetIdleTimer(state: ProxyConnectionState<DB>): void {
    if (state.idleTimer) {
      clearTimeout(state.idleTimer);
    }

    if (this.idleTimeoutMs <= 0) return;

    state.idleTimer = setTimeout(() => {
      // Close idle connection
      try {
        state.ws.close(4000, 'Idle timeout');
      } catch {
        // Ignore close errors
      }
      this.unregister(state.ws);
    }, this.idleTimeoutMs);
  }

  /**
   * Close all connections.
   */
  async closeAll(): Promise<void> {
    const promises: Promise<void>[] = [];

    for (const [ws] of this.connections) {
      try {
        ws.close(1000, 'Server shutdown');
      } catch {
        // Ignore close errors
      }
      promises.push(this.unregister(ws));
    }

    await Promise.all(promises);
  }
}
