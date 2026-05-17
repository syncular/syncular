export interface RealtimeChangeScopeEntry<T> {
  item: T;
  scopeKeys: readonly string[];
}

export interface RealtimeChangeScopeIndex<T> {
  selectForScopeKeys(scopeKeys: Iterable<string>): T[];
}

export function createRealtimeChangeScopeIndex<T>(
  entries: readonly RealtimeChangeScopeEntry<T>[]
): RealtimeChangeScopeIndex<T> {
  const items = entries.map((entry) => entry.item);
  const indexesByScopeKey = new Map<string, number[]>();

  for (let index = 0; index < entries.length; index += 1) {
    const seenScopeKeys = new Set<string>();
    for (const scopeKey of entries[index]!.scopeKeys) {
      if (!scopeKey || seenScopeKeys.has(scopeKey)) continue;
      seenScopeKeys.add(scopeKey);
      let indexes = indexesByScopeKey.get(scopeKey);
      if (!indexes) {
        indexes = [];
        indexesByScopeKey.set(scopeKey, indexes);
      }
      indexes.push(index);
    }
  }

  return {
    selectForScopeKeys(scopeKeys: Iterable<string>): T[] {
      const selectedIndexes = new Set<number>();
      for (const scopeKey of scopeKeys) {
        const indexes = indexesByScopeKey.get(scopeKey);
        if (!indexes) continue;
        for (const index of indexes) selectedIndexes.add(index);
      }
      if (selectedIndexes.size === 0) return [];
      return Array.from(selectedIndexes)
        .sort((a, b) => a - b)
        .map((index) => items[index]!);
    },
  };
}
