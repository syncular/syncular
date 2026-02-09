import type { SyncCoreDb } from '../schema';
import type { ServerTableHandler } from './types';

export class TableRegistry<DB extends SyncCoreDb = SyncCoreDb> {
  private tables = new Map<string, ServerTableHandler<DB>>();

  register(handler: ServerTableHandler<DB>): this {
    if (this.tables.has(handler.table)) {
      throw new Error(`Table "${handler.table}" is already registered`);
    }

    // Validate dependencies exist
    for (const dep of handler.dependsOn ?? []) {
      if (!this.tables.has(dep)) {
        throw new Error(
          `Table "${handler.table}" depends on unknown table "${dep}"`
        );
      }
    }

    this.tables.set(handler.table, handler);
    return this;
  }

  get(table: string): ServerTableHandler<DB> | undefined {
    return this.tables.get(table);
  }

  getOrThrow(table: string): ServerTableHandler<DB> {
    const handler = this.tables.get(table);
    if (!handler) throw new Error(`Unknown table: ${table}`);
    return handler;
  }

  getAll(): ServerTableHandler<DB>[] {
    return Array.from(this.tables.values());
  }

  /**
   * Return tables in topological order (parents before children).
   * Throws if a circular dependency is detected.
   */
  getBootstrapOrder(): ServerTableHandler<DB>[] {
    const visited = new Set<string>();
    const sorted: ServerTableHandler<DB>[] = [];
    const visiting = new Set<string>();

    const visit = (table: string) => {
      if (visited.has(table)) return;
      if (visiting.has(table)) {
        throw new Error(
          `Circular dependency detected involving table "${table}"`
        );
      }

      visiting.add(table);
      const handler = this.tables.get(table);
      if (handler) {
        for (const dep of handler.dependsOn ?? []) {
          visit(dep);
        }
        visited.add(table);
        visiting.delete(table);
        sorted.push(handler);
      }
    };

    for (const table of this.tables.keys()) {
      visit(table);
    }

    return sorted;
  }

  /**
   * Return bootstrap order for a target table and its dependencies.
   * Parents are returned before children.
   */
  getBootstrapOrderFor(table: string): ServerTableHandler<DB>[] {
    const visited = new Set<string>();
    const sorted: ServerTableHandler<DB>[] = [];
    const visiting = new Set<string>();

    const visit = (name: string) => {
      if (visited.has(name)) return;
      if (visiting.has(name)) {
        throw new Error(
          `Circular dependency detected involving table "${name}"`
        );
      }

      const handler = this.tables.get(name);
      if (!handler) {
        throw new Error(`Unknown table: ${name}`);
      }

      visiting.add(name);
      for (const dep of handler.dependsOn ?? []) {
        visit(dep);
      }
      visiting.delete(name);
      visited.add(name);
      sorted.push(handler);
    };

    visit(table);
    return sorted;
  }
}
