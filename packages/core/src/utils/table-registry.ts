type TableEntry = {
  table: string;
  dependsOn?: readonly string[];
};
export function registerTableOrThrow(
  registeredTables: Set<string>,
  table: string,
  duplicateTableError: (table: string) => string
): void {
  if (registeredTables.has(table)) throw new Error(duplicateTableError(table));
  registeredTables.add(table);
}
export function createTableLookup<T extends TableEntry>(
  handlers: readonly T[],
  duplicateTableError: (table: string) => string
): ReadonlyMap<string, T> {
  const byTable = new Map<string, T>();
  for (const handler of handlers) {
    if (byTable.has(handler.table)) {
      throw new Error(duplicateTableError(handler.table));
    }
    byTable.set(handler.table, handler);
  }
  return byTable;
}
export function assertKnownTableDependencies<T extends TableEntry>(
  handlers: readonly T[],
  byTable: ReadonlyMap<string, T>,
  unknownDependencyError: (table: string, dependency: string) => string
): void {
  for (const handler of handlers) {
    for (const dependency of handler.dependsOn ?? []) {
      if (!byTable.has(dependency)) {
        throw new Error(unknownDependencyError(handler.table, dependency));
      }
    }
  }
}
export function topologicallySortTablesByDependencies<T extends TableEntry>(
  byTable: ReadonlyMap<string, T>,
  targetTable?: string
): T[] {
  const visited = new Set<string>();
  const visiting = new Set<string>();
  const sorted: T[] = [];
  const visit = (table: string) => {
    if (visited.has(table)) return;
    if (visiting.has(table)) {
      throw new Error(`Circular dependency detected involving table "${table}"`);
    }
    const handler = byTable.get(table);
    if (!handler) throw new Error(`Unknown table: ${table}`);
    visiting.add(table);
    for (const dependency of handler.dependsOn ?? []) visit(dependency);
    visiting.delete(table);
    visited.add(table);
    sorted.push(handler);
  };
  if (targetTable) {
    visit(targetTable);
  } else {
    for (const table of byTable.keys()) visit(table);
  }
  return sorted;
}
