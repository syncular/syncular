/**
 * @syncular/server - Proxy Table Registry
 *
 * Registry for proxy table handlers.
 */

import type { ProxyTableHandler } from './types';

/**
 * Registry for proxy table handlers.
 *
 * Maps table names to table handlers for oplog generation.
 */
export class ProxyTableRegistry {
  private handlers = new Map<string, ProxyTableHandler>();

  /**
   * Register a proxy table handler.
   */
  register(handler: ProxyTableHandler): this {
    this.handlers.set(handler.table, handler);
    return this;
  }

  /**
   * Get handler by table name.
   */
  get(tableName: string): ProxyTableHandler | undefined {
    return this.handlers.get(tableName);
  }

  /**
   * Get handler by table name or throw.
   */
  getOrThrow(tableName: string): ProxyTableHandler {
    const handler = this.handlers.get(tableName);
    if (!handler) {
      throw new Error(`No proxy table registered for table: ${tableName}`);
    }
    return handler;
  }

  /**
   * Check if a table has a registered handler.
   */
  has(tableName: string): boolean {
    return this.handlers.has(tableName);
  }

  /**
   * Get all registered handlers.
   */
  getAll(): ProxyTableHandler[] {
    return Array.from(this.handlers.values());
  }
}
