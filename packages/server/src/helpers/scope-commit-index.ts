import type { ScopeValues, StoredScopes } from '@syncular/core';

export interface ScopeCommitIndexChange {
  table: string;
  scopes: ScopeValues | StoredScopes;
}

export interface ScopeCommitIndexEntry {
  table: string;
  scopeKey: string;
}

export function scopeKeysFromScopeValues(
  scopes: ScopeValues | StoredScopes | null | undefined
): string[] {
  if (!scopes || typeof scopes !== 'object') return [];
  const keys = new Set<string>();

  for (const [key, rawValue] of Object.entries(scopes)) {
    const prefix = key.replace(/_id$/, '');
    const values = Array.isArray(rawValue) ? rawValue : [rawValue];
    for (const value of values) {
      if (typeof value === 'string') {
        if (value.length > 0) keys.add(`${prefix}:${value}`);
        continue;
      }
      if (typeof value === 'number' || typeof value === 'bigint') {
        keys.add(`${prefix}:${String(value)}`);
      }
    }
  }

  return Array.from(keys);
}

export function createScopeCommitIndexEntries(
  changes: readonly ScopeCommitIndexChange[]
): ScopeCommitIndexEntry[] {
  const entries = new Map<string, ScopeCommitIndexEntry>();

  for (const change of changes) {
    if (!change.table) continue;
    for (const scopeKey of scopeKeysFromScopeValues(change.scopes)) {
      const key = `${change.table}\u0000${scopeKey}`;
      if (!entries.has(key)) {
        entries.set(key, { table: change.table, scopeKey });
      }
    }
  }

  return Array.from(entries.values());
}
