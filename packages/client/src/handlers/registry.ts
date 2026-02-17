/**
 * @syncular/client - Sync client table registry
 */

import type { ClientTableHandler } from './types';

/**
 * Registry for client-side table handlers.
 */
export class ClientTableRegistry<DB> {
  private handlers = new Map<string, ClientTableHandler<DB>>();

  register(handler: ClientTableHandler<DB>): this {
    if (this.handlers.has(handler.table)) {
      throw new Error(
        `Client table handler already registered: ${handler.table}`
      );
    }
    this.handlers.set(handler.table, handler);
    return this;
  }

  get(table: string): ClientTableHandler<DB> | undefined {
    return this.handlers.get(table);
  }

  getOrThrow(table: string): ClientTableHandler<DB> {
    const h = this.handlers.get(table);
    if (!h) throw new Error(`Missing client table handler for table: ${table}`);
    return h;
  }

  getAll(): ClientTableHandler<DB>[] {
    return Array.from(this.handlers.values());
  }
}
