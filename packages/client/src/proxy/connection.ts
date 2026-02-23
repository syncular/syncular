/**
 * @syncular/client - Proxy Connection
 *
 * DatabaseConnection implementation that proxies queries over WebSocket.
 */

import type {
  ProxyHandshake,
  ProxyHandshakeAck,
  ProxyMessage,
  ProxyResponse,
} from '@syncular/core';
import type { CompiledQuery, DatabaseConnection, QueryResult } from 'kysely';

/**
 * WebSocket wrapper that handles reconnection and message correlation.
 */
export class ProxyConnection implements DatabaseConnection {
  private ws: WebSocket;
  private messageId = 0;
  private pendingRequests = new Map<
    string,
    {
      resolve: (response: ProxyResponse) => void;
      reject: (error: Error) => void;
    }
  >();
  private handshakeComplete = false;
  private handshakePromise: Promise<void>;
  private handshakeResolve: (() => void) | null = null;
  private handshakeReject: ((error: Error) => void) | null = null;
  private closed = false;

  constructor(
    ws: WebSocket,
    private actorId: string,
    private clientId: string
  ) {
    this.ws = ws;

    this.handshakePromise = new Promise((resolve, reject) => {
      this.handshakeResolve = resolve;
      this.handshakeReject = reject;
    });

    this.ws.onmessage = (event) => {
      this.handleMessage(event.data as string);
    };

    this.ws.onerror = (_event) => {
      const error = new Error('WebSocket error');
      this.rejectAllPending(error);
      if (!this.handshakeComplete) {
        this.handshakeReject?.(error);
      }
    };

    this.ws.onclose = () => {
      this.closed = true;
      const error = new Error('WebSocket closed');
      this.rejectAllPending(error);
      if (!this.handshakeComplete) {
        this.handshakeReject?.(error);
      }
    };

    // Send handshake
    const handshake: ProxyHandshake = {
      type: 'handshake',
      actorId: this.actorId,
      clientId: this.clientId,
    };
    this.ws.send(JSON.stringify(handshake));
  }

  private handleMessage(data: string): void {
    try {
      const message = JSON.parse(data);

      // Handle handshake acknowledgement
      if (message.type === 'handshake_ack') {
        const ack = message as ProxyHandshakeAck;
        if (ack.ok) {
          this.handshakeComplete = true;
          this.handshakeResolve?.();
        } else {
          this.handshakeReject?.(new Error(ack.error ?? 'Handshake failed'));
        }
        return;
      }

      // Handle query responses
      const response = message as ProxyResponse;
      const pending = this.pendingRequests.get(response.id);
      if (pending) {
        this.pendingRequests.delete(response.id);
        pending.resolve(response);
      }
    } catch {
      // Ignore malformed messages
    }
  }

  private rejectAllPending(error: Error): void {
    for (const pending of this.pendingRequests.values()) {
      pending.reject(error);
    }
    this.pendingRequests.clear();
  }

  private async send(message: ProxyMessage): Promise<ProxyResponse> {
    // Wait for handshake to complete
    await this.handshakePromise;

    if (this.closed) {
      throw new Error('Connection is closed');
    }

    return new Promise((resolve, reject) => {
      this.pendingRequests.set(message.id, { resolve, reject });
      this.ws.send(JSON.stringify(message));
    });
  }

  private nextMessageId(): string {
    return `${++this.messageId}`;
  }

  async executeQuery<R>(query: CompiledQuery): Promise<QueryResult<R>> {
    const response = await this.send({
      id: this.nextMessageId(),
      type: 'query',
      sql: query.sql,
      parameters: query.parameters,
    });

    if (response.type === 'error') {
      throw new Error(response.error ?? 'Query failed');
    }

    return {
      rows: (response.rows ?? []) as R[],
      numAffectedRows:
        response.rowCount != null ? BigInt(response.rowCount) : undefined,
    };
  }

  async beginTransaction(): Promise<void> {
    const response = await this.send({
      id: this.nextMessageId(),
      type: 'begin',
    });

    if (response.type === 'error') {
      throw new Error(response.error ?? 'Failed to begin transaction');
    }
  }

  async commitTransaction(): Promise<void> {
    const response = await this.send({
      id: this.nextMessageId(),
      type: 'commit',
    });

    if (response.type === 'error') {
      throw new Error(response.error ?? 'Failed to commit transaction');
    }
  }

  async rollbackTransaction(): Promise<void> {
    const response = await this.send({
      id: this.nextMessageId(),
      type: 'rollback',
    });

    if (response.type === 'error') {
      throw new Error(response.error ?? 'Failed to rollback transaction');
    }
  }

  streamQuery<R>(): AsyncIterableIterator<QueryResult<R>> {
    throw new Error('Streaming queries are not supported over proxy');
  }

  close(): void {
    if (!this.closed) {
      this.closed = true;
      this.ws.close();
    }
  }
}
